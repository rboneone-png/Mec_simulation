import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadStep, demoAssembly } from './importers.js';
import { MATERIALS, cloneMaterial } from './materials.js';
import { colormap, colormapCss, drawStressStrain, fmt } from './plots.js';
import { nearestActiveNode } from './fea/solve.js';

const $ = (id) => document.getElementById(id);
const BC_LABEL = { fixed: '固定約束', force: '力', pressure: '壓力' };
const BC_COLOR = { fixed: new THREE.Color('#2f7bff'), force: new THREE.Color('#ff5a4f'), pressure: new THREE.Color('#ff8a3d') };

const state = {
  parts: [],
  bcs: [],
  activeBcId: null,
  selectedPartId: null,
  results: null, // { ...worker result, vertexNode: Map(partId -> Int32Array), stale }
  mode: 'model',
  resultType: 'vm',
  showDeform: true,
  deformScale: 1,
};
let bcSeq = 0;

const viewer = new Viewer($('canvasHost'));

// ---------- 零件與幾何 ----------
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
  const src = part.basePositions;
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => out.set(src.subarray(t * 9, t * 9 + 9), i * 9));
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
  // 中心點吸附到面上最近的三角形頂點附近（曲面時中心可能不在面上）
  return { centroid: c, normal: n.normalize(), area };
}

const partById = (id) => state.parts.find((p) => p.id === id);
const modelSize = () => {
  const b = viewer.bounds();
  return b.isEmpty() ? 100 : b.getSize(new THREE.Vector3()).length();
};

function addParts(newParts) {
  for (const p of newParts) {
    p.material = cloneMaterial('steel');
    p.visible = true;
    state.parts.push(p);
  }
  invalidateResults();
  viewer.setParts(state.parts);
  if (!state.selectedPartId && state.parts.length) state.selectedPartId = state.parts[0].id;
  renderAll();
  viewer.fit(new THREE.Vector3(1, -1.2, 0.9));
}

function clearAll() {
  state.parts = []; state.bcs = []; state.activeBcId = null; state.selectedPartId = null;
  state.results = null;
  viewer.setParts([]);
  setMode('model');
  renderAll();
}

// ---------- 上色 / 顯示 ----------
function repaint() {
  const res = state.results;
  const resultMode = state.mode === 'result' && res && !res.stale;
  viewer.clearOverlay();
  let range = null;
  if (resultMode) range = resultRange();

  const tmp = [0, 0, 0];
  for (const p of state.parts) {
    const col = p.geometry.attributes.color;
    const pos = p.geometry.attributes.position;
    const nTri = p.faceOfTri.length;
    if (resultMode) {
      const vn = res.vertexNode.get(p.id);
      const scale = state.showDeform ? state.deformScale : 0;
      for (let v = 0; v < nTri * 3; v++) {
        const n = vn[v];
        if (n < 0) { col.setXYZ(v, 0.45, 0.45, 0.45); pos.setXYZ(v, p.basePositions[3 * v], p.basePositions[3 * v + 1], p.basePositions[3 * v + 2]); continue; }
        const val = valueAt(n);
        colormap((val - range[0]) / (range[1] - range[0] || 1), tmp);
        col.setXYZ(v, tmp[0] ** 2.2, tmp[1] ** 2.2, tmp[2] ** 2.2); // sRGB → linear
        pos.setXYZ(v,
          p.basePositions[3 * v] + scale * res.nodeU[3 * n],
          p.basePositions[3 * v + 1] + scale * res.nodeU[3 * n + 1],
          p.basePositions[3 * v + 2] + scale * res.nodeU[3 * n + 2]);
      }
    } else {
      const base = new THREE.Color(p.color);
      const faceColor = new Map();
      for (const bc of state.bcs) {
        const c = BC_COLOR[bc.type].clone();
        if (bc.id === state.activeBcId) c.lerp(new THREE.Color('#ffffff'), 0.25);
        for (const key of bc.faces) {
          const [pid, fid] = key.split(':').map(Number);
          if (pid === p.id) faceColor.set(fid, c);
        }
      }
      if (p.id === state.selectedPartId && !state.activeBcId) base.lerp(new THREE.Color('#ffffff'), 0.18);
      for (let t = 0; t < nTri; t++) {
        const c = faceColor.get(p.faceOfTri[t]) || base;
        for (let k = 0; k < 3; k++) col.setXYZ(3 * t + k, c.r, c.g, c.b);
      }
      pos.array.set(p.basePositions);
    }
    col.needsUpdate = true;
    pos.needsUpdate = true;
    p.geometry.computeBoundingSphere();
    p.geometry.computeBoundingBox();
    viewer.setPartVisible(p.id, p.visible, 1);
  }
  viewer.setEdgesVisible($('showEdges').checked && !(resultMode && state.showDeform));

  if (!resultMode) drawBcGlyphs();
  updateLegend(resultMode ? range : null);
}

function drawBcGlyphs() {
  const L = modelSize() * 0.08;
  for (const bc of state.bcs) {
    for (const key of bc.faces) {
      const [pid, fid] = key.split(':').map(Number);
      const part = partById(pid);
      if (!part || !part.visible) continue;
      const { centroid, normal } = faceInfo(faceSoup(part, fid));
      if (bc.type === 'fixed') viewer.addFixMarker(centroid.clone().add(normal.clone().multiplyScalar(L * 0.25)), L * 0.35);
      else if (bc.type === 'pressure') viewer.addArrow(centroid, normal.clone().negate().multiplyScalar(Math.sign(bc.p) || 1), L, 0xff8a3d);
      else {
        const v = new THREE.Vector3(...bc.vector);
        if (v.lengthSq() > 0) viewer.addArrow(centroid, v, L, 0xff5a4f);
      }
    }
  }
}

function valueAt(n) {
  const r = state.results;
  switch (state.resultType) {
    case 'vm': return r.nodeVM[n];
    case 'umag': return Math.hypot(r.nodeU[3 * n], r.nodeU[3 * n + 1], r.nodeU[3 * n + 2]);
    case 'ux': return r.nodeU[3 * n];
    case 'uy': return r.nodeU[3 * n + 1];
    case 'uz': return r.nodeU[3 * n + 2];
  }
  return 0;
}

function resultRange() {
  const r = state.results;
  let lo = Infinity, hi = -Infinity;
  for (let n = 0; n < r.nodeActive.length; n++) {
    if (!r.nodeActive[n]) continue;
    const v = valueAt(n);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) hi = lo + 1e-12;
  return [lo, hi];
}

function updateLegend(range) {
  $('legend').hidden = !range;
  if (!range) return;
  $('legendTitle').textContent = $('resType').selectedOptions[0].textContent;
  $('legendBar').style.background = colormapCss();
  const ticks = [];
  for (let i = 0; i <= 10; i++) ticks.push(`<div>${fmt(range[1] - ((range[1] - range[0]) * i) / 10)}</div>`);
  $('legendTicks').innerHTML = ticks.join('');
}

// ---------- 左側面板 ----------
function renderParts() {
  $('partCount').textContent = state.parts.length ? `(${state.parts.length})` : '';
  const list = $('partList');
  if (!state.parts.length) {
    list.innerHTML = '<div class="empty">尚未載入模型。請匯入 STEP 檔或載入示範組合件。</div>';
    return;
  }
  list.innerHTML = '';
  for (const p of state.parts) {
    const el = document.createElement('div');
    el.className = 'item' + (p.id === state.selectedPartId ? ' sel' : '');
    el.innerHTML = `<input type="checkbox" ${p.visible ? 'checked' : ''} title="顯示/隱藏">
      <span class="sw" style="background:${p.color}"></span>
      <span class="name" title="${p.name}">${p.name}</span>
      <span class="meta">${p.material.name}</span>
      <button class="x" title="移除零件">✕</button>`;
    el.querySelector('input').onclick = (e) => { e.stopPropagation(); p.visible = e.target.checked; repaint(); };
    el.querySelector('.x').onclick = (e) => { e.stopPropagation(); removePart(p.id); };
    el.onclick = () => { state.selectedPartId = p.id; state.activeBcId = null; renderAll(); };
    list.appendChild(el);
  }
}

function removePart(id) {
  state.parts = state.parts.filter((p) => p.id !== id);
  for (const bc of state.bcs) bc.faces = new Set([...bc.faces].filter((k) => !k.startsWith(`${id}:`)));
  if (state.selectedPartId === id) state.selectedPartId = state.parts[0]?.id ?? null;
  invalidateResults();
  viewer.setParts(state.parts);
  renderAll();
}

function renderMaterial() {
  const p = partById(state.selectedPartId);
  $('matSection').hidden = !p;
  if (!p) return;
  const m = p.material;
  $('matPartName').textContent = `— ${p.name}`;
  $('matKey').value = m.key;
  $('matE').value = +(m.E / 1000).toPrecision(5);
  $('matNu').value = m.nu;
  $('matSy').value = m.sy;
  $('matSu').value = m.su;
  const ps = state.results && !state.results.stale ? state.results.partStats[state.parts.indexOf(p)] : null;
  drawStressStrain($('ssChart'), m, ps?.maxVM);
}

function renderBcs() {
  const list = $('bcList');
  list.innerHTML = state.bcs.length ? '' : '<div class="empty">點「＋」新增，再到右側 3D 視窗點選面。</div>';
  for (const bc of state.bcs) {
    const el = document.createElement('div');
    el.className = 'item' + (bc.id === state.activeBcId ? ' sel' : '');
    let desc = '';
    if (bc.type === 'force') desc = `${fmt(Math.hypot(...bc.vector))} N`;
    if (bc.type === 'pressure') desc = `${fmt(bc.p)} MPa`;
    el.innerHTML = `<span class="tag ${bc.type}">${BC_LABEL[bc.type]}</span>
      <span class="name">${bc.name}</span><span class="meta">${bc.faces.size} 面 ${desc}</span>
      <button class="x" title="刪除">✕</button>`;
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
  $('pickHint').textContent = `選取「${bc.name}」的面：點擊面加入／再點一次移除`;
  let html = `<div class="grid2"><label class="full">名稱<input type="text" id="bcName" value="${bc.name}"></label></div>`;
  if (bc.type === 'force') {
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">總力向量 [N]（平均分配到所選面）</div>
      <div class="row3"><input type="number" step="any" id="fx" value="${bc.vector[0]}" title="Fx">
      <input type="number" step="any" id="fy" value="${bc.vector[1]}" title="Fy">
      <input type="number" step="any" id="fz" value="${bc.vector[2]}" title="Fz"></div>
      <div class="btn-row" style="margin-top:6px"><button class="btn sm" id="alongN">沿面法向（壓入）</button>
      <label class="check" style="font-size:11px">大小 <input type="number" step="any" id="fmag" value="${fmt(Math.hypot(...bc.vector)) || 1000}" style="width:80px"> N</label></div>`;
  } else if (bc.type === 'pressure') {
    html += `<div class="grid2" style="margin-top:8px"><label class="full">壓力 [MPa]（正值 = 壓入表面）<input type="number" step="any" id="pval" value="${bc.p}"></label></div>`;
  } else {
    html += `<div style="margin-top:8px;font-size:11px;color:var(--text-dim)">所選面的所有節點三個方向位移皆為 0。</div>`;
  }
  html += `<div class="hint">● 已選 ${bc.faces.size} 個面。完成後再點一次清單項目或按 Esc 結束選取。</div>`;
  ed.innerHTML = html;
  $('bcName').oninput = (e) => { bc.name = e.target.value; renderBcsListOnly(); };
  if (bc.type === 'force') {
    for (const [i, id] of ['fx', 'fy', 'fz'].entries())
      $(id).oninput = (e) => { bc.vector[i] = +e.target.value || 0; changedBc(); };
    $('alongN').onclick = () => {
      const n = new THREE.Vector3();
      for (const key of bc.faces) {
        const [pid, fid] = key.split(':').map(Number);
        const fi = faceInfo(faceSoup(partById(pid), fid));
        n.add(fi.normal.multiplyScalar(fi.area));
      }
      if (n.lengthSq() === 0) return alert('請先選取面');
      const mag = +$('fmag').value || 1000;
      n.normalize().multiplyScalar(-mag);
      bc.vector = [n.x, n.y, n.z].map((v) => +v.toPrecision(6));
      renderBcs(); changedBc();
    };
  }
  if (bc.type === 'pressure') $('pval').oninput = (e) => { bc.p = +e.target.value || 0; changedBc(); };
}

function renderBcsListOnly() {
  const ed = state.activeBcId;
  const scroll = $('panel').scrollTop;
  const active = document.activeElement?.id;
  renderBcs();
  $('panel').scrollTop = scroll;
  if (active && $(active)) { $(active).focus(); const el = $(active); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); }
  state.activeBcId = ed;
}

function changedBc() {
  invalidateResults();
  const items = $('bcList').querySelectorAll('.item .meta');
  state.bcs.forEach((bc, i) => {
    let desc = '';
    if (bc.type === 'force') desc = `${fmt(Math.hypot(...bc.vector))} N`;
    if (bc.type === 'pressure') desc = `${fmt(bc.p)} MPa`;
    if (items[i]) items[i].textContent = `${bc.faces.size} 面 ${desc}`;
  });
  repaint();
}

function renderResults() {
  const r = state.results;
  const show = r && !r.stale;
  $('resSection').hidden = !show;
  $('modeSeg').querySelector('[data-mode=result]').disabled = !show;
  if (!show) return;
  $('deformScale').value = fmt(state.deformScale);
  let html = '<tr><th>零件</th><th class="num">最大 σvm</th><th class="num">最大位移</th><th class="num">安全係數</th></tr>';
  r.partStats.forEach((ps, i) => {
    const p = state.parts[i];
    if (!ps.elements) { html += `<tr><td>${ps.name}</td><td colspan="3" class="num" style="color:var(--text-dim)">未計算</td></tr>`; return; }
    const sf = p.material.sy / ps.maxVM;
    const cls = sf < 1 ? 'sf-bad' : sf < 1.5 ? 'sf-mid' : 'sf-ok';
    html += `<tr><td>${ps.name}</td><td class="num">${fmt(ps.maxVM)} MPa</td><td class="num">${fmt(ps.maxU)} mm</td><td class="num ${cls}">${sf > 1e4 ? '>9999' : fmt(sf, 3)}</td></tr>`;
  });
  const s = r.stats;
  html += `<tr><td colspan="4" style="color:var(--text-dim);font-size:11px;padding-top:8px">
    元素 ${s.elements.toLocaleString()}・節點 ${s.nodes.toLocaleString()}・自由度 ${s.dofs.toLocaleString()}<br>
    h = ${fmt(s.h)} mm・PCG 迭代 ${s.iterations}・殘差 ${s.residual.toExponential(1)}・${s.seconds.toFixed(1)} s</td></tr>`;
  $('statsTable').innerHTML = html;
}

function renderAll() {
  renderParts();
  renderMaterial();
  renderBcs();
  renderResults();
  updateHVal();
  repaint();
}

function invalidateResults() {
  if (state.results && !state.results.stale) {
    state.results.stale = true;
    log('模型或設定已變更，請重新執行模擬', 'w');
    setMode('model');
    renderResults();
  }
}

function setMode(mode) {
  if (mode === 'result' && !(state.results && !state.results.stale)) mode = 'model';
  state.mode = mode;
  if (mode === 'result') state.activeBcId = null;
  for (const b of $('modeSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
}

function log(msg, cls = '') {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  $('log').prepend(d);
  while ($('log').children.length > 8) $('log').lastChild.remove();
}

function updateHVal() {
  const res = +$('resolution').value;
  $('resVal').textContent = ` ${res}`;
  const b = viewer.bounds();
  if (b.isEmpty()) { $('hVal').textContent = '—'; return; }
  const s = b.getSize(new THREE.Vector3());
  $('hVal').textContent = `${fmt(Math.max(s.x, s.y, s.z) / res)} mm`;
}

// ---------- 3D 互動 ----------
viewer.onPick = (hit) => {
  const bc = state.bcs.find((b) => b.id === state.activeBcId);
  if (!hit) return;
  const part = partById(hit.partId);
  const fid = part.faceOfTri[hit.tri];
  if (bc && state.mode === 'model') {
    const key = `${part.id}:${fid}`;
    if (bc.faces.has(key)) bc.faces.delete(key); else bc.faces.add(key);
    invalidateResults();
    renderBcs();
    repaint();
    return;
  }
  if (state.mode === 'model') {
    state.selectedPartId = part.id;
    renderAll();
  }
};

viewer.onHover = (hit) => {
  if (!hit) { viewer.setHover(null); $('status').textContent = '就緒'; return; }
  const part = partById(hit.partId);
  const fid = part.faceOfTri[hit.tri];
  const p = hit.point;
  let txt = `${part.name}・面 #${fid + 1}・(${fmt(p.x, 4)}, ${fmt(p.y, 4)}, ${fmt(p.z, 4)}) mm`;
  if (state.mode === 'model') {
    viewer.setHover(state.activeBcId ? faceSoup(part, fid) : null);
  } else {
    viewer.setHover(null);
    const r = state.results;
    const vIdx = hit.tri * 3;
    const n = r.vertexNode.get(part.id)[vIdx];
    if (n >= 0) {
      const label = $('resType').selectedOptions[0].textContent;
      txt += `｜${label}：${fmt(valueAt(n), 4)}`;
    }
  }
  $('status').textContent = txt;
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.activeBcId) { state.activeBcId = null; renderAll(); }
});

// ---------- 求解 ----------
let worker = null;
function runSimulation() {
  if (!state.parts.length) return alert('請先載入模型');
  if (!state.bcs.some((b) => b.type === 'fixed' && b.faces.size)) return alert('請至少設定一個「固定約束」並選取面');
  if (!state.bcs.some((b) => b.type !== 'fixed' && b.faces.size)) return alert('請至少設定一個「力」或「壓力」負載並選取面');

  const parts = state.parts.map((p) => ({ name: p.name, positions: p.basePositions, E: p.material.E, nu: p.material.nu }));
  const bcs = state.bcs.filter((b) => b.faces.size).map((b) => {
    const soups = [...b.faces].map((k) => { const [pid, fid] = k.split(':').map(Number); return faceSoup(partById(pid), fid); });
    const tris = new Float32Array(soups.reduce((s, a) => s + a.length, 0));
    let o = 0; for (const s of soups) { tris.set(s, o); o += s.length; }
    return { type: b.type, tris, vector: b.vector, p: b.p };
  });

  worker?.terminate();
  worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
  const btn = $('btnRun');
  btn.disabled = true;
  $('progress').hidden = false;
  const bar = $('progress').querySelector('.bar'), txt = $('progress').querySelector('.txt');
  const t0 = performance.now();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      bar.style.width = `${Math.round(m.frac * 100)}%`;
      txt.textContent = m.iter ? `${m.stage}・迭代 ${m.iter}・殘差 ${m.residual.toExponential(1)}` : m.stage;
    } else if (m.type === 'done') {
      btn.disabled = false;
      $('progress').hidden = true;
      onResults(m.result, (performance.now() - t0) / 1000);
      worker.terminate(); worker = null;
    } else if (m.type === 'error') {
      btn.disabled = false;
      $('progress').hidden = true;
      log(`錯誤：${m.message}`, 'e');
      worker.terminate(); worker = null;
    }
  };
  worker.postMessage({ parts, bcs, resolution: +$('resolution').value, tol: +$('tol').value });
  log(`開始求解（解析度 ${$('resolution').value}）…`);
}

function onResults(r, secs) {
  const vertexNode = new Map();
  for (const p of state.parts) {
    const P = p.basePositions;
    const vn = new Int32Array(P.length / 3);
    for (let v = 0; v < vn.length; v++) vn[v] = nearestActiveNode(r.grid, r.nodeActive, P[3 * v], P[3 * v + 1], P[3 * v + 2]);
    vertexNode.set(p.id, vn);
  }
  state.results = { ...r, vertexNode, stale: false };
  state.deformScale = r.stats.maxU > 0 ? +((modelSize() * 0.05) / r.stats.maxU).toPrecision(2) : 1;
  for (const w of r.warnings) log(w, 'w');
  log(`完成：${r.stats.elements.toLocaleString()} 元素，${secs.toFixed(1)} s，最大 σvm ${fmt(r.stats.maxVM)} MPa，最大位移 ${fmt(r.stats.maxU)} mm`);
  setMode('result');
  renderAll();
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
  const r = state.results;
  if (!r) return;
  const rows = [['part', 'material', 'E_MPa', 'nu', 'yield_MPa', 'max_vonMises_MPa', 'max_disp_mm', 'safety_factor']];
  r.partStats.forEach((ps, i) => {
    const m = state.parts[i].material;
    rows.push([ps.name, m.name, m.E, m.nu, m.sy, ps.maxVM.toFixed(4), ps.maxU.toExponential(4), ps.elements ? (m.sy / ps.maxVM).toFixed(3) : '']);
  });
  const g = r.grid;
  rows.push([]);
  rows.push(['x_mm', 'y_mm', 'z_mm', 'ux_mm', 'uy_mm', 'uz_mm', 'vonMises_MPa']);
  for (let n = 0; n < r.nodeActive.length; n++) {
    if (!r.nodeActive[n]) continue;
    const i = n % (g.nx + 1), rest = (n - i) / (g.nx + 1), j = rest % (g.ny + 1), k = (rest - j) / (g.ny + 1);
    rows.push([g.ox + i * g.h, g.oy + j * g.h, g.oz + k * g.h, r.nodeU[3 * n], r.nodeU[3 * n + 1], r.nodeU[3 * n + 2], r.nodeVM[n]].map((v) => +v.toPrecision(6)));
  }
  download('mecsim_results.csv', new Blob(['﻿' + rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
};

// ---------- 事件綁定 ----------
async function withBusy(msg, fn) {
  $('busyTxt').textContent = msg;
  $('busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30));
  try { await fn(); } catch (e) { console.error(e); log(`錯誤：${e.message}`, 'e'); alert(e.message); }
  finally { $('busy').hidden = true; }
}

$('fileStep').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  withBusy('解析 STEP 中（首次需載入 OpenCascade 核心）…', async () => {
    for (const f of files) {
      const parts = await loadStep(f);
      if (!parts.length) throw new Error(`${f.name} 中沒有可用的實體`);
      addParts(parts);
      log(`已匯入 ${f.name}：${parts.length} 個零件`);
    }
  });
};
$('btnDemo').onclick = () => {
  clearAll();
  const parts = demoAssembly();
  addParts(parts);
  parts[2].material = cloneMaterial('al6061');
  // 預設邊界條件：底板左端固定、立柱頂面向 -X 推 2000 N
  state.bcs.push({ id: ++bcSeq, type: 'fixed', name: '底板左端固定', faces: new Set([`${parts[0].id}:1`]), vector: [0, 0, 0], p: 0 });
  state.bcs.push({ id: ++bcSeq, type: 'force', name: '立柱頂部側推', faces: new Set([`${parts[1].id}:4`]), vector: [-2000, 0, -1000], p: 0 });
  renderAll();
  log('已載入示範組合件（3 件，含預設邊界條件）');
};
$('btnClear').onclick = () => { if (!state.parts.length || confirm('清除所有零件與設定？')) clearAll(); };

for (const btn of document.querySelectorAll('[data-add]')) {
  btn.onclick = () => {
    const type = btn.dataset.add;
    const n = state.bcs.filter((b) => b.type === type).length + 1;
    const bc = { id: ++bcSeq, type, name: `${BC_LABEL[type]} ${n}`, faces: new Set(), vector: [0, 0, -1000], p: 1 };
    state.bcs.push(bc);
    state.activeBcId = bc.id;
    setMode('model');
    invalidateResults();
    renderAll();
  };
}

const matSel = $('matKey');
matSel.innerHTML = Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}">${m.name}</option>`).join('');
matSel.onchange = () => {
  const p = partById(state.selectedPartId);
  p.material = cloneMaterial(matSel.value);
  invalidateResults(); renderAll();
};
const matField = (id, key, scale = 1) => {
  $(id).onchange = (e) => {
    const p = partById(state.selectedPartId);
    const v = +e.target.value;
    if (!(v > 0)) return renderMaterial();
    p.material = { ...p.material, [key]: v * scale, name: p.material.name.endsWith('（自訂）') ? p.material.name : `${p.material.name}（自訂）` };
    if (key === 'nu') p.material.nu = Math.min(0.49, v);
    invalidateResults(); renderAll();
  };
};
matField('matE', 'E', 1000); matField('matNu', 'nu'); matField('matSy', 'sy'); matField('matSu', 'su');

$('resolution').oninput = updateHVal;
$('btnRun').onclick = runSimulation;
$('resType').onchange = () => { state.resultType = $('resType').value; repaint(); };
$('showDeform').onchange = () => { state.showDeform = $('showDeform').checked; repaint(); };
$('deformScale').onchange = () => { state.deformScale = +$('deformScale').value || 0; repaint(); };
$('showEdges').onchange = repaint;
for (const b of $('modeSeg').querySelectorAll('button')) b.onclick = () => { setMode(b.dataset.mode); renderAll(); };
const VIEWS = { iso: [1, -1.2, 0.9], front: [0, -1, 0], right: [1, 0, 0], top: [0, 0, 1] };
for (const b of document.querySelectorAll('[data-view]'))
  b.onclick = () => viewer.fit(VIEWS[b.dataset.view] ? new THREE.Vector3(...VIEWS[b.dataset.view]) : null);

// 可拖曳分隔線
$('splitter').onpointerdown = (e) => {
  const move = (ev) => document.documentElement.style.setProperty('--panel-w', `${Math.max(280, ev.clientX)}px`);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); renderMaterial(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  e.preventDefault();
};

renderAll();

// 除錯／自動化測試用
window.mecsim = { state, renderAll, runSimulation, viewer, faceSoup, faceInfo };
