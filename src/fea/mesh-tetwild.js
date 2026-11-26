// fTetWild（MPL-2.0，WASM 單執行緒版）四面體網格
// 流程：CAD 表面三角形 → fTetWild（TET4）→ 依射線奇偶判斷所屬零件 → 升階 TET10
//      → 邊界節點投影回 CAD 曲面 → 邊界三角形對應回 CAD 面（供邊界條件與顯示）
import { TriGrid, tri6Load } from './geom.js';
import { TET10_EDGES } from './elements.js';

let modPromise = null;
async function getModule() {
  if (!modPromise) {
    const isNode = typeof process !== 'undefined' && !!process.versions?.node;
    const load = isNode
      ? import(/* @vite-ignore */ new URL('../../node_modules/float-tetwild-wasm/dist/floattetwild.serial.mjs', import.meta.url).href)
      : import('ftetwild-serial'); // vite.config.js 的 alias
    modPromise = load.then((m) => m.default({ print() {}, printErr() {} }));
  }
  return modPromise;
}

async function tetrahedralize(vertices, faces, params) {
  const M = await getModule();
  const pv = M.allocBuffer(vertices.byteLength);
  M.HEAPF64.set(vertices, pv / 8);
  const pf = M.allocBuffer(faces.byteLength);
  M.HEAP32.set(faces, pf / 4);
  let r;
  try {
    r = M.tetrahedralize(pv, vertices.length, pf, faces.length, {
      epsRel: 1e-3, idealEdgeLengthRel: 0.05, stopEnergy: 10, maxIts: 80,
      disableFiltering: false, coarsen: false, manifoldSurface: false, numThreads: 0, ...params,
    });
  } finally { M.freeBuffer(pv); M.freeBuffer(pf); }
  const out = { status: r.status, vertices: r.verticesView().slice(), tets: r.tetsView().slice() };
  r.delete();
  return out;
}

/** 焊接重複頂點（CAD 每個面各自三角化，邊界頂點重複） */
function weld(soup, tol) {
  const map = new Map(), V = [], F = new Int32Array(soup.length / 3);
  const q = 1 / tol;
  for (let v = 0; v < soup.length / 3; v++) {
    const x = soup[3 * v], y = soup[3 * v + 1], z = soup[3 * v + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) { id = V.length / 3; map.set(key, id); V.push(x, y, z); }
    F[v] = id;
  }
  return { V, F };
}

/** 以 +x 射線奇偶判斷點是否在封閉三角網格內（yz 分格加速） */
class InsideTester {
  constructor(soup, bbox, bins = 64) {
    this.t = soup; this.b = bbox;
    this.ny = bins; this.nz = bins;
    this.hy = (bbox[4] - bbox[1]) / bins || 1; this.hz = (bbox[5] - bbox[2]) / bins || 1;
    this.cells = Array.from({ length: bins * bins }, () => []);
    for (let k = 0; k < soup.length / 9; k++) {
      const i = 9 * k;
      const j0 = this.cy(Math.min(soup[i + 1], soup[i + 4], soup[i + 7])), j1 = this.cy(Math.max(soup[i + 1], soup[i + 4], soup[i + 7]));
      const k0 = this.cz(Math.min(soup[i + 2], soup[i + 5], soup[i + 8])), k1 = this.cz(Math.max(soup[i + 2], soup[i + 5], soup[i + 8]));
      for (let a = k0; a <= k1; a++) for (let c = j0; c <= j1; c++) this.cells[c + bins * a].push(k);
    }
  }
  cy(y) { return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.b[1]) / this.hy))); }
  cz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.b[2]) / this.hz))); }
  inside(px, py, pz) {
    const b = this.b;
    if (px < b[0] || px > b[3] || py < b[1] || py > b[4] || pz < b[2] || pz > b[5]) return false;
    py += 1.234e-7 * this.hy; pz += 2.345e-7 * this.hz;
    const t = this.t;
    let cnt = 0;
    for (const k of this.cells[this.cy(py) + this.ny * this.cz(pz)]) {
      const i = 9 * k;
      const y0 = t[i + 1], z0 = t[i + 2], y1 = t[i + 4], z1 = t[i + 5], y2 = t[i + 7], z2 = t[i + 8];
      const d = (y1 - y0) * (z2 - z0) - (y2 - y0) * (z1 - z0);
      if (d === 0) continue;
      const l1 = ((py - y0) * (z2 - z0) - (y2 - y0) * (pz - z0)) / d;
      const l2 = ((y1 - y0) * (pz - z0) - (py - y0) * (z1 - z0)) / d;
      const l0 = 1 - l1 - l2;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      if (l0 * t[i] + l1 * t[i + 3] + l2 * t[i + 6] > px) cnt++;
    }
    return cnt % 2 === 1;
  }
}

/**
 * parts: [{ name, positions: Float32Array（CAD 三角形 soup）, faceOfTri: Int32Array, bbox }]
 * opts:  { size（目標元素邊長 mm） }
 */
export async function tetwildMesh(parts, opts, progress = () => {}) {
  const warnings = [];
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let d = 0; d < 3; d++) { bb[d] = Math.min(bb[d], p.bbox[d]); bb[3 + d] = Math.max(bb[3 + d], p.bbox[3 + d]); }
  const diag = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
  const epsRel = 1e-3;
  const eps = epsRel * diag;

  // 1. 合併所有零件表面（接觸面重疊 → fTetWild 會產生共形網格＝黏合）
  progress({ stage: '準備表面網格', frac: 0.03 });
  const V = [], F = [];
  for (const p of parts) {
    const w = weld(p.positions, diag * 1e-7);
    const o = V.length / 3;
    for (const v of w.V) V.push(v);
    for (const f of w.F) F.push(f + o);
  }
  progress({ stage: '產生四面體網格（fTetWild）', frac: 0.08 });
  await new Promise((r) => setTimeout(r, 0));
  const res = await tetrahedralize(Float64Array.from(V), Int32Array.from(F), { epsRel, idealEdgeLengthRel: Math.min(0.5, opts.size / diag), coarsen: opts.coarsen ?? true });
  if (res.status !== 0 || !res.tets.length) throw new Error(`fTetWild 網格失敗（status ${res.status}）`);
  progress({ stage: '整理網格', frac: 0.75 });

  // 2. 每個四面體所屬零件
  const P0 = res.vertices, T4 = res.tets;
  const nT = T4.length / 4;
  const testers = parts.map((p) => new InsideTester(p.positions, p.bbox));
  const tetPart = new Int32Array(nT).fill(-1);
  for (let e = 0; e < nT; e++) {
    let cx = 0, cy = 0, cz = 0;
    for (let a = 0; a < 4; a++) { const n = T4[4 * e + a]; cx += P0[3 * n] / 4; cy += P0[3 * n + 1] / 4; cz += P0[3 * n + 2] / 4; }
    for (let p = 0; p < parts.length; p++) if (testers[p].inside(cx, cy, cz)) { tetPart[e] = p; break; }
  }
  // 邊界上少數判斷失敗者：沿用相鄰四面體的零件
  const fkey = (a, b, c) => { const v = [a, b, c].sort((x, y) => x - y); return `${v[0]},${v[1]},${v[2]}`; };
  const faceTets = new Map();
  for (let e = 0; e < nT; e++)
    for (let k = 0; k < 4; k++) {
      const f = [0, 1, 2, 3].filter((i) => i !== k).map((i) => T4[4 * e + i]);
      const key = fkey(f[0], f[1], f[2]);
      const arr = faceTets.get(key);
      if (arr) arr.push(e, T4[4 * e + k]); else faceTets.set(key, [e, T4[4 * e + k]]);
    }
  for (let pass = 0; pass < 20; pass++) {
    let left = 0;
    for (let e = 0; e < nT; e++) {
      if (tetPart[e] >= 0) continue;
      left++;
      for (let k = 0; k < 4 && tetPart[e] < 0; k++) {
        const f = [0, 1, 2, 3].filter((i) => i !== k).map((i) => T4[4 * e + i]);
        const arr = faceTets.get(fkey(f[0], f[1], f[2]));
        for (let q = 0; q < arr.length; q += 2) if (arr[q] !== e && tetPart[arr[q]] >= 0) { tetPart[e] = tetPart[arr[q]]; break; }
      }
    }
    if (!left) break;
  }
  for (let e = 0; e < nT; e++) if (tetPart[e] < 0) tetPart[e] = 0;
  parts.forEach((p, i) => { if (!tetPart.includes(i)) warnings.push(`零件「${p.name}」沒有產生元素（可能太薄或與其他零件重疊）`); });

  // 3. 升階 TET10（邊中點）
  const nodes = Array.from(P0);
  const edgeMid = new Map();
  const elems = new Int32Array(nT * 10);
  for (let e = 0; e < nT; e++) {
    const c = [T4[4 * e], T4[4 * e + 1], T4[4 * e + 2], T4[4 * e + 3]];
    for (let a = 0; a < 4; a++) elems[10 * e + a] = c[a];
    TET10_EDGES.forEach(([a, b], k) => {
      const i = c[a], j = c[b];
      const key = i < j ? i * 4194304 + j : j * 4194304 + i;
      let m = edgeMid.get(key);
      if (m === undefined) {
        m = nodes.length / 3;
        edgeMid.set(key, m);
        nodes.push((nodes[3 * i] + nodes[3 * j]) / 2, (nodes[3 * i + 1] + nodes[3 * j + 1]) / 2, (nodes[3 * i + 2] + nodes[3 * j + 2]) / 2);
      }
      elems[10 * e + 4 + k] = m;
    });
  }
  const mid = (i, j) => edgeMid.get(i < j ? i * 4194304 + j : j * 4194304 + i);

  // 4. 邊界面（只出現一次的四面體面）→ tri6
  const bnd = []; // { e, part, tn:[6], opp }
  for (const arr of faceTets.values()) {
    if (arr.length !== 2) continue;
    const e = arr[0], opp = arr[1];
    const c = [0, 1, 2, 3].map((a) => T4[4 * e + a]).filter((n) => n !== opp);
    bnd.push({ part: tetPart[e], tn: [c[0], c[1], c[2], mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[0])], opp });
  }

  // 5. 邊界三角形 → CAD 面；邊界節點投影回 CAD 曲面
  progress({ stage: '邊界對應 CAD 面', frac: 0.85 });
  const soupAll = [], triPart = [], triFace = [];
  parts.forEach((p, pi) => {
    for (const v of p.positions) soupAll.push(v);
    for (let t = 0; t < p.positions.length / 9; t++) { triPart.push(pi); triFace.push(p.faceOfTri ? p.faceOfTri[t] : 0); }
  });
  const soup = Float32Array.from(soupAll);
  const grid = new TriGrid(soup, bb, 64);
  const triN = (k) => {
    const i = 9 * k;
    const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1], uz = soup[i + 5] - soup[i + 2];
    const vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1], vz = soup[i + 8] - soup[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n) || 1;
    return n.map((x) => x / l);
  };
  const tol = Math.max(eps * 3, opts.size * 0.02);
  for (const f of bnd) {
    const { n } = tri6Load(nodes, f.tn, f.opp);
    const cx = (nodes[3 * f.tn[0]] + nodes[3 * f.tn[1]] + nodes[3 * f.tn[2]]) / 3;
    const cy = (nodes[3 * f.tn[0] + 1] + nodes[3 * f.tn[1] + 1] + nodes[3 * f.tn[2] + 1]) / 3;
    const cz = (nodes[3 * f.tn[0] + 2] + nodes[3 * f.tn[1] + 2] + nodes[3 * f.tn[2] + 2]) / 3;
    const best = grid.nearest(cx, cy, cz, (k) => triPart[k] === f.part);
    let pick = best ? best.k : -1;
    if (best) {
      // 距離相近的候選中，選法向最一致者（避免稜線附近誤判）
      let bs = -Infinity;
      grid.query(cx, cy, cz, Math.sqrt(best.q[3]) + tol, (k) => {
        const m = triN(k);
        const s = Math.abs(m[0] * n[0] + m[1] * n[1] + m[2] * n[2]);
        if (s > bs + 1e-6) { bs = s; pick = k; }
      }, (k) => triPart[k] === f.part);
    }
    f.face = pick >= 0 ? triFace[pick] : -1;
  }
  // 節點投影（角點與邊中點），限制位移量避免元素翻轉
  const snapped = new Set();
  const snap = (nd, part, cap) => {
    if (snapped.has(nd)) return;
    snapped.add(nd);
    const b = grid.nearest(nodes[3 * nd], nodes[3 * nd + 1], nodes[3 * nd + 2], (k) => triPart[k] === part, cap * 4);
    if (b && b.q[3] <= cap * cap) { nodes[3 * nd] = b.q[0]; nodes[3 * nd + 1] = b.q[1]; nodes[3 * nd + 2] = b.q[2]; }
  };
  for (const f of bnd) for (let k = 0; k < 3; k++) snap(f.tn[k], f.part, eps * 4);
  for (const f of bnd) {
    for (const [k, a, b] of [[3, 0, 1], [4, 1, 2], [5, 2, 0]]) {
      const i = f.tn[a], j = f.tn[b];
      const L = Math.hypot(nodes[3 * i] - nodes[3 * j], nodes[3 * i + 1] - nodes[3 * j + 1], nodes[3 * i + 2] - nodes[3 * j + 2]);
      if (!snapped.has(f.tn[k])) { // 先更新為投影後角點的中點
        for (let d = 0; d < 3; d++) nodes[3 * f.tn[k] + d] = (nodes[3 * i + d] + nodes[3 * j + d]) / 2;
      }
      snap(f.tn[k], f.part, L * 0.2);
    }
  }
  const nodeArr = Float64Array.from(nodes);

  // 6. 顯示：每個零件依 CAD 面分組（面內共用頂點以平滑著色，稜線保持銳利）
  const disp = parts.map(() => ({ pos: [], idx: [], vn: [], wire: new Map(), groups: new Map() }));
  for (const f of bnd) {
    const D = disp[f.part];
    let local = D.groups.get(f.face);
    if (!local) D.groups.set(f.face, (local = new Map()));
    const vid = (n) => {
      let v = local.get(n);
      if (v === undefined) { v = D.vn.length; local.set(n, v); D.vn.push(n); D.pos.push(nodeArr[3 * n], nodeArr[3 * n + 1], nodeArr[3 * n + 2]); }
      return v;
    };
    const t = f.tn;
    for (const [a, b, c] of [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]]) D.idx.push(vid(t[a]), vid(t[b]), vid(t[c]));
    for (const [a, b] of [[0, 3], [3, 1], [1, 4], [4, 2], [2, 5], [5, 0]]) D.wire.set(t[a] < t[b] ? `${t[a]},${t[b]}` : `${t[b]},${t[a]}`, [t[a], t[b]]);
  }
  const display = disp.map((D) => ({
    positions: Float32Array.from(D.pos), index: Uint32Array.from(D.idx), vertexNode: Int32Array.from(D.vn),
    wire: Int32Array.from([...D.wire.values()].flat()),
  }));

  return {
    type: 'tet10',
    nodes: nodeArr,
    elems,
    elemPart: tetPart,
    warnings,
    display,
    info: { size: opts.size, boundaryFaces: bnd.length },
    /** BC 對應：face = { part, faceId } → 該 CAD 面上的所有邊界 tri6 */
    mapFace(face, cb) {
      let cnt = 0;
      for (const f of bnd) {
        if (f.part !== face.part || f.face !== face.faceId) continue;
        const r = tri6Load(nodeArr, f.tn, f.opp);
        if (r.area > 0) { cb(r.nw, r.area, r.n); cnt++; }
      }
      return cnt;
    },
  };
}
