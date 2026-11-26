import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadStep } from './importers.js';
import { MATERIALS, CATEGORIES, cloneMaterial } from './materials.js';
import { CONTACT_TYPES, DEFAULT_MU, MU_PRESETS } from './fea/contact.js';
import { serializeProject, parseProject, safeFileName, saveBlob, PROJECT_EXT, hasSavePicker, saveWithPicker } from './project.js';
import { colormap, colormapCss, drawStressStrain, drawCurve, fmt } from './plots.js';
import { initInsertion, draw as drawInsertion, getInsertionState, setInsertionState, insertionReportData } from './insertion-ui.js';

const $ = (id) => document.getElementById(id);
const BC_LABEL = { fixed: '固定約束', force: '力', pressure: '壓力' };
const BC_COLOR = { fixed: new THREE.Color('#2f7bff'), force: new THREE.Color('#ff5a4f'), pressure: new THREE.Color('#ff8a3d') };
const MESH_NAME = { hex20: 'HEX20 貼體六面體（二次）', hex8: 'HEX8 貼體六面體', tet: 'TET10 四面體', voxel: 'HEX8 體素', tet10: 'TET10 四面體' };
const RES_LABEL = { vm: 'von Mises 應力 [MPa]', umag: '總位移 [mm]', ux: '位移 Ux [mm]', uy: '位移 Uy [mm]', uz: '位移 Uz [mm]', pe: '等效塑性應變 PEEQ' };

const state = {
  files: [], // { name, bytes }
  parts: [],
  bcs: [],
  activeBcId: null,
  selectedPartId: null,
  mesh: null, // worker 回傳的網格摘要（顯示用）
  results: null,
  step: 0,
  mode: 'model',
  resultType: 'vm',
  secAxis: 0,
  matCat: 'all',
  contacts: {}, // 'idA-idB' → 結合方式
  contactMu: {}, // 'idA-idB' → 摩擦係數
  anim: { playing: false, t0: 0, lastStepT: 0 },
  showDeform: true,
  deformScale: 1,
};
let bcSeq = 0;
const viewer = new Viewer($('canvasHost'));
viewer.setColormap(colormap, 12);

// ---------- Worker ----------
class FeaClient {
  constructor() { this.w = null; this.seq = 0; this.pending = new Map(); }
  ensure() {
    if (this.w) return this.w;
    this.w = new Worker(new URL('./fea.worker.js', import.meta.url), { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data, p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') return p.onProgress?.(m);
      this.pending.delete(m.id);
      if (m.type === 'done') p.resolve(m.result); else p.reject(new Error(m.message));
    };
    this.w.onerror = (e) => { this.reset(new Error(e.message || '運算 Worker 發生錯誤')); };
    return this.w;
  }
  call(cmd, data, onProgress) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.ensure().postMessage({ id, cmd, data });
    });
  }
  reset(err) {
    this.w?.terminate();
    this.w = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    clearMesh();
  }
}
const fea = new FeaClient();

// ---------- 幾何工具 ----------
function facesOf(part) {
  if (!part._faceTris) {
    const arr = Array.from({ length: part.faceCount }, () => []);
    part.faceOfTri.forEach((f, t) => arr[f].push(t));
    part._faceTris = arr;
  }
  return part._faceTris;
}
function faceSoup(part, faceId) {
  const tris = facesOf(part)[faceId];
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => out.set(part.basePositions.subarray(t * 9, t * 9 + 9), i * 9));
  return out;
}
function faceInfo(soup) {
  const c = new THREE.Vector3(), n = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < soup.length; i += 9) {
    a.fromArray(soup, i); b.fromArray(soup, i + 3); d.fromArray(soup, i + 6);
    const cr = b.clone().sub(a).cross(d.clone().sub(a));
    const A = cr.length() / 2;
    area += A;
    n.add(cr.multiplyScalar(0.5));
    c.add(a.add(b).add(d).multiplyScalar(A / 3));
  }
  if (area > 0) c.divideScalar(area);
  return { centroid: c, normal: n.normalize(), area };
}
const partById = (id) => state.parts.find((p) => p.id === id);
const partIndex = (id) => state.parts.findIndex((p) => p.id === id);
const modelSize = () => { const b = viewer.bounds(); return b.isEmpty() ? 100 : b.getSize(new THREE.Vector3()).length(); };
const hasResults = () => state.results && !state.results.stale;
/** 結果使用的節點／元素（接觸設定可能拆開介面節點） */
const RV = () => state.results.view;
const vnOf = (rm) => (hasResults() ? RV().vn.get(rm.partId) : rm.vertexNode);
const curStep = () => state.results.steps[state.step];

// ---------- 模型管理 ----------
function addFile(name, bytes, parts) {
  const fileIdx = state.files.push({ name, bytes }) - 1;
  for (const p of parts) {
    p.fileIdx = fileIdx;
    p.material ??= cloneMaterial('steel');
    p.visible ??= true;
    state.parts.push(p);
  }
  clearMesh();
  viewer.setParts(state.parts);
  if (!state.selectedPartId && state.parts.length) state.selectedPartId = state.parts[0].id;
  renderAll();
  viewer.fit(new THREE.Vector3(1, -1.2, 0.9));
}

function clearAll() {
  fea.reset(new Error('已清除'));
  Object.assign(state, { files: [], parts: [], bcs: [], activeBcId: null, selectedPartId: null, results: null, contacts: {}, contactMu: {} });
  viewer.setParts([]);
  setMode('model');
  renderAll();
}

function removePart(id) {
  state.parts = state.parts.filter((p) => p.id !== id);
  for (const bc of state.bcs) bc.faces = new Set([...bc.faces].filter((k) => !k.startsWith(`${id}:`)));
  if (state.selectedPartId === id) state.selectedPartId = state.parts[0]?.id ?? null;
  clearMesh();
  viewer.setParts(state.parts);
  renderAll();
}

function clearMesh() {
  if (state.mesh) log('零件已變更，網格需要重新產生', 'w');
  state.mesh = null;
  invalidateResults(true);
  viewer.clearResultMeshes();
  viewer.setWire(null);
  renderMeshInfo();
}

function invalidateResults(silent) {
  if (hasResults()) {
    state.results.stale = true;
    if (!silent) log('模型或設定已變更，請重新執行模擬', 'w');
    setMode('model');
    renderResults();
  }
}

// ---------- 上色 / 顯示 ----------
function valueAt(n) {
  const s = curStep();
  switch (state.resultType) {
    case 'vm': return s.vm[n];
    case 'pe': return s.pe[n];
    case 'umag': return Math.hypot(s.u[3 * n], s.u[3 * n + 1], s.u[3 * n + 2]);
    case 'ux': return s.u[3 * n];
    case 'uy': return s.u[3 * n + 1];
    case 'uz': return s.u[3 * n + 2];
  }
  return 0;
}

function resultRange() {
  const used = state.results.used;
  let lo = Infinity, hi = -Infinity;
  for (let n = 0; n < used.length; n++) {
    if (!used[n]) continue;
    const v = valueAt(n);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) hi = lo + 1e-12;
  return [lo, hi];
}

function repaint() {
  const resultMode = state.mode === 'result' && hasResults();
  viewer.clearOverlay();
  viewer.showResult(resultMode);
  const range = resultMode ? resultRange() : null;
  state.range = range;
  const scale = resultMode && state.showDeform ? state.deformScale : 0;

  if (resultMode) {
    for (const rm of state.mesh.resultMeshes) rm.mesh.visible = !!partById(rm.partId)?.visible;
    updateResultColors(range);
    buildSection(range);
    updateLabels();
    updateDeformation(scale);
  } else {
    for (const p of state.parts) {
      const col = p.geometry.attributes.color;
      const base = new THREE.Color(p.color);
      const faceColor = new Map();
      for (const bc of state.bcs) {
        const c = BC_COLOR[bc.type].clone();
        if (bc.id === state.activeBcId) c.lerp(new THREE.Color('#ffffff'), 0.25);
        for (const key of bc.faces) { const [pid, fid] = key.split(':').map(Number); if (pid === p.id) faceColor.set(fid, c); }
      }
      if (p.id === state.selectedPartId && !state.activeBcId) base.lerp(new THREE.Color('#ffffff'), 0.18);
      for (let t = 0; t < p.faceOfTri.length; t++) {
        const c = faceColor.get(p.faceOfTri[t]) || base;
        for (let k = 0; k < 3; k++) col.setXYZ(3 * t + k, c.r, c.g, c.b);
      }
      col.needsUpdate = true;
      viewer.setPartVisible(p.id, p.visible, 1);
    }
    drawBcGlyphs();
    viewer.setClip(null);
    viewer.setSection(null);
    viewer.setLabels(null);
    state.section = null;
    updateWire(0);
  }
  viewer.setEdgesVisible($('showEdges').checked);
  updateLegend(range);
}

/** 數值 → 色帶貼圖 u 座標（逐像素上色，分段等值線清晰） */
function texU(n, range) {
  if (n < 0 || !state.results.used[n]) return Viewer.texU(-1);
  return Viewer.texU((valueAt(n) - range[0]) / (range[1] - range[0]));
}

function updateResultColors(range) {
  for (const rm of state.mesh.resultMeshes) {
    const uv = rm.mesh.geometry.attributes.uv, vn = vnOf(rm);
    for (let v = 0; v < vn.length; v++) uv.setX(v, texU(vn[v], range));
    uv.needsUpdate = true;
  }
}

/** 依變形倍率更新所有結果幾何（動畫每格呼叫） */
function updateDeformation(scale) {
  const s = curStep(), u = s.u, used = state.results.used;
  for (const rm of state.mesh.resultMeshes) {
    if (!rm.mesh.visible) continue;
    const g = rm.mesh.geometry, pos = g.attributes.position, vn = vnOf(rm), P = rm.positions;
    for (let v = 0; v < vn.length; v++) {
      const n = vn[v];
      if (n < 0 || !used[n]) { pos.setXYZ(v, P[3 * v], P[3 * v + 1], P[3 * v + 2]); continue; }
      pos.setXYZ(v, P[3 * v] + scale * u[3 * n], P[3 * v + 1] + scale * u[3 * n + 1], P[3 * v + 2] + scale * u[3 * n + 2]);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }
  const N = RV().nodes;
  const at = (n, d) => N[3 * n + d] + scale * u[3 * n + d];
  // 剖面
  const sec = state.section;
  if (sec && viewer.section) {
    const pos = viewer.section.geometry.attributes.position;
    for (let v = 0; v < sec.pa.length; v++) {
      const a = sec.pa[v], b = sec.pb[v], t = sec.pt[v];
      pos.setXYZ(v, at(a, 0) + t * (at(b, 0) - at(a, 0)), at(a, 1) + t * (at(b, 1) - at(a, 1)), at(a, 2) + t * (at(b, 2) - at(a, 2)));
    }
    pos.needsUpdate = true;
    viewer.section.geometry.computeBoundingSphere();
  }
  // 標籤
  if (state.labelNodes) viewer.moveLabels(state.labelNodes.map((n) => [at(n, 0), at(n, 1), at(n, 2)]));
  updateWire(scale);
}

function updateWire(scale) {
  const m = state.mesh;
  if (!$('showMesh').checked || !m || !m.wireNodes) { viewer.setWire(null); return; }
  const inRes = state.mode === 'result' && hasResults();
  const W = inRes ? RV().wire : m.wireNodes, N = inRes ? RV().nodes : m.nodes;
  const u = scale && hasResults() ? curStep().u : null;
  const out = new Float32Array(W.length * 3);
  for (let i = 0; i < W.length; i++) {
    const n = W[i];
    for (let d = 0; d < 3; d++) out[3 * i + d] = N[3 * n + d] + (u ? scale * u[3 * n + d] : 0);
  }
  viewer.setWire(out);
}

// ---------- 剖面 ----------
const CUT_EDGES = {
  hex: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
  tet: [[0, 1], [1, 2], [0, 2], [0, 3], [2, 3], [1, 3]],
};

function modelBounds() {
  const N = RV().nodes, used = state.results.used;
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let n = 0; n < used.length; n++) if (used[n]) for (let d = 0; d < 3; d++) { b[d] = Math.min(b[d], N[3 * n + d]); b[3 + d] = Math.max(b[3 + d], N[3 * n + d]); }
  return b;
}

function buildSection(range) {
  state.section = null;
  state.clip = null;
  if (!$('secOn').checked) { viewer.setClip(null); viewer.setSection(null); return; }
  const m = { ...state.mesh, nodes: RV().nodes, elems: RV().elems }, N = m.nodes, used = state.results.used;
  const axis = state.secAxis, b = modelBounds();
  // 微小偏移：避免剖面剛好通過節點平面造成剖切面缺漏
  const c = b[axis] + ((b[3 + axis] - b[axis]) * (+$('secPos').value + 1.234e-3)) / 1000;
  // 預設保留離相機較遠的一側，使剖切面朝向觀察者；「反向」可切換
  const camSide = viewer.camera.position.getComponent(axis) < c;
  const flip = camSide !== $('secFlip').checked;
  $('secVal').textContent = `${'XYZ'[axis]} = ${fmt(c, 4)} mm`;
  const normal = [0, 0, 0];
  normal[axis] = flip ? 1 : -1;
  viewer.setClip({ normal, constant: flip ? -c : c });
  state.clip = { axis, c, keepGreater: flip };

  const nen = m.elems.length / m.elemPart.length;
  const isTet = m.type === 'tet10';
  const nc = isTet ? 4 : 8, edges = CUT_EDGES[isTet ? 'tet' : 'hex'];
  const visible = state.parts.map((p) => p.visible);
  const pa = [], pb = [], pt = [];
  const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
  const dist = new Float64Array(8);
  for (let e = 0; e < m.elemPart.length; e++) {
    if (!visible[m.elemPart[e]]) continue;
    const o = e * nen;
    if (!used[m.elems[o]]) continue;
    let pos = 0, neg = 0;
    for (let k = 0; k < nc; k++) { dist[k] = N[3 * m.elems[o + k] + axis] - c; if (dist[k] > 0) pos++; else neg++; }
    if (!pos || !neg) continue;
    const pts = [];
    for (const [i, j] of edges) {
      if ((dist[i] > 0) === (dist[j] > 0)) continue;
      const t = dist[i] / (dist[i] - dist[j]);
      const na = m.elems[o + i], nb = m.elems[o + j];
      pts.push({ na, nb, t, x: N[3 * na + a1] + t * (N[3 * nb + a1] - N[3 * na + a1]), y: N[3 * na + a2] + t * (N[3 * nb + a2] - N[3 * na + a2]) });
    }
    if (pts.length < 3) continue;
    const cx = pts.reduce((s2, p) => s2 + p.x, 0) / pts.length, cy = pts.reduce((s2, p) => s2 + p.y, 0) / pts.length;
    pts.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
    for (let k = 1; k + 1 < pts.length; k++)
      for (const p of [pts[0], pts[k], pts[k + 1]]) { pa.push(p.na); pb.push(p.nb); pt.push(p.t); }
  }
  const sec = { pa: Int32Array.from(pa), pb: Int32Array.from(pb), pt: Float32Array.from(pt) };
  const uv = new Float32Array(sec.pa.length * 2);
  for (let v = 0; v < sec.pa.length; v++) {
    const va = valueAt(sec.pa[v]), vb = valueAt(sec.pb[v]);
    uv[2 * v] = Viewer.texU((va + sec.pt[v] * (vb - va) - range[0]) / (range[1] - range[0]));
    uv[2 * v + 1] = 0.5;
  }
  state.section = sec;
  viewer.setSection(new Float32Array(sec.pa.length * 3), uv);
}

// ---------- 最大／最小標示 ----------
function updateLabels() {
  state.labelNodes = null;
  if (!$('showMinMax').checked) { viewer.setLabels(null); return; }
  const used = state.results.used;
  let nMax = -1, nMin = -1, vMax = -Infinity, vMin = Infinity;
  for (const rm of state.mesh.resultMeshes) {
    if (!rm.mesh.visible) continue;
    for (const n of vnOf(rm)) {
      if (n < 0 || !used[n]) continue;
      if (state.clip) { const x = RV().nodes[3 * n + state.clip.axis]; if (state.clip.keepGreater ? x < state.clip.c : x > state.clip.c) continue; }
      const v = valueAt(n);
      if (v > vMax) { vMax = v; nMax = n; }
      if (v < vMin) { vMin = v; nMin = n; }
    }
  }
  if (nMax < 0) { viewer.setLabels(null); return; }
  const unit = { vm: ' MPa', pe: '', umag: ' mm', ux: ' mm', uy: ' mm', uz: ' mm' }[state.resultType];
  const N = RV().nodes, P = (n) => [N[3 * n], N[3 * n + 1], N[3 * n + 2]];
  viewer.setLabels([
    { pos: P(nMax), text: `MAX ${fmt(vMax, 4)}${unit}`, color: '#ff4d4d' },
    { pos: P(nMin), text: `MIN ${fmt(vMin, 4)}${unit}`, color: '#3d7bff' },
  ]);
  state.labelNodes = [nMax, nMax, nMin, nMin]; // sprite 與圓點各一
}

function drawBcGlyphs() {
  const L = modelSize() * 0.08;
  for (const bc of state.bcs)
    for (const key of bc.faces) {
      const [pid, fid] = key.split(':').map(Number);
      const part = partById(pid);
      if (!part || !part.visible) continue;
      const { centroid, normal } = faceInfo(faceSoup(part, fid));
      if (bc.type === 'fixed') viewer.addFixMarker(centroid.clone().add(normal.clone().multiplyScalar(L * 0.25)), L * 0.35);
      else if (bc.type === 'pressure') viewer.addArrow(centroid, normal.clone().negate().multiplyScalar(Math.sign(bc.p) || 1), L, 0xff8a3d);
      else { const v = new THREE.Vector3(...bc.vector); if (v.lengthSq() > 0) viewer.addArrow(centroid, v, L, 0xff5a4f); }
    }
}

function updateLegend(range) {
  $('legend').hidden = !range;
  if (!range) return;
  $('legendTitle').textContent = RES_LABEL[state.resultType] + (state.results.steps.length > 1 ? `｜λ=${fmt(curStep().lambda)}` : '');
  $('legendBar').style.background = colormapCss(12, +$('bands').value);
  const ticks = [];
  for (let i = 0; i <= 10; i++) ticks.push(`<div>${fmt(range[1] - ((range[1] - range[0]) * i) / 10)}</div>`);
  $('legendTicks').innerHTML = ticks.join('');
}

// ---------- 左側面板 ----------
function renderParts() {
  $('partCount').textContent = state.parts.length ? `(${state.parts.length})` : '';
  const list = $('partList');
  if (!state.parts.length) { list.innerHTML = '<div class="empty">尚未載入模型。請匯入 STEP 檔或載入示範組合件。</div>'; return; }
  list.innerHTML = '';
  for (const p of state.parts) {
    const el = document.createElement('div');
    el.className = 'item' + (p.id === state.selectedPartId ? ' sel' : '');
    const ne = state.mesh?.partElems?.[partIndex(p.id)];
    el.innerHTML = `<input type="checkbox" ${p.visible ? 'checked' : ''} title="顯示/隱藏">
      <span class="sw" style="background:${p.color}"></span>
      <span class="name"></span>
      ${p.material.cat ? `<span class="tag ${p.material.cat}">${CATEGORIES[p.material.cat]}</span>` : ''}
      <span class="meta">${p.material.name}${ne !== undefined ? `・${ne.toLocaleString()} 元素` : ''}</span>
      <button class="x" title="移除零件">✕</button>`;
    el.querySelector('.name').textContent = p.name;
    el.querySelector('.name').title = p.name;
    el.querySelector('input').onclick = (e) => { e.stopPropagation(); p.visible = e.target.checked; repaint(); };
    el.querySelector('.x').onclick = (e) => { e.stopPropagation(); removePart(p.id); };
    el.onclick = () => { state.selectedPartId = p.id; state.activeBcId = null; renderAll(); };
    list.appendChild(el);
  }
}

function renderMaterial() {
  const p = partById(state.selectedPartId);
  $('matSection').hidden = !p;
  if (!p) return;
  const m = p.material;
  $('matPartName').textContent = `— ${p.name}`;
  buildMatOptions(m);
  $('matRho').value = m.rho ?? '';
  const mass = (p.volume * (m.rho || 0)) / 1e9; // mm³ × kg/m³ → kg
  $('matMass').textContent = m.rho ? (mass >= 1 ? `${fmt(mass, 4)} kg` : `${fmt(mass * 1000, 4)} g`) : '—';
  const notes = [];
  if (m.brittle) notes.push('脆性材料：破壞前幾乎無塑性變形，建議以最大主應力判斷，彈塑性結果僅供參考。');
  if (m.cat === 'plastic') notes.push('塑膠：數值為室溫、短時間負載的典型值，未考慮潛變、溫度與吸濕（尼龍）影響。');
  $('matNote').hidden = !notes.length;
  $('matNote').textContent = notes.join(' ');
  $('matE').value = +(m.E / 1000).toPrecision(5);
  $('matNu').value = m.nu;
  $('matSy').value = m.sy;
  $('matSu').value = m.su;
  let mark = null;
  if (hasResults()) {
    const i = partIndex(p.id), s = curStep();
    mark = { stress: s.partMaxVM[i], peeq: s.partMaxPE[i] };
  }
  drawStressStrain($('ssChart'), m, mark);
}

function bcDesc(bc) {
  if (bc.type === 'force') return `${fmt(Math.hypot(...bc.vector))} N`;
  if (bc.type === 'pressure') return `${fmt(bc.p)} MPa`;
  const d = bc.dirs || [true, true, true];
  return d.every(Boolean) ? '全固定' : ['X', 'Y', 'Z'].filter((_, i) => d[i]).join('') + ' 固定';
}

function renderBcs() {
  const list = $('bcList');
  list.innerHTML = state.bcs.length ? '' : '<div class="empty">點「＋」新增，再到右側 3D 視窗點選面。</div>';
  for (const bc of state.bcs) {
    const el = document.createElement('div');
    el.className = 'item' + (bc.id === state.activeBcId ? ' sel' : '');
    el.innerHTML = `<span class="tag ${bc.type}">${BC_LABEL[bc.type]}</span>
      <span class="name"></span><span class="meta">${bc.faces.size} 面・${bcDesc(bc)}</span>
      <button class="x" title="刪除">✕</button>`;
    el.querySelector('.name').textContent = bc.name;
    el.onclick = () => { state.activeBcId = state.activeBcId === bc.id ? null : bc.id; setMode('model'); renderAll(); };
    el.querySelector('.x').onclick = (e) => {
      e.stopPropagation();
      state.bcs = state.bcs.filter((b) => b !== bc);
      if (state.activeBcId === bc.id) state.activeBcId = null;
      invalidateResults(); renderAll();
    };
    list.appendChild(el);
  }
  renderBcEditor();
}

function renderBcEditor() {
  const ed = $('bcEditor');
  const bc = state.bcs.find((b) => b.id === state.activeBcId);
  ed.hidden = !bc;
  $('pickHint').hidden = !bc;
  if (!bc) return;
  $('pickHint').textContent = `選取「${bc.name}」的面：點擊面加入／再點一次移除（Esc 結束）`;
  let html = `<div class="grid2"><label class="full">名稱<input type="text" id="bcName"></label></div>`;
  if (bc.type === 'force') {
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">總力向量 Fx, Fy, Fz [N]（依面積分配到所選面）</div>
      <div class="row3"><input type="number" step="any" id="fx" value="${bc.vector[0]}"><input type="number" step="any" id="fy" value="${bc.vector[1]}"><input type="number" step="any" id="fz" value="${bc.vector[2]}"></div>
      <div class="btn-row" style="margin-top:6px"><button class="btn sm" id="alongN">設為沿面法向（壓入）</button>
      <label class="check" style="font-size:11px">大小 <input type="number" step="any" id="fmag" value="${fmt(Math.hypot(...bc.vector)) || 1000}" style="width:80px"> N</label></div>`;
  } else if (bc.type === 'pressure') {
    html += `<div class="grid2" style="margin-top:8px"><label class="full">壓力 [MPa]（正值 = 壓入表面）<input type="number" step="any" id="pval" value="${bc.p}"></label></div>`;
  } else {
    const d = bc.dirs || [true, true, true];
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">拘束方向（只勾部分方向可做對稱面／滑動支承）</div>
      <div class="dirs">${['X', 'Y', 'Z'].map((a, i) => `<label><input type="checkbox" data-dir="${i}" ${d[i] ? 'checked' : ''}> U${a.toLowerCase()} = 0</label>`).join('')}</div>`;
  }
  html += `<div class="hint">● 已選 ${bc.faces.size} 個面</div>`;
  ed.innerHTML = html;
  $('bcName').value = bc.name;
  $('bcName').oninput = (e) => { bc.name = e.target.value; refreshBcMeta(); };
  if (bc.type === 'force') {
    ['fx', 'fy', 'fz'].forEach((id, i) => ($(id).oninput = (e) => { bc.vector[i] = +e.target.value || 0; changedBc(); }));
    $('alongN').onclick = () => {
      const n = new THREE.Vector3();
      for (const key of bc.faces) { const [pid, fid] = key.split(':').map(Number); const fi = faceInfo(faceSoup(partById(pid), fid)); n.add(fi.normal.multiplyScalar(fi.area)); }
      if (n.lengthSq() === 0) return alert('請先選取面');
      n.normalize().multiplyScalar(-(+$('fmag').value || 1000));
      bc.vector = [n.x, n.y, n.z].map((v) => +v.toPrecision(6));
      renderBcs(); changedBc();
    };
  }
  if (bc.type === 'pressure') $('pval').oninput = (e) => { bc.p = +e.target.value || 0; changedBc(); };
  for (const cb of ed.querySelectorAll('[data-dir]'))
    cb.onchange = () => { bc.dirs = [0, 1, 2].map((i) => ed.querySelector(`[data-dir="${i}"]`).checked); changedBc(); };
}

function refreshBcMeta() {
  const items = $('bcList').querySelectorAll('.item');
  state.bcs.forEach((bc, i) => {
    if (!items[i]) return;
    items[i].querySelector('.name').textContent = bc.name;
    items[i].querySelector('.meta').textContent = `${bc.faces.size} 面・${bcDesc(bc)}`;
  });
}
function changedBc() { invalidateResults(); refreshBcMeta(); repaint(); }

function renderMeshInfo() {
  const m = state.mesh;
  $('meshSize').placeholder = `自動 ≈ ${fmt(autoMeshSize(), 2)}`;
  if (!m) { $('meshInfo').textContent = state.parts.length ? '尚未產生網格（執行模擬時會自動產生）' : '尚未產生網格'; return; }
  $('meshInfo').innerHTML = `<b>${MESH_NAME[m.type]}</b>・元素 <b>${m.elemCount.toLocaleString()}</b>・節點 <b>${m.nodeCount.toLocaleString()}</b>・尺寸 ${fmt(m.size)} mm・${m.seconds.toFixed(1)} s`;
}

function renderResults() {
  const r = state.results;
  const show = hasResults();
  $('resSection').hidden = !show;
  $('modeSeg').querySelector('[data-mode=result]').disabled = !show;
  if (!show) return;
  const s = curStep();
  const multi = r.steps.length > 1;
  $('stepRow').hidden = !multi;
  $('stepSlider').max = r.steps.length - 1;
  $('stepSlider').value = state.step;
  $('stepVal').textContent = `${state.step + 1} / ${r.steps.length}（λ = ${fmt(s.lambda)}）`;
  $('deformScale').value = fmt(state.deformScale);
  const plastic = r.stats.plastic;
  let html = `<tr><th>零件</th><th class="num">最大 σvm</th><th class="num">最大位移</th><th class="num">${plastic ? '最大 PEEQ' : '安全係數'}</th></tr>`;
  r.partElems.forEach((ne, i) => {
    const p = state.parts[i];
    if (!ne) { html += `<tr><td>${p.name}</td><td colspan="3" class="num" style="color:var(--text-dim)">未計算</td></tr>`; return; }
    const vm = s.partMaxVM[i];
    let last;
    if (plastic) {
      const pe = s.partMaxPE[i];
      last = `<td class="num ${pe > 0 ? (pe > 0.02 ? 'sf-bad' : 'sf-mid') : 'sf-ok'}">${pe > 0 ? pe.toExponential(2) : '0（彈性）'}</td>`;
    } else {
      const sf = p.material.sy / vm;
      last = `<td class="num ${sf < 1 ? 'sf-bad' : sf < 1.5 ? 'sf-mid' : 'sf-ok'}">${sf > 1e4 ? '>9999' : fmt(sf, 3)}</td>`;
    }
    html += `<tr><td>${p.name}</td><td class="num">${fmt(vm)} MPa</td><td class="num">${fmt(s.partMaxU[i])} mm</td>${last}</tr>`;
  });
  const st = r.stats;
  html += `<tr><td colspan="4" style="color:var(--text-dim);font-size:11px;padding-top:8px">
    ${st.type.toUpperCase()}・元素 ${st.elements.toLocaleString()}・自由度 ${st.dofs.toLocaleString()}<br>
    ${plastic ? `負載步 ${r.steps.length}・Newton ${st.newton} 次・` : ''}PCG ${st.cg.toLocaleString()} 次・${st.seconds.toFixed(1)} s<br>
    總負載 (${r.totalLoad.map((v) => fmt(v)).join(', ')}) N${r.contact ? `<br>介面節點閉合 ${r.contact.closed}/${r.contact.springs}${r.contact.sliding ? `（其中滑動 ${r.contact.sliding}）` : ''}・最大穿透 ${fmt(r.contact.maxPen)} mm` : ''}</td></tr>`;
  $('statsTable').innerHTML = html;

  // 負載-位移曲線
  const F = Math.hypot(...r.totalLoad);
  const pts = [[0, 0], ...r.steps.map((x) => [x.maxU, x.lambda * F])];
  $('ldChart').hidden = !multi;
  if (multi) drawCurve($('ldChart'), pts, state.step + 1, '最大位移 [mm]', '負載 [N]', '負載-位移曲線');
}

function renderAll() {
  const plasticUI = $('anaType').value === 'plastic';
  document.body.classList.toggle('plastic', plasticUI);
  $('animType').querySelector('[value=steps]').disabled = !(hasResults() && state.results.steps.length > 1);
  if ($('animType').querySelector('[value=steps]').disabled && $('animType').value === 'steps') $('animType').value = 'deform';
  const peOpt = $('resType').querySelector('[value=pe]');
  peOpt.disabled = !(hasResults() && state.results.stats.plastic);
  if (peOpt.disabled && state.resultType === 'pe') { state.resultType = 'vm'; $('resType').value = 'vm'; }
  renderParts();
  renderMaterial();
  renderBcs();
  renderMeshInfo();
  renderContacts();
  renderResults();
  repaint();
}

function setMode(mode) {
  if (mode === 'result' && !hasResults()) mode = 'model';
  if (mode !== 'result' && state.anim?.playing) { state.anim.playing = false; $('btnPlay').textContent = '▶ 播放'; }
  state.mode = mode;
  if (mode === 'result') state.activeBcId = null;
  for (const b of $('modeSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
}

function log(msg, cls = '') {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  $('log').prepend(d);
  while ($('log').children.length > 10) $('log').lastChild.remove();
}

// ---------- 3D 互動 ----------
viewer.onPick = (hit) => {
  if (!hit || hit.result) return;
  const bc = state.bcs.find((b) => b.id === state.activeBcId);
  const part = partById(hit.partId);
  const fid = part.faceOfTri[hit.tri];
  if (bc) {
    const key = `${part.id}:${fid}`;
    if (bc.faces.has(key)) bc.faces.delete(key); else bc.faces.add(key);
    invalidateResults();
    renderBcs();
    repaint();
    return;
  }
  state.selectedPartId = part.id;
  renderAll();
};

viewer.onHover = (hit) => {
  if (!hit) { viewer.setHover(null); $('status').textContent = '就緒'; return; }
  const part = partById(hit.partId);
  const p = hit.point;
  let txt = `${part.name}・(${fmt(p.x, 4)}, ${fmt(p.y, 4)}, ${fmt(p.z, 4)}) mm`;
  if (!hit.result) {
    const fid = part.faceOfTri[hit.tri];
    txt = `${part.name}・面 #${fid + 1}・` + txt.slice(part.name.length + 1);
    viewer.setHover(state.activeBcId ? faceSoup(part, fid) : null);
  } else {
    viewer.setHover(null);
    const rm = state.mesh.resultMeshes.find((r) => r.partId === part.id);
    const n = vnOf(rm)[hit.face.a];
    if (n >= 0 && state.results.used[n]) txt += `｜${RES_LABEL[state.resultType]}：${fmt(valueAt(n), 4)}`;
  }
  $('status').textContent = txt;
};

window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.activeBcId) { state.activeBcId = null; renderAll(); } });

// ---------- 網格 ----------
function autoMeshSize() {
  const b = viewer.bounds();
  if (b.isEmpty()) return 5;
  const s = b.getSize(new THREE.Vector3());
  const m = $('meshMethod').value;
  return m === 'hex8' ? s.length() / 60 : s.length() / 30;
}

function showProgress(on) {
  $('progress').hidden = !on;
  $('btnRun').disabled = on;
  $('btnMesh').disabled = on;
  $('btnCancel').hidden = !on;
}
function onProgress(m) {
  $('progress').querySelector('.bar').style.width = `${Math.round((m.frac || 0) * 100)}%`;
  $('progress').querySelector('.txt').textContent = m.iter ? `${m.stage}・CG ${m.iter}・殘差 ${m.residual.toExponential(1)}` : m.stage;
}

async function generateMesh() {
  if (!state.parts.length) throw new Error('請先載入模型');
  const method = $('meshMethod').value;
  const size = +$('meshSize').value || autoMeshSize();
  const data = {
    method, size,
    parts: state.parts.map((p) => ({ name: p.name, bbox: p.bbox, positions: p.basePositions, faceOfTri: p.faceOfTri })),
  };
  log(`產生網格（${MESH_NAME[method]}，尺寸 ${fmt(size)} mm）…`);
  const res = await fea.call('mesh', data, onProgress);
  const wire = [];
  res.display.forEach((d) => { if (d.wire) for (const n of d.wire) wire.push(n); });
  const resultMeshes = res.display.map((d, i) => ({ ...d, partId: state.parts[i].id }));
  viewer.setResultMeshes(resultMeshes);
  state.mesh = { ...res, size, resultMeshes, wireNodes: wire.length ? Int32Array.from(wire) : null, wireParts: res.display.map((d) => d.wire) };
  state.results = null;
  for (const w of res.warnings) log(w, 'w');
  log(`網格完成：${res.elemCount.toLocaleString()} 元素、${res.nodeCount.toLocaleString()} 節點（${res.seconds.toFixed(1)} s）`);
  if (!$('showMesh').checked) $('showMesh').checked = true;
  if (res.quality !== undefined) log(`網格品質：最小縮放 Jacobian ${res.quality.toFixed(2)}（1 = 理想立方體）`);
}

async function meshOnly() {
  showProgress(true);
  try { await generateMesh(); setMode('model'); }
  catch (e) { if (e.message !== '已取消') { log(`錯誤：${e.message}`, 'e'); console.error(e); } }
  finally { showProgress(false); renderAll(); }
}

// ---------- 求解 ----------
async function runSimulation() {
  if (!state.parts.length) return alert('請先載入模型');
  if (!state.bcs.some((b) => b.type === 'fixed' && b.faces.size)) return alert('請至少設定一個「固定約束」並選取面');
  if (!state.bcs.some((b) => b.type !== 'fixed' && b.faces.size)) return alert('請至少設定一個「力」或「壓力」負載並選取面');
  showProgress(true);
  try {
    if (!state.mesh) await generateMesh();
    const bcs = state.bcs.filter((b) => b.faces.size).map((b) => ({
      name: b.name, type: b.type, dirs: b.dirs, vector: b.vector, p: b.p,
      faces: [...b.faces].map((k) => { const [pid, fid] = k.split(':').map(Number); return { part: partIndex(pid), faceId: fid, soup: faceSoup(partById(pid), fid) }; }),
    }));
    const plastic = $('anaType').value === 'plastic';
    const setup = {
      materials: state.parts.map((p) => ({ ...p.material, name: p.name })),
      plastic, steps: +$('nSteps').value || 10, loadFactor: +$('loadFactor').value || 1, tol: +$('tol').value,
    };
    const contacts = {};
    for (const I of state.mesh.interfaces || []) contacts[`${I.a}-${I.b}`] = { type: contactType(I), mu: contactMu(I) };
    const nl = Object.values(contacts).filter((c) => c.type !== 'bonded').length;
    log(`開始求解（${plastic ? '彈塑性' : '線彈性'}${nl ? `，${nl} 組非黏合介面` : ''}）…`);
    const r = await fea.call('solve', { bcs, setup, contacts }, onProgress);
    state.results = { ...r, stale: false, view: buildResultView(r) };
    state.step = r.steps.length - 1;
    const last = curStep();
    state.deformScale = last.maxU > 0 ? +((modelSize() * 0.05) / last.maxU).toPrecision(2) : 1;
    if (plastic) state.deformScale = Math.max(1, Math.min(state.deformScale, 1000));
    $('deformScale').value = state.deformScale;
    for (const w of r.warnings) log(w, 'w');
    log(`完成：${r.stats.seconds.toFixed(1)} s，最大 σvm ${fmt(last.maxVM)} MPa，最大位移 ${fmt(last.maxU)} mm${plastic ? `，最大 PEEQ ${last.maxPE.toExponential(2)}` : ''}`);
    setMode('result');
  } catch (e) {
    if (e.message !== '已取消') { log(`錯誤：${e.message}`, 'e'); console.error(e); }
  } finally {
    showProgress(false);
    renderAll();
  }
}

/** 依求解回傳的節點拆分資訊，建立結果顯示用的節點／元素／頂點對照 */
function buildResultView(r) {
  const m = state.mesh;
  const sp = r.split;
  const vn = new Map(), wire = [];
  m.resultMeshes.forEach((rm, i) => {
    let map = null;
    if (sp && sp.copies[i] && sp.copies[i][0].length) { map = new Map(); sp.copies[i][0].forEach((n, k) => map.set(n, sp.copies[i][1][k])); }
    vn.set(rm.partId, map ? rm.vertexNode.map((n) => (n >= 0 ? map.get(n) ?? n : n)) : rm.vertexNode);
    for (const n of m.wireParts?.[i] || []) wire.push(map ? map.get(n) ?? n : n);
  });
  return { nodes: sp ? sp.nodes : m.nodes, elems: sp ? sp.elems : m.elems, vn, wire: Int32Array.from(wire) };
}

// ---------- 零件結合 ----------
const pairKey = (I) => { const a = state.parts[I.a]?.id, b = state.parts[I.b]?.id; return `${Math.min(a, b)}-${Math.max(a, b)}`; };
const contactType = (I) => state.contacts[pairKey(I)] || 'bonded';
const contactMu = (I) => state.contactMu[pairKey(I)] ?? DEFAULT_MU;
const contactLabel = (I) => CONTACT_TYPES[contactType(I)] + (contactType(I) === 'frictional' ? `，μ = ${contactMu(I)}` : '');
// 常見材料組合的靜摩擦係數（典型值，實際依表面處理、潤滑而異）

function renderContacts() {
  const box = $('contactBox');
  const list = state.mesh?.interfaces;
  if (!list) { box.className = 'empty'; box.textContent = state.parts.length > 1 ? '產生網格後會自動偵測互相接觸的零件。' : '單一零件，無需設定。'; return; }
  if (!list.length) { box.className = 'empty'; box.textContent = '未偵測到互相接觸的零件（零件間沒有共用面）。'; return; }
  box.className = '';
  const opts = (sel) => Object.entries(CONTACT_TYPES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  const presets = `<option value="">參考值…</option>` + MU_PRESETS.map(([n, v]) => `<option value="${v}">${n}：${v}</option>`).join('');
  let html = `<div class="contact-all">全部設為<select id="contactAll"><option value="">—</option>${opts('')}</select></div>`;
  list.forEach((I, i) => {
    const a = state.parts[I.a]?.name, b = state.parts[I.b]?.name;
    const fr = contactType(I) === 'frictional';
    html += `<div class="contact-row"><span class="pair" title="${a} ↔ ${b}">${a} ↔ ${b}</span><span class="area">${fmt(I.area)} mm²</span>
      <select data-ci="${i}">${opts(contactType(I))}</select>
      ${fr ? `<div class="mu-row"><label>摩擦係數 μ<input type="number" data-mu="${i}" min="0" max="2" step="0.05" value="${contactMu(I)}"></label><select data-mup="${i}">${presets}</select></div>` : ''}</div>`;
  });
  html += `<div class="note" style="color:var(--text-dim)">接觸（可分離）屬非線性分析，求解時間較長；分離或滑動的零件須另有支撐，否則會出現剛體位移警告。摩擦接觸：切向力 ≤ μ × 法向壓力時黏著，超過則滑動。</div>`;
  box.innerHTML = html;
  for (const sel of box.querySelectorAll('[data-ci]'))
    sel.onchange = () => { state.contacts[pairKey(list[+sel.dataset.ci])] = sel.value; invalidateResults(); renderContacts(); };
  for (const inp of box.querySelectorAll('[data-mu]'))
    inp.onchange = () => {
      const v = Math.max(0, Math.min(2, +inp.value || 0));
      inp.value = v;
      state.contactMu[pairKey(list[+inp.dataset.mu])] = v;
      invalidateResults();
    };
  for (const sel of box.querySelectorAll('[data-mup]'))
    sel.onchange = () => {
      if (!sel.value) return;
      state.contactMu[pairKey(list[+sel.dataset.mup])] = +sel.value;
      invalidateResults(); renderContacts();
    };
  $('contactAll').onchange = (e) => {
    if (!e.target.value) return;
    for (const I of list) state.contacts[pairKey(I)] = e.target.value;
    invalidateResults(); renderContacts();
  };
}

// ---------- 匯出 ----------
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('btnShot').onclick = () => viewer.renderer.domElement.toBlob((b) => download('mecsim.png', b));
$('btnCsv').onclick = () => {
  const r = state.results, s = curStep();
  if (!r) return;
  const rows = [['part', 'material', 'E_MPa', 'nu', 'yield_MPa', 'max_vonMises_MPa', 'max_disp_mm', 'max_PEEQ']];
  r.partElems.forEach((ne, i) => {
    const m = state.parts[i].material;
    rows.push([state.parts[i].name, m.name, m.E, m.nu, m.sy, s.partMaxVM[i].toFixed(4), s.partMaxU[i].toExponential(4), s.partMaxPE[i].toExponential(4)]);
  });
  rows.push([]);
  rows.push(['node', 'x_mm', 'y_mm', 'z_mm', 'ux_mm', 'uy_mm', 'uz_mm', 'vonMises_MPa', 'PEEQ']);
  const N = RV().nodes;
  for (let n = 0; n < r.used.length; n++) {
    if (!r.used[n]) continue;
    rows.push([n + 1, ...[N[3 * n], N[3 * n + 1], N[3 * n + 2], s.u[3 * n], s.u[3 * n + 1], s.u[3 * n + 2], s.vm[n], s.pe[n]].map((v) => +v.toPrecision(6))]);
  }
  download('mecsim_results.csv', new Blob(['﻿' + rows.map((x) => x.join(',')).join('\n')], { type: 'text/csv' }));
};

// ---------- 事件 ----------
async function withBusy(msg, fn) {
  $('busyTxt').textContent = msg;
  $('busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30));
  try { await fn(); } catch (e) { console.error(e); log(`錯誤：${e.message}`, 'e'); alert(e.message); }
  finally { $('busy').hidden = true; }
}

async function importFile(file) {
  const { bytes, parts } = await loadStep(file);
  if (!parts.length) throw new Error(`${file.name} 中沒有可用的實體`);
  parts.forEach((p, i) => (p.meshIdx = i));
  addFile(file.name, bytes, parts);
  log(`已匯入 ${file.name}：${parts.length} 個零件`);
  return parts;
}

$('fileStep').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) withBusy('解析 STEP 中（首次需載入 OpenCascade 核心）…', async () => { for (const f of files) await importFile(f); });
};

/** 在零件上找「法向最接近 dir 且最突出」的面 */
function findFace(part, dir) {
  let best = 0, bv = -Infinity;
  for (let f = 0; f < part.faceCount; f++) {
    const fi = faceInfo(faceSoup(part, f));
    const v = fi.normal.dot(dir) * 1e3 + fi.centroid.dot(dir);
    if (v > bv) { bv = v; best = f; }
  }
  return best;
}

$('btnDemo').onclick = () => withBusy('載入示範組合件…', async () => {
  clearAll();
  const res = await fetch('samples/demo_assembly.step');
  if (!res.ok) throw new Error('無法載入示範檔');
  const parts = await importFile(new File([await res.arrayBuffer()], 'demo_assembly.step'));
  ['底板', '立柱', '肋板'].forEach((n, i) => parts[i] && (parts[i].name = n));
  if (parts[2]) parts[2].material = cloneMaterial('al6061');
  state.bcs.push({ id: ++bcSeq, type: 'fixed', name: '底板左端固定', faces: new Set([`${parts[0].id}:${findFace(parts[0], new THREE.Vector3(-1, 0, 0))}`]), vector: [0, 0, 0], p: 0, dirs: [true, true, true] });
  state.bcs.push({ id: ++bcSeq, type: 'force', name: '立柱頂部側推', faces: new Set([`${parts[1].id}:${findFace(parts[1], new THREE.Vector3(0, 0, 1))}`]), vector: [-2000, 0, -1000], p: 0 });
  renderAll();
  log('已載入示範組合件（3 件，含預設邊界條件）');
});
$('btnClear').onclick = () => { if (!state.parts.length || confirm('清除所有零件與設定？')) clearAll(); };

for (const btn of document.querySelectorAll('[data-add]'))
  btn.onclick = () => {
    const type = btn.dataset.add;
    const n = state.bcs.filter((b) => b.type === type).length + 1;
    const bc = { id: ++bcSeq, type, name: `${BC_LABEL[type]} ${n}`, faces: new Set(), vector: [0, 0, -1000], p: 1, dirs: [true, true, true] };
    state.bcs.push(bc);
    state.activeBcId = bc.id;
    setMode('model');
    invalidateResults();
    renderAll();
  };

const matSel = $('matKey');
/** 材料下拉選單：依分類（全部／金屬／塑膠）與子分類分組 */
function buildMatOptions(current) {
  const groups = new Map();
  for (const [k, m] of Object.entries(MATERIALS)) {
    if (state.matCat !== 'all' && m.cat !== state.matCat) continue;
    const g = `${CATEGORIES[m.cat]}｜${m.group}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`<option value="${k}">${m.name}</option>`);
  }
  let html = '';
  if (current && (!MATERIALS[current.key] || (state.matCat !== 'all' && MATERIALS[current.key].cat !== state.matCat)))
    html += `<optgroup label="目前材料"><option value="__cur">${current.name}</option></optgroup>`;
  for (const [g, o] of groups) html += `<optgroup label="${g}">${o.join('')}</optgroup>`;
  matSel.innerHTML = html;
  matSel.value = MATERIALS[current?.key] && (state.matCat === 'all' || MATERIALS[current.key].cat === state.matCat) ? current.key : '__cur';
}
matSel.onchange = () => {
  if (matSel.value === '__cur') return;
  partById(state.selectedPartId).material = cloneMaterial(matSel.value);
  invalidateResults(); renderAll();
};
for (const b of $('matCat').querySelectorAll('button'))
  b.onclick = () => {
    state.matCat = b.dataset.cat;
    for (const x of $('matCat').querySelectorAll('button')) x.classList.toggle('on', x === b);
    renderMaterial();
  };
$('matApplyAll').onclick = () => {
  const p = partById(state.selectedPartId);
  if (!p) return;
  for (const q of state.parts) q.material = { ...p.material };
  invalidateResults(); renderAll();
  log(`已將「${p.material.name}」套用到全部 ${state.parts.length} 個零件`);
};
const matField = (id, key, scale = 1) => {
  $(id).onchange = (e) => {
    const p = partById(state.selectedPartId);
    const v = +e.target.value;
    if (!(v > 0)) return renderMaterial();
    const name = p.material.name.endsWith('（自訂）') ? p.material.name : `${p.material.name}（自訂）`;
    p.material = { ...p.material, [key]: key === 'nu' ? Math.min(0.49, v) : v * scale, name };
    invalidateResults(); renderAll();
  };
};
matField('matE', 'E', 1000); matField('matNu', 'nu'); matField('matSy', 'sy'); matField('matSu', 'su'); matField('matRho', 'rho');

$('btnMesh').onclick = meshOnly;
$('btnRun').onclick = runSimulation;
$('btnCancel').onclick = () => { fea.reset(new Error('已取消')); log('已取消（網格需重新產生）', 'w'); showProgress(false); renderAll(); };
$('meshMethod').onchange = () => { renderMeshInfo(); };
$('anaType').onchange = () => { invalidateResults(); renderAll(); };
$('resType').onchange = () => { state.resultType = $('resType').value; repaint(); };
$('stepSlider').oninput = () => { state.step = +$('stepSlider').value; renderResults(); renderMaterial(); repaint(); };
$('showDeform').onchange = () => { state.showDeform = $('showDeform').checked; repaint(); };
$('deformScale').onchange = () => { state.deformScale = +$('deformScale').value || 0; repaint(); };
$('showEdges').onchange = repaint;
$('showMesh').onchange = repaint;
for (const b of $('modeSeg').querySelectorAll('button')) b.onclick = () => { setMode(b.dataset.mode); renderAll(); };
const VIEWS = { iso: [1, -1.2, 0.9], front: [0, -1, 0], right: [1, 0, 0], top: [0, 0, 1] };
for (const b of document.querySelectorAll('[data-view]'))
  b.onclick = () => viewer.fit(VIEWS[b.dataset.view] ? new THREE.Vector3(...VIEWS[b.dataset.view]) : null);

$('splitter').onpointerdown = (e) => {
  const move = (ev) => document.documentElement.style.setProperty('--panel-w', `${Math.max(280, ev.clientX)}px`);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); renderMaterial(); renderResults(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  e.preventDefault();
};

// ---------- 檔名對話框 ----------
function askName(title, def, ext, hint = '') {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgName').value = def;
    $('dlgExt').textContent = ext;
    $('dlgHint').textContent = hint;
    $('nameDlg').hidden = false;
    setTimeout(() => { $('dlgName').focus(); $('dlgName').select(); }, 0);
    const done = (v) => { $('nameDlg').hidden = true; $('nameForm').onsubmit = $('dlgCancel').onclick = $('nameDlg').onkeydown = null; resolve(v); };
    $('nameForm').onsubmit = (e) => { e.preventDefault(); const v = $('dlgName').value.trim(); if (v) done(v); };
    $('dlgCancel').onclick = () => done(null);
    $('nameDlg').onkeydown = (e) => { if (e.key === 'Escape') done(null); };
  });
}

/**
 * 存檔並自訂名稱：支援時用系統「另存新檔」（可選資料夾、中文檔名可靠），否則用自訂對話框後下載
 * makeBlob(name) 依名稱產生內容；回傳最終名稱（不含副檔名），取消回傳 null
 */
async function saveNamed({ title, def, ext, mime, desc, hint, makeBlob }) {
  if (hasSavePicker()) {
    try {
      return await saveWithPicker(makeBlob, safeFileName(def) + ext, ext, mime, desc);
    } catch (e) { console.warn('系統存檔對話框無法使用，改用下載', e); }
  }
  const name = await askName(title, def, ext, hint);
  if (!name) return null;
  await saveBlob(await makeBlob(name), safeFileName(name) + ext);
  return name;
}

// ---------- 專案：儲存／開啟 ----------
const projName = () => $('projName').value.trim() || '未命名專案';
function currentSettings() {
  return {
    meshMethod: $('meshMethod').value, meshSize: $('meshSize').value, anaType: $('anaType').value,
    loadFactor: $('loadFactor').value, nSteps: $('nSteps').value, tol: $('tol').value, bands: $('bands').value,
    page: state.page, insertion: getInsertionState(),
  };
}

async function saveProject() {
  if (!state.parts.length && state.page !== 'ins') return alert('目前沒有模型可儲存');
  let size = 0;
  const name = await saveNamed({
    title: '儲存專案', def: projName(), ext: PROJECT_EXT, mime: 'application/json', desc: 'MecSim 專案檔',
    hint: '包含 STEP 幾何、材料、邊界條件、零件結合、分析設定與插入力計算參數（不含計算結果）。',
    makeBlob: (n) => { const json = JSON.stringify(serializeProject(state, n, currentSettings())); size = json.length; return new Blob([json], { type: 'application/json' }); },
  });
  if (!name) return;
  $('projName').value = name;
  log(`已儲存專案：${safeFileName(name)}${PROJECT_EXT}（${(size / 1024).toFixed(0)} KB）`);
}

async function openProject(file) {
  const P = parseProject(await file.text());
  clearAll();
  // 依檔案載入 STEP，再依專案中的零件清單（順序、名稱、材料…）重建
  const loaded = [];
  for (const f of P.files) {
    const { parts } = await loadStep(new File([f.bytes], f.name));
    parts.forEach((p, i) => (p.meshIdx = i));
    loaded.push(parts);
  }
  const ordered = P.parts.map((pp) => {
    const part = loaded[pp.file]?.[pp.mesh];
    if (!part) throw new Error(`專案中的零件「${pp.name}」在 STEP 檔中找不到`);
    Object.assign(part, { name: pp.name, color: pp.color, visible: pp.visible !== false, material: { ...pp.material } });
    return part;
  });
  P.files.forEach((f, fi) => {
    const fileIdx = state.files.push({ name: f.name, bytes: f.bytes }) - 1;
    for (const part of ordered) if (loaded[fi].includes(part)) part.fileIdx = fileIdx;
  });
  state.parts = ordered;
  const id = (i) => ordered[i]?.id;
  state.bcs = P.bcs.map((b) => ({
    id: ++bcSeq, type: b.type, name: b.name, dirs: b.dirs || [true, true, true], vector: b.vector || [0, 0, 0], p: b.p ?? 0,
    faces: new Set(b.faces.filter(([pi]) => id(pi) !== undefined).map(([pi, fid]) => `${id(pi)}:${fid}`)),
  }));
  state.contacts = {};
  state.contactMu = {};
  for (const [src, dst] of [[P.contacts, state.contacts], [P.contactMu, state.contactMu]])
    for (const [k, v] of Object.entries(src || {})) {
      const [a, b] = k.split('-').map((x) => id(+x));
      if (a !== undefined && b !== undefined) dst[`${Math.min(a, b)}-${Math.max(a, b)}`] = v;
    }
  const S = P.settings || {};
  for (const [k, el] of [['meshMethod', 'meshMethod'], ['meshSize', 'meshSize'], ['anaType', 'anaType'], ['loadFactor', 'loadFactor'], ['nSteps', 'nSteps'], ['tol', 'tol'], ['bands', 'bands']])
    if (S[k] !== undefined) $(el).value = S[k];
  viewer.setColormap(colormap, +$('bands').value);
  if (S.insertion) setInsertionState(S.insertion);
  if (S.page) setPage(S.page);
  $('projName').value = P.name || file.name.replace(/\.[^.]+$/, '');
  state.selectedPartId = ordered[0]?.id ?? null;
  viewer.setParts(state.parts);
  renderAll();
  if (ordered.length) viewer.fit(new THREE.Vector3(1, -1.2, 0.9));
  log(`已開啟專案：${file.name}（${ordered.length} 個零件、${state.bcs.length} 個邊界條件）`);
}

// ---------- PDF 報告 ----------
/** 以指定視角／顯示量擷取 3D 畫面（淺色背景），完成後還原 */
function captureView({ dir, resultType, mode }) {
  const cam = viewer.camera, ctl = viewer.controls;
  const saved = { pos: cam.position.clone(), target: ctl.target.clone(), up: cam.up.clone(), resultType: state.resultType, mode: state.mode };
  const wasPlaying = state.anim.playing;
  state.anim.playing = false;
  if (mode) state.mode = mode;
  if (resultType) { state.resultType = resultType; $('resType').value = resultType; }
  if (dir) viewer.fit(dir);
  repaint();
  const legend = state.range ? { title: RES_LABEL[state.resultType], range: state.range, bands: +$('bands').value } : null;
  const r = viewer.renderer, pr = r.getPixelRatio();
  r.setPixelRatio(Math.max(2, pr));
  viewer.resize();
  ctl.update();
  r.render(viewer.scene, cam);
  const src = r.domElement;
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const g = out.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, out.height);
  grad.addColorStop(0, '#5b6675'); grad.addColorStop(1, '#2a313b');
  g.fillStyle = grad; g.fillRect(0, 0, out.width, out.height);
  g.drawImage(src, 0, 0);
  // 還原
  r.setPixelRatio(pr);
  viewer.resize();
  cam.position.copy(saved.pos); cam.up.copy(saved.up); ctl.target.copy(saved.target); ctl.update();
  state.resultType = saved.resultType; $('resType').value = saved.resultType;
  state.mode = saved.mode;
  repaint();
  state.anim.playing = wasPlaying;
  return { img: out, legend };
}

/** 將面板上的圖表（深色主題）複製到帶背景的 canvas */
function chartImage(canvas) {
  if (!canvas || canvas.hidden || !canvas.width) return null;
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const g = out.getContext('2d');
  g.fillStyle = '#1b1f26'; g.fillRect(0, 0, out.width, out.height);
  g.drawImage(canvas, 0, 0);
  return out;
}

function reportData(name) {
  const R = hasResults() ? state.results : null;
  const s = R ? curStep() : null;
  const massOf = (p) => { const kg = (p.volume * (p.material.rho || 0)) / 1e9; return p.material.rho ? (kg >= 1 ? `${fmt(kg, 4)} kg` : `${fmt(kg * 1000, 4)} g`) : '—'; };
  const faceName = (k) => { const [pid, fid] = k.split(':').map(Number); return `${partById(pid)?.name ?? '?'} 面#${fid + 1}`; };
  const plastic = R ? R.stats.plastic : $('anaType').value === 'plastic';
  const data = {
    name,
    date: new Date().toLocaleString('zh-TW', { hour12: false }),
    parts: state.parts.map((p) => ({ name: p.name, cat: CATEGORIES[p.material.cat] || '自訂', material: p.material.name, E: p.material.E, nu: p.material.nu, sy: p.material.sy, mass: massOf(p) })),
    mesh: state.mesh ? { type: MESH_NAME[state.mesh.type], size: state.mesh.size, elems: state.mesh.elemCount, nodes: state.mesh.nodeCount, quality: state.mesh.quality !== undefined ? state.mesh.quality.toFixed(2) : undefined } : null,
    bcs: state.bcs.map((b) => ({
      name: b.name, type: BC_LABEL[b.type], faces: [...b.faces].map(faceName).join('、') || '（未選面）',
      value: b.type === 'force' ? `(${b.vector.map((v) => fmt(v)).join(', ')}) N` : b.type === 'pressure' ? `${fmt(b.p)} MPa` : bcDesc(b),
    })),
    contacts: (state.mesh?.interfaces || []).map((I) => ({ pair: `${state.parts[I.a]?.name} ↔ ${state.parts[I.b]?.name}`, area: I.area, type: contactLabel(I) })),
    analysis: {
      typeLabel: plastic ? '非線性靜力（彈塑性）' : '線性靜力',
      kv: [
        ['分析類型', plastic ? '非線性靜力（J2 彈塑性）' : '線性靜力（線彈性）'],
        ['負載倍率', $('loadFactor').value],
        ...(plastic ? [['負載步數', $('nSteps').value]] : []),
        ['線性求解容許誤差', $('tol').value],
        ['單位制', 'mm、N、MPa'],
      ],
    },
    results: null, images: [], charts: [],
  };
  if (R) {
    const cols = [{ label: '零件', w: 2.4 }, { label: '最大 σvm [MPa]', w: 1.5, align: 'right' }, { label: '最大位移 [mm]', w: 1.5, align: 'right' }, { label: plastic ? '最大 PEEQ' : '安全係數', w: 1.3, align: 'right' }];
    const rows = R.partElems.map((ne, i) => {
      const p = state.parts[i];
      if (!ne) return [p.name, '未計算', '', ''];
      const vm = s.partMaxVM[i];
      let last;
      if (plastic) { const pe = s.partMaxPE[i]; last = { t: pe > 0 ? pe.toExponential(2) : '0（彈性）', color: pe > 0.02 ? '#c0392b' : pe > 0 ? '#c27c0e' : '#1e8a4f' }; }
      else { const sf = p.material.sy / vm; last = { t: sf > 1e4 ? '>9999' : fmt(sf, 3), color: sf < 1 ? '#c0392b' : sf < 1.5 ? '#c27c0e' : '#1e8a4f' }; }
      return [p.name, fmt(vm, 4), fmt(s.partMaxU[i], 4), last];
    });
    const notes = [
      `總負載 (${R.totalLoad.map((v) => fmt(v)).join(', ')}) N${R.steps.length > 1 ? `，顯示負載步 ${state.step + 1}/${R.steps.length}（λ = ${fmt(s.lambda)}）` : ''}`,
      `${R.stats.type.toUpperCase()}・元素 ${R.stats.elements.toLocaleString()}・自由度 ${R.stats.dofs.toLocaleString()}・求解 ${R.stats.seconds.toFixed(1)} s`,
      ...(R.contact ? [`介面節點閉合 ${R.contact.closed}/${R.contact.springs}${R.contact.sliding ? `（其中摩擦滑動 ${R.contact.sliding}）` : ''}，最大穿透 ${fmt(R.contact.maxPen)} mm`] : []),
      ...(plastic ? [] : ['安全係數 = 降伏強度 / 最大 von Mises 應力（<1 紅、<1.5 橘）']),
    ];
    data.results = { cols, rows, notes, warnings: R.warnings || [] };
  }
  return data;
}

async function exportInsertionPdf() {
  let pages = 0, kb = 0, name = null;
  try {
    name = await saveNamed({
      title: '存 PDF 報告（插入力計算）', def: `${projName()} 插入力計算`, ext: '.pdf', mime: 'application/pdf', desc: 'PDF 報告',
      hint: '包含輸入條件、計算結果、插入力曲線、應力-應變工作點與計算方法。',
      makeBlob: async (n) => {
        let blob;
        await withBusy('產生 PDF 報告中…', async () => {
          const d = insertionReportData();
          if (!d) throw new Error('目前參數無法計算，請先修正輸入');
          const { buildInsertionPdf } = await import('./report.js');
          const r = await buildInsertionPdf({ ...d, name: n, date: new Date().toLocaleString('zh-TW', { hour12: false }) });
          pages = r.pages; kb = r.blob.size / 1024; blob = r.blob;
        });
        if (!blob) throw new Error('PDF 產生失敗');
        return blob;
      },
    });
  } catch (e) { alert(`錯誤：${e.message}`); }
  if (name) log(`已輸出插入力 PDF 報告：${safeFileName(name)}.pdf（${pages} 頁，${kb.toFixed(0)} KB）`);
}

async function exportPdf() {
  if (state.page === 'ins') return exportInsertionPdf();
  if (!state.parts.length) return alert('目前沒有模型可輸出');
  let pages = 0, kb = 0;
  const build = async (name) => {
    const data = reportData(name);
    const iso = new THREE.Vector3(1, -1.2, 0.9), front = new THREE.Vector3(0, -1, 0);
    if (hasResults()) {
      const lam = state.results.steps.length > 1 ? `（λ = ${fmt(curStep().lambda)}）` : '';
      const shots = [
        ['vm', iso, `圖 1　von Mises 應力分布（等角視圖）${lam}`],
        ['umag', iso, `圖 2　總位移分布（等角視圖，變形放大 ${fmt(state.deformScale)} 倍）`],
        ['vm', front, '圖 3　von Mises 應力分布（前視圖）'],
      ];
      if (state.results.stats.plastic) shots.push(['pe', iso, '圖 4　等效塑性應變 PEEQ']);
      for (const [rt, dir, cap] of shots) { const c = captureView({ dir, resultType: rt, mode: 'result' }); data.images.push({ img: c.img, caption: cap, legend: c.legend }); }
      const ld = chartImage($('ldChart'));
      if (ld) data.charts.push({ img: ld, caption: '負載-位移曲線' });
    } else {
      const c = captureView({ dir: iso, mode: 'model' });
      data.images.push({ img: c.img, caption: '模型與邊界條件（藍：固定，紅／橘：負載）' });
    }
    const ss = chartImage($('ssChart'));
    if (ss) data.charts.push({ img: ss, caption: `應力-應變曲線：${partById(state.selectedPartId)?.material.name ?? ''}` });
    const { buildReportPdf } = await import('./report.js');
    const r = await buildReportPdf(data);
    pages = r.pages; kb = r.blob.size / 1024;
    return r.blob;
  };
  let name = null;
  try {
    name = await saveNamed({
      title: '存 PDF 報告', def: `${projName()} 分析報告`, ext: '.pdf', mime: 'application/pdf', desc: 'PDF 報告',
      hint: hasResults() ? '包含模型、設定、結果摘要與結果圖。' : '尚未有計算結果，報告將只包含模型與設定。',
      makeBlob: async (n) => { let blob; await withBusy('產生 PDF 報告中…', async () => { blob = await build(n); }); if (!blob) throw new Error('PDF 產生失敗'); return blob; },
    });
  } catch (e) { log(`錯誤：${e.message}`, 'e'); }
  if (name) log(`已輸出 PDF 報告：${safeFileName(name)}.pdf（${pages} 頁，${kb.toFixed(0)} KB）`);
}

$('btnSave').onclick = saveProject;
$('btnPdf').onclick = exportPdf;
$('fileProj').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) withBusy('開啟專案中…', () => openProject(f));
};
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
});

// ---------- 動態展示 ----------
function animPeriod() {
  const sp = +$('animSpeed').value || 1;
  return $('animType').value === 'steps' ? (Math.max(2, state.results.steps.length) * 0.5) / sp : 2 / sp;
}

function setPlaying(on) {
  const A = state.anim;
  if (on && !hasResults()) return;
  if (on && state.mode !== 'result') { setMode('result'); renderAll(); }
  A.playing = on;
  A.t0 = performance.now();
  A.lastStepT = A.t0;
  $('btnPlay').textContent = on ? '❚❚ 暫停' : '▶ 播放';
  if (!on) repaint(); // 回到靜態顯示
}

viewer.onFrame = () => {
  const A = state.anim;
  if (!A.playing || !hasResults() || state.mode !== 'result') return;
  const now = performance.now();
  const type = $('animType').value;
  const sp = +$('animSpeed').value || 1;
  if (type === 'steps') {
    if (now - A.lastStepT < 500 / sp) return;
    A.lastStepT = now;
    state.step = (state.step + 1) % state.results.steps.length;
    renderResults();
    renderMaterial();
    repaint();
    return;
  }
  const ph = ((now - A.t0) / 1000 / animPeriod()) % 1;
  const f = type === 'deform' ? (1 - Math.cos(2 * Math.PI * ph)) / 2 : ph;
  updateDeformation(state.deformScale * f);
};

async function recordWebM() {
  if (!hasResults()) return;
  if (typeof MediaRecorder === 'undefined') return alert('此瀏覽器不支援錄影（MediaRecorder）');
  const canvas = viewer.renderer.domElement;
  const stream = canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  const wasPlaying = state.anim.playing;
  if ($('animType').value === 'steps') state.step = state.results.steps.length - 1;
  setPlaying(true);
  $('btnRec').classList.add('rec');
  $('btnRec').textContent = '● 錄製中…';
  rec.start();
  await new Promise((r) => setTimeout(r, animPeriod() * 1000 * ($('animType').value === 'deform1' ? 2 : 1) + 100));
  rec.stop();
  await done;
  if (!wasPlaying) setPlaying(false);
  $('btnRec').classList.remove('rec');
  $('btnRec').textContent = '● 錄製 WebM';
  download('mecsim_animation.webm', new Blob(chunks, { type: 'video/webm' }));
  log('已輸出動畫 mecsim_animation.webm');
}

$('btnPlay').onclick = () => setPlaying(!state.anim.playing);
$('btnRec').onclick = recordWebM;
$('animSpeed').oninput = () => { $('animSpeedVal').textContent = `${$('animSpeed').value}×`; };
$('animType').onchange = () => { if (state.anim.playing) setPlaying(true); };
$('animSpeedVal').textContent = '1×';

// ---------- 顯示選項 ----------
$('bands').onchange = () => { viewer.setColormap(colormap, +$('bands').value); repaint(); };
$('showMinMax').onchange = repaint;
$('secOn').onchange = repaint;
$('secPos').oninput = repaint;
$('secFlip').onchange = repaint;
for (const b of $('secAxis').querySelectorAll('button'))
  b.onclick = () => {
    state.secAxis = +b.dataset.axis;
    for (const x of $('secAxis').querySelectorAll('button')) x.classList.toggle('on', x === b);
    repaint();
  };
$('hiQ').onchange = () => viewer.setHighQuality($('hiQ').checked);

renderAll();

// 除錯／自動化測試用
// ---------- 分頁 ----------
function setPage(page) {
  state.page = page === 'ins' ? 'ins' : 'fea';
  const ins = state.page === 'ins';
  document.body.classList.toggle('page-ins', ins);
  $('feaPage').hidden = ins;
  $('insPage').hidden = !ins;
  for (const b of $('pageTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.page === state.page);
  if (ins) { if (state.anim?.playing) setPlaying(false); requestAnimationFrame(drawInsertion); }
  else requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  try { localStorage.setItem('mecsim.page', state.page); } catch {}
}
for (const b of $('pageTabs').querySelectorAll('button')) b.onclick = () => setPage(b.dataset.page);
initInsertion();
state.page = 'fea';
try { if (localStorage.getItem('mecsim.page') === 'ins') setPage('ins'); } catch {}

window.mecsim = { state, setPage, renderAll, runSimulation, generateMesh, viewer, faceSoup, faceInfo, findFace };
