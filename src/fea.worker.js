// 常駐 Worker：保留網格於記憶體，處理「產生網格」與「求解」
import { voxelMesh } from './fea/mesh-voxel.js';
import { tetwildMesh } from './fea/mesh-tetwild.js';
import { hexMesh } from './fea/mesh-hex.js';
import { buildLoads } from './fea/bc.js';
import { solveStatic } from './fea/solver.js';
import { detectInterfaces, applyInterfaces } from './fea/contact.js';
import { meshSeparately } from './fea/mesh-separate.js';
import { createNTS } from './fea/nts.js';

let mesh = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const { id, cmd, data } = e.data;
  const progress = (p) => post({ id, type: 'progress', ...p });
  try {
    if (cmd === 'mesh') {
      const t0 = Date.now();
      mesh = null;
      const one = (parts, prog) => {
        if (data.method === 'tet') return tetwildMesh(parts, { size: data.size }, prog);
        if (data.method === 'hex20' || data.method === 'hex8') return hexMesh(parts, { size: data.size, order: data.method === 'hex20' ? 2 : 1 }, prog);
        prog({ stage: '體素化', frac: 0.2 });
        return voxelMesh(parts, data.size);
      };
      // 插入模擬：各零件獨立網格（允許干涉重疊，零件間以接觸傳力）
      mesh = data.separate ? await meshSeparately(data.parts, one, progress) : await one(data.parts, progress);
      if (!mesh.elems.length) throw new Error('網格沒有任何元素（元素尺寸可能大於零件厚度）');
      progress({ stage: '偵測零件接觸面', frac: 0.95 });
      mesh.interfaces = mesh.separate ? [] : detectInterfaces(mesh);
      const counts = new Array(data.parts.length).fill(0);
      for (const p of mesh.elemPart) counts[p]++;
      const result = {
        type: mesh.type,
        nodes: Float32Array.from(mesh.nodes),
        nodeCount: mesh.nodes.length / 3,
        elemCount: mesh.elemPart.length,
        partElems: counts,
        elems: mesh.elems,
        interfaces: mesh.interfaces.map((I) => ({ a: I.a, b: I.b, area: I.area, faces: I.faces.length / 2 })),
        elemPart: mesh.elemPart,
        quality: mesh.info?.worstQuality,
        display: mesh.display,
        warnings: mesh.warnings,
        separate: !!mesh.separate,
        seconds: (Date.now() - t0) / 1000,
      };
      post({ id, type: 'done', result });
    } else if (cmd === 'insert') {
      if (!mesh) throw new Error('請先產生網格');
      if (!mesh.separate) throw new Error('插入模擬需要「各零件獨立網格」，請重新產生網格');
      const r = solveInsertion(data, progress);
      post({ id, type: 'done', result: r }, r.steps.flatMap((s) => [s.u.buffer, s.vm.buffer, s.pe.buffer, ...(s.cp ? [s.cp.buffer] : [])]));
    } else if (cmd === 'solve') {
      if (!mesh) throw new Error('請先產生網格');
      progress({ stage: '套用邊界條件', frac: 0.01 });
      // 依結合設定拆開介面節點、建立介面彈簧
      const h = mesh.info?.size || 1;
      const split = applyInterfaces(mesh, mesh.interfaces || [], data.contacts, data.setup.materials, h);
      const copyMap = split.copies.map(([from, to]) => new Map(Array.from(from, (n, i) => [n, to[i]])));
      const work = {
        type: mesh.type, nodes: split.nodes, elems: split.elems, elemPart: mesh.elemPart,
        mapFace: (face, cb) => mesh.mapFace(face, (nw, area, n) => cb(nw.map(([nd, w]) => [copyMap[face.part]?.get(nd) ?? nd, w]), area, n)),
      };
      const { fixed, F, total, warnings: w1 } = buildLoads(work, data.bcs);
      if (!F.some((v) => v)) w1.push('沒有任何負載，結果將為零');
      const r = solveStatic(work, { ...data.setup, fixed, F, springs: split.springs }, progress);
      if (split.nodes !== mesh.nodes) {
        r.split = { nodes: Float32Array.from(split.nodes), elems: split.elems, copies: split.copies };
      }
      r.warnings = [...w1, ...r.warnings];
      r.totalLoad = total;
      const transfer = r.steps.flatMap((s) => [s.u.buffer, s.vm.buffer, s.pe.buffer]);
      post({ id, type: 'done', result: r }, transfer);
    }
  } catch (err) {
    console.error(err);
    post({ id, type: 'error', message: err?.message || String(err) });
  }
};

/** 插入模擬：移動件沿插入方向強制位移，零件間點對面接觸（摩擦）、可含彈塑性 */
function solveInsertion(data, progress) {
  const I = data.insertion;
  const nNode = mesh.nodes.length / 3, X = mesh.nodes;
  const h = mesh.info?.size || 1;
  const pull = I.mode === 'pull';
  // 插入：沿插入方向前進；拔出：自組裝位置沿反方向退出
  const dir = I.dir.map((v) => ((pull ? -1 : 1) * v) / (Math.hypot(...I.dir) || 1));
  const mv = I.moving;
  const body = new Uint8Array(nNode);
  const nen = mesh.elems.length / mesh.elemPart.length;
  for (let e = 0; e < mesh.elemPart.length; e++) if (mesh.elemPart[e] === mv) for (let k = 0; k < nen; k++) body[mesh.elems[e * nen + k]] = 1;
  const warnings = [];
  const work = { type: mesh.type, nodes: X, elems: mesh.elems, elemPart: mesh.elemPart, mapFace: mesh.mapFace };
  // 固定約束：只套用在非移動件；推動面另外處理
  const fixedBcs = data.bcs.filter((b) => b.type === 'fixed' && b.faces.some((f) => f.part !== mv)).map((b) => ({ ...b, faces: b.faces.filter((f) => f.part !== mv) }));
  const { fixed, warnings: w1 } = buildLoads(work, fixedBcs);
  warnings.push(...w1);
  const dot = (n) => X[3 * n] * dir[0] + X[3 * n + 1] * dir[1] + X[3 * n + 2] * dir[2];
  if (!fixed.some((v) => v)) {
    // 自動固定：其他零件在插入方向最前端的節點
    let mx = -Infinity;
    for (let n = 0; n < nNode; n++) if (!body[n]) mx = Math.max(mx, dot(n));
    let cnt = 0;
    for (let n = 0; n < nNode; n++) if (!body[n] && dot(n) >= mx - 0.05 * h) { fixed[3 * n] = fixed[3 * n + 1] = fixed[3 * n + 2] = 1; cnt++; }
    warnings.push(`未設定固定約束：已自動固定被插入件在${pull ? '拔出' : '插入'}方向最前端的 ${cnt} 個節點`);
  }
  // 推動面：使用者指定的「推動面」，否則取移動件在插入方向最後端的節點
  const push = new Set();
  for (const b of data.bcs.filter((b) => b.type === 'push')) for (const f of b.faces) if (f.part === mv) mesh.mapFace(f, (nw) => { for (const [n] of nw) push.add(n); });
  if (!push.size) {
    // 插入：推動尾端；拔出：拉住頭端（移動方向的最前端）
    const sg = pull ? -1 : 1;
    let mn = Infinity;
    for (let n = 0; n < nNode; n++) if (body[n]) mn = Math.min(mn, sg * dot(n));
    for (let n = 0; n < nNode; n++) if (body[n] && sg * dot(n) <= mn + 0.05 * h) push.add(n);
    warnings.push(`未指定推動面：以插入件${pull ? '頭端' : '尾端'} ${push.size} 個節點作為施力面`);
  }
  // 起點／終點平移（CAD 為插入完成位置時，先往回退一個行程）
  const S = I.stroke;
  const d0 = !pull && I.start === 'final' ? dir.map((v) => -v * S) : [0, 0, 0];
  const d1 = d0.map((v, i) => v + dir[i] * S);
  const nts = createNTS(mesh, { moving: mv, h, E: data.setup.materials.map((m) => m.E), mu: I.mu });
  const F = new Float64Array(nNode * 3);
  const r = solveStatic(work, {
    ...data.setup, loadFactor: 1, steps: I.steps, fixed, F, h,
    drive: { push: Int32Array.from(push), body, d0, d1 }, nts,
  }, progress);
  r.warnings = [...warnings, ...r.warnings];
  r.totalLoad = [0, 0, 0];
  const Fmax = Math.max(0, ...r.steps.map((s) => s.insert?.force || 0));
  if (!r.steps.some((s) => s.insert?.nAct)) r.warnings.push(pull ? '拔出過程中零件都沒有接觸：請確認 CAD 為組裝完成位置、插入件與方向' : '整個行程中零件都沒有接觸：請確認插入件、插入方向與行程（以及 CAD 位置是「插入完成」或「插入起點」）');
  r.insertion = { mode: pull ? 'pull' : 'insert', dir, stroke: S, moving: mv, Fmax, mu: I.mu, start: I.start, pushNodes: push.size, slaves: nts.slaves };
  return r;
}
