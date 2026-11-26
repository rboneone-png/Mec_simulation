// 點對面（node-to-surface）接觸：非共形網格之間的大滑移接觸，罰函數法 + 庫倫摩擦
// 用於插入模擬：插入件（移動件）與其他零件之間，雙向（two-pass）搜尋
// 每個負載步開始時於目前構形建立候選面（決定稀疏矩陣樣式），Newton 迭代中重新投影
import { HEX20_EDGES, TET10_EDGES } from './elements.js';

const HEXF = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
const edgeOf = (edges, a, b) => edges.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));

/** 各元素型別的面節點（依形狀函數順序：角點、邊中點） */
function faceDefs(type) {
  if (type === 'tet10' || type === 'tet4')
    return [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]].map((c) => ({
      c, all: type === 'tet10' ? [...c, ...[0, 1, 2].map((i) => 4 + edgeOf(TET10_EDGES, c[i], c[(i + 1) % 3]))] : c, kind: type === 'tet10' ? 't6' : 't3',
    }));
  return HEXF.map((c) => ({
    c, all: type === 'hex20' ? [...c, ...[0, 1, 2, 3].map((i) => 8 + edgeOf(HEX20_EDGES, c[i], c[(i + 1) % 4]))] : c, kind: type === 'hex20' ? 'q8' : 'q4',
  }));
}

const Q4 = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
/** 面形狀函數與導數：回傳 N、dN/dξ、dN/dη */
function shape(kind, x, y, N, Nx, Ny) {
  if (kind === 'q4') {
    for (let i = 0; i < 4; i++) {
      const [a, b] = Q4[i];
      N[i] = ((1 + a * x) * (1 + b * y)) / 4; Nx[i] = (a * (1 + b * y)) / 4; Ny[i] = (b * (1 + a * x)) / 4;
    }
  } else if (kind === 'q8') {
    for (let i = 0; i < 4; i++) {
      const [a, b] = Q4[i];
      N[i] = ((1 + a * x) * (1 + b * y) * (a * x + b * y - 1)) / 4;
      Nx[i] = (a * (1 + b * y) * (2 * a * x + b * y)) / 4;
      Ny[i] = (b * (1 + a * x) * (a * x + 2 * b * y)) / 4;
    }
    // 邊中點：4:(0,−1) 5:(1,0) 6:(0,1) 7:(−1,0)
    N[4] = ((1 - x * x) * (1 - y)) / 2; Nx[4] = -x * (1 - y); Ny[4] = -(1 - x * x) / 2;
    N[5] = ((1 + x) * (1 - y * y)) / 2; Nx[5] = (1 - y * y) / 2; Ny[5] = -(1 + x) * y;
    N[6] = ((1 - x * x) * (1 + y)) / 2; Nx[6] = -x * (1 + y); Ny[6] = (1 - x * x) / 2;
    N[7] = ((1 - x) * (1 - y * y)) / 2; Nx[7] = -(1 - y * y) / 2; Ny[7] = -(1 - x) * y;
  } else if (kind === 't3') {
    N[0] = 1 - x - y; N[1] = x; N[2] = y;
    Nx[0] = -1; Nx[1] = 1; Nx[2] = 0; Ny[0] = -1; Ny[1] = 0; Ny[2] = 1;
  } else {
    const L0 = 1 - x - y;
    N[0] = L0 * (2 * L0 - 1); N[1] = x * (2 * x - 1); N[2] = y * (2 * y - 1); N[3] = 4 * L0 * x; N[4] = 4 * x * y; N[5] = 4 * y * L0;
    Nx[0] = -(4 * L0 - 1); Nx[1] = 4 * x - 1; Nx[2] = 0; Nx[3] = 4 * (L0 - x); Nx[4] = 4 * y; Nx[5] = -4 * y;
    Ny[0] = -(4 * L0 - 1); Ny[1] = 0; Ny[2] = 4 * y - 1; Ny[3] = -4 * x; Ny[4] = 4 * x; Ny[5] = 4 * (L0 - y);
  }
}
const clampParam = (kind, p) => {
  if (kind[0] === 'q') { p[0] = Math.max(-1, Math.min(1, p[0])); p[1] = Math.max(-1, Math.min(1, p[1])); return; }
  if (p[0] < 0) p[0] = 0;
  if (p[1] < 0) p[1] = 0;
  const s = p[0] + p[1];
  if (s > 1) { p[0] /= s; p[1] /= s; }
};

/**
 * mesh: { type, nodes, elems, elemPart }
 * opts: { moving: 插入件零件索引, h: 元素尺寸, E: 各零件楊氏模數, mu, penalty }
 */
export function createNTS(mesh, opts) {
  const { type, nodes: X, elems, elemPart } = mesh;
  const nE = elemPart.length, nen = elems.length / nE;
  const defs = faceDefs(type);
  const nfn = defs[0].all.length;
  const kind = defs[0].kind;
  // 外表面：角點組合只出現一次的元素面
  const count = new Map();
  const keyOf = (e, f) => f.c.map((k) => elems[e * nen + k]).sort((a, b) => a - b).join(',');
  for (let e = 0; e < nE; e++) for (const f of defs) { const k = keyOf(e, f); count.set(k, (count.get(k) || 0) + 1); }
  const fNodes = [], fPart = [], fSign = [];
  for (let e = 0; e < nE; e++) {
    // 元素形心（判斷外法向）
    let cx = 0, cy = 0, cz = 0;
    const nc = kind[0] === 't' ? 4 : 8;
    for (let k = 0; k < nc; k++) { const n = elems[e * nen + k]; cx += X[3 * n] / nc; cy += X[3 * n + 1] / nc; cz += X[3 * n + 2] / nc; }
    for (const f of defs) {
      if (count.get(keyOf(e, f)) !== 1) continue;
      const fn = f.all.map((k) => elems[e * nen + k]);
      // 中心點的法向
      const a = [0, 0, 0], b = [0, 0, 0], m = [0, 0, 0];
      const [c0, c1, c2] = f.c.map((k) => elems[e * nen + k]);
      for (let d = 0; d < 3; d++) { a[d] = X[3 * c1 + d] - X[3 * c0 + d]; b[d] = X[3 * c2 + d] - X[3 * c0 + d]; }
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      for (const k of f.c) { const q = elems[e * nen + k]; for (let d = 0; d < 3; d++) m[d] += X[3 * q + d] / f.c.length; }
      const s = n[0] * (m[0] - cx) + n[1] * (m[1] - cy) + n[2] * (m[2] - cz) >= 0 ? 1 : -1;
      fNodes.push(...fn); fPart.push(elemPart[e]); fSign.push(s);
    }
  }
  const nF = fPart.length;
  const FN = Int32Array.from(fNodes);

  // 外表面節點與分擔面積（面積平均分給面上各節點）
  const area = new Float64Array(X.length / 3);
  const fNrm = new Float64Array(nF * 3), sN = new Float64Array(X.length); // 面法向、節點外法向（面積加權）
  const nodePart = new Int32Array(X.length / 3).fill(-1);
  const N = new Float64Array(nfn), Nx = new Float64Array(nfn), Ny = new Float64Array(nfn);
  const GP = kind[0] === 'q' ? [[-0.577350269, -0.577350269, 1], [0.577350269, -0.577350269, 1], [0.577350269, 0.577350269, 1], [-0.577350269, 0.577350269, 1]] : [[1 / 6, 1 / 6, 1 / 6], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6]];
  for (let f = 0; f < nF; f++) {
    let A = 0;
    for (const [x, y, w] of GP) {
      shape(kind, x, y, N, Nx, Ny);
      const a = [0, 0, 0], b = [0, 0, 0];
      for (let k = 0; k < nfn; k++) { const q = 3 * FN[f * nfn + k]; for (let d = 0; d < 3; d++) { a[d] += Nx[k] * X[q + d]; b[d] += Ny[k] * X[q + d]; } }
      A += w * Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
    }
    // 面中心外法向
    shape(kind, kind[0] === 'q' ? 0 : 1 / 3, kind[0] === 'q' ? 0 : 1 / 3, N, Nx, Ny);
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let k = 0; k < nfn; k++) { const q = 3 * FN[f * nfn + k]; for (let d = 0; d < 3; d++) { a[d] += Nx[k] * X[q + d]; b[d] += Ny[k] * X[q + d]; } }
    const nn = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const ln = (Math.hypot(...nn) || 1) * fSign[f];
    for (let d = 0; d < 3; d++) fNrm[3 * f + d] = nn[d] / ln;
    for (let k = 0; k < nfn; k++) { const q = FN[f * nfn + k]; area[q] += A / nfn; nodePart[q] = fPart[f]; for (let d = 0; d < 3; d++) sN[3 * q + d] += (A * nn[d]) / ln; }
  }
  const moving = opts.moving;
  for (let n = 0; n < area.length; n++) { const l = Math.hypot(sN[3 * n], sN[3 * n + 1], sN[3 * n + 2]); if (l > 0) for (let d = 0; d < 3; d++) sN[3 * n + d] /= l; }
  const slaves = [];
  for (let n = 0; n < area.length; n++) if (area[n] > 0) slaves.push(n);
  const S = Int32Array.from(slaves), nS = S.length;
  const sMove = Uint8Array.from(S, (n) => (nodePart[n] === moving ? 1 : 0));
  const fMove = Uint8Array.from(fPart, (p) => (p === moving ? 1 : 0));

  const h = opts.h;
  const penalty = opts.penalty ?? 10;
  const Emin = (p) => Math.min(opts.E[moving], opts.E[p]);
  const mu = opts.mu ?? 0.2;

  // 狀態
  let cand = null; // 每個從屬節點的候選面（CSR）
  let candPtr = null;
  let tHist = new Float64Array(nS * 3), tTrial = new Float64Array(nS * 3); // 切向力（歷史／試探）
  const uStart = new Float64Array(X.length);
  const active = new Uint8Array(nS), activePrev = new Uint8Array(nS);
  const best = new Int32Array(nS).fill(-1);
  const bestXi = new Float64Array(nS * 2);
  let frozen = false, changes = 0, faceLock = false;
  const out = { fn: new Float64Array(nS), slip: new Uint8Array(nS) };

  /** 投影點到面（目前構形）：回傳 { xi, eta, g, n, dist2 } */
  const P = new Float64Array(2);
  const xs = [0, 0, 0], xp = [0, 0, 0], ta = [0, 0, 0], tb = [0, 0, 0];
  function project(f, sx, sy, sz, u, res) {
    const o = f * nfn;
    P[0] = kind[0] === 'q' ? 0 : 1 / 3; P[1] = P[0];
    for (let it = 0; it < 8; it++) {
      shape(kind, P[0], P[1], N, Nx, Ny);
      xp[0] = xp[1] = xp[2] = 0; ta[0] = ta[1] = ta[2] = 0; tb[0] = tb[1] = tb[2] = 0;
      for (let k = 0; k < nfn; k++) {
        const q = 3 * FN[o + k];
        for (let d = 0; d < 3; d++) { const x = X[q + d] + u[q + d]; xp[d] += N[k] * x; ta[d] += Nx[k] * x; tb[d] += Ny[k] * x; }
      }
      const r0 = sx - xp[0], r1 = sy - xp[1], r2 = sz - xp[2];
      const a11 = ta[0] * ta[0] + ta[1] * ta[1] + ta[2] * ta[2], a12 = ta[0] * tb[0] + ta[1] * tb[1] + ta[2] * tb[2], a22 = tb[0] * tb[0] + tb[1] * tb[1] + tb[2] * tb[2];
      const b1 = ta[0] * r0 + ta[1] * r1 + ta[2] * r2, b2 = tb[0] * r0 + tb[1] * r1 + tb[2] * r2;
      const det = a11 * a22 - a12 * a12;
      if (!(det > 0)) break;
      const d1 = (a22 * b1 - a12 * b2) / det, d2 = (a11 * b2 - a12 * b1) / det;
      P[0] += d1; P[1] += d2;
      clampParam(kind, P);
      if (Math.abs(d1) + Math.abs(d2) < 1e-10) break;
    }
    shape(kind, P[0], P[1], N, Nx, Ny);
    xp[0] = xp[1] = xp[2] = 0; ta[0] = ta[1] = ta[2] = 0; tb[0] = tb[1] = tb[2] = 0;
    for (let k = 0; k < nfn; k++) {
      const q = 3 * FN[o + k];
      for (let d = 0; d < 3; d++) { const x = X[q + d] + u[q + d]; xp[d] += N[k] * x; ta[d] += Nx[k] * x; tb[d] += Ny[k] * x; }
    }
    let nx = ta[1] * tb[2] - ta[2] * tb[1], ny = ta[2] * tb[0] - ta[0] * tb[2], nz = ta[0] * tb[1] - ta[1] * tb[0];
    const l = Math.hypot(nx, ny, nz) * fSign[f] || 1;
    nx /= l; ny /= l; nz /= l;
    const dx = sx - xp[0], dy = sy - xp[1], dz = sz - xp[2];
    res.xi = P[0]; res.eta = P[1];
    res.g = nx * dx + ny * dy + nz * dz;
    res.n = [nx, ny, nz];
    res.dist2 = dx * dx + dy * dy + dz * dz;
    // 投影是否落在面內（未被夾限）
    const inside = kind[0] === 'q' ? Math.abs(P[0]) < 1 - 1e-9 && Math.abs(P[1]) < 1 - 1e-9 : P[0] > 1e-9 && P[1] > 1e-9 && P[0] + P[1] < 1 - 1e-9;
    res.inside = inside;
    return res;
  }

  /** 負載步開始：記錄起始位移，於目前構形建立候選面；回傳需加入稀疏矩陣的節點對 */
  function beginStep(u, reach) {
    uStart.set(u);
    frozen = false; faceLock = false;
    best.fill(-1);
    // 面的包圍盒（目前構形），放大 reach
    const bb = new Float64Array(nF * 6);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let f = 0; f < nF; f++) {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let k = 0; k < nfn; k++) {
        const q = 3 * FN[f * nfn + k];
        for (let d = 0; d < 3; d++) { const x = X[q + d] + u[q + d]; if (x < b[d]) b[d] = x; if (x > b[3 + d]) b[3 + d] = x; }
      }
      for (let d = 0; d < 3; d++) { b[d] -= reach; b[3 + d] += reach; lo[d] = Math.min(lo[d], b[d]); hi[d] = Math.max(hi[d], b[3 + d]); }
      bb.set(b, 6 * f);
    }
    const cs = Math.max(h, reach) * 2;
    const dim = [0, 1, 2].map((d) => Math.max(1, Math.ceil((hi[d] - lo[d]) / cs)));
    const cell = (v, d) => Math.min(dim[d] - 1, Math.max(0, Math.floor((v - lo[d]) / cs)));
    const grid = new Map();
    for (let f = 0; f < nF; f++) {
      const b = bb.subarray(6 * f, 6 * f + 6);
      for (let z = cell(b[2], 2); z <= cell(b[5], 2); z++)
        for (let y = cell(b[1], 1); y <= cell(b[4], 1); y++)
          for (let x = cell(b[0], 0); x <= cell(b[3], 0); x++) {
            const k = x + dim[0] * (y + dim[1] * z);
            let a = grid.get(k);
            if (!a) grid.set(k, (a = []));
            a.push(f);
          }
    }
    const ptr = [0], list = [];
    const pairs = new Set();
    const pairKey = (a, b) => a * 4194304 + b;
    for (let s = 0; s < nS; s++) {
      const n = S[s], sx = X[3 * n] + u[3 * n], sy = X[3 * n + 1] + u[3 * n + 1], sz = X[3 * n + 2] + u[3 * n + 2];
      if (sx < lo[0] || sy < lo[1] || sz < lo[2] || sx > hi[0] || sy > hi[1] || sz > hi[2]) { ptr.push(list.length); continue; }
      const a = grid.get(cell(sx, 0) + dim[0] * (cell(sy, 1) + dim[1] * cell(sz, 2)));
      if (a)
        for (const f of a) {
          // 雙向：移動件節點 ↔ 其他零件的面；其他零件節點 ↔ 移動件的面
          if (sMove[s] === fMove[f]) continue;
          const b = bb.subarray(6 * f, 6 * f + 6);
          if (sx < b[0] || sy < b[1] || sz < b[2] || sx > b[3] || sy > b[4] || sz > b[5]) continue;
          list.push(f);
          for (let k = 0; k < nfn; k++) { const m = FN[f * nfn + k]; pairs.add(n < m ? pairKey(n, m) : pairKey(m, n)); }
        }
      ptr.push(list.length);
    }
    cand = Int32Array.from(list); candPtr = Int32Array.from(ptr);
    const pa = [], pb = [];
    for (const k of pairs) { const a = Math.floor(k / 4194304); pa.push(a); pb.push(k - a * 4194304); }
    return { a: Int32Array.from(pa), b: Int32Array.from(pb), candidates: list.length };
  }

  const res = { xi: 0, eta: 0, g: 0, n: null, dist2: 0, inside: false };
  const resB = { xi: 0, eta: 0, g: 0, n: null, dist2: 0, inside: false };
  const C = new Float64Array(nfn + 1), Cn = new Int32Array(nfn + 1);
  const K = new Float64Array(9);

  /**
   * 組裝接觸力與切線勁度
   * fint：內力向量（累加）；addK(i, j, K9, c)：將 c·K9 加到區塊 (i, j)；update：更新接觸狀態
   */
  function assemble(u, fint, addK, update) {
    if (update) changes = 0;
    const maxPen = 0.5 * h;
    for (let s = 0; s < nS; s++) {
      const n = S[s];
      const sx = X[3 * n] + u[3 * n], sy = X[3 * n + 1] + u[3 * n + 1], sz = X[3 * n + 2] + u[3 * n + 2];
      // 最近面（優先投影落在面內者）
      let bf = -1, bd = Infinity, bin = false;
      for (let q = candPtr[s]; q < candPtr[s + 1]; q++) {
        const f = cand[q];
        if (faceLock && best[s] >= 0 && f !== best[s]) continue; // 鎖定接觸面（避免在相鄰面間來回切換）
        project(f, sx, sy, sz, u, resB);
        if (resB.g > 0.25 * h || resB.g < -maxPen) continue;
        // 投影被夾限在面邊界外：僅在距離向量幾乎沿法向時（稜線附近）接受，避免誤判穿透
        if (!resB.inside && resB.dist2 - resB.g * resB.g > (0.02 * h) ** 2) continue;
        // 法向相對準則：從屬節點外法向需與面法向大致相反（避免孔緣節點誤判為接觸頂面而產生假軸向力）
        const opp = -(sN[3 * n] * resB.n[0] + sN[3 * n + 1] * resB.n[1] + sN[3 * n + 2] * resB.n[2]);
        if (opp < 0.25) continue;
        const score = resB.dist2 - opp * 1e-6 * h * h;
        const better = (resB.inside && !bin) || (resB.inside === bin && score < bd);
        if (better) { bf = f; bd = score; bin = resB.inside; res.xi = resB.xi; res.eta = resB.eta; res.g = resB.g; res.n = resB.n; }
      }
      let on = bf >= 0 && res.g < 0;
      if (update && !frozen) { if ((on ? 1 : 0) !== active[s]) changes++; active[s] = on ? 1 : 0; }
      else on = on && active[s] === 1;
      if (!on) { tTrial[3 * s] = tTrial[3 * s + 1] = tTrial[3 * s + 2] = 0; out.fn[s] = 0; out.slip[s] = 0; continue; }
      best[s] = bf; bestXi[2 * s] = res.xi; bestXi[2 * s + 1] = res.eta;
      const g = res.g, nv = res.n;
      const kN = (penalty * Emin(fPart[bf] === moving ? nodePart[n] : fPart[bf]) * area[n]) / h;
      shape(kind, res.xi, res.eta, N, Nx, Ny);
      C[0] = 1; Cn[0] = n;
      for (let k = 0; k < nfn; k++) { C[k + 1] = -N[k]; Cn[k + 1] = FN[bf * nfn + k]; }
      // 法向力（正值為壓力）
      const fn = -kN * g;
      out.fn[s] = fn;
      // 切向：步內相對位移增量（投影到切平面）+ 歷史切向力
      const dd = [0, 0, 0];
      for (let k = 0; k <= nfn; k++) { const q = 3 * Cn[k]; for (let d = 0; d < 3; d++) dd[d] += C[k] * (u[q + d] - uStart[q + d]); }
      const dn = dd[0] * nv[0] + dd[1] * nv[1] + dd[2] * nv[2];
      const th = [tHist[3 * s], tHist[3 * s + 1], tHist[3 * s + 2]];
      const thn = th[0] * nv[0] + th[1] * nv[1] + th[2] * nv[2];
      const tr = [0, 1, 2].map((d) => th[d] - thn * nv[d] + kN * (dd[d] - dn * nv[d]));
      const trN = Math.hypot(tr[0], tr[1], tr[2]);
      const lim = mu * fn;
      let t = tr, kt = kN, that = null;
      if (trN > lim && trN > 0) { that = tr.map((v) => v / trN); t = that.map((v) => v * lim); kt = (kN * lim) / trN; out.slip[s] = 1; }
      else out.slip[s] = 0;
      tTrial[3 * s] = t[0]; tTrial[3 * s + 1] = t[1]; tTrial[3 * s + 2] = t[2];
      const fv = [kN * g * nv[0] + t[0], kN * g * nv[1] + t[1], kN * g * nv[2] + t[2]];
      for (let k = 0; k <= nfn; k++) { const q = 3 * Cn[k]; fint[q] += C[k] * fv[0]; fint[q + 1] += C[k] * fv[1]; fint[q + 2] += C[k] * fv[2]; }
      if (!addK) continue;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const Pij = (i === j ? 1 : 0) - nv[i] * nv[j];
          // 滑動時加入摩擦力對法向力的耦合項 −μ·kN·t̂⊗n（非對稱）
          K[3 * i + j] = kN * nv[i] * nv[j] + kt * (Pij - (that ? that[i] * that[j] : 0)) + (that ? 1e-6 * kN * that[i] * that[j] - mu * kN * that[i] * nv[j] : 0);
        }
      for (let a = 0; a <= nfn; a++) for (let b = 0; b <= nfn; b++) addK(Cn[a], Cn[b], K, C[a] * C[b]);
    }
    return changes;
  }

  function commit() { [tHist, tTrial] = [tTrial, tHist]; tTrial.fill(0); activePrev.set(active); }
  function freeze() { frozen = true; }
  function lockFaces() { faceLock = true; }

  /** 目前接觸狀態摘要與節點接觸壓力 */
  function summary(nNode) {
    // 節點接觸壓力：從屬節點的法向力 + 作為主面節點承受的反力（依形狀函數分配），再除以分擔面積
    const fnode = new Float64Array(nNode);
    let nAct = 0, nSlip = 0, Fn = 0;
    for (let s = 0; s < nS; s++) {
      if (!active[s] || !(out.fn[s] > 0) || best[s] < 0) continue;
      nAct++; if (out.slip[s]) nSlip++;
      const f = out.fn[s];
      Fn += f;
      fnode[S[s]] += f;
      shape(kind, bestXi[2 * s], bestXi[2 * s + 1], N, Nx, Ny);
      let sp = 0;
      for (let k = 0; k < nfn; k++) sp += Math.max(0, N[k]);
      for (let k = 0; k < nfn; k++) fnode[FN[best[s] * nfn + k]] += (f * Math.max(0, N[k])) / (sp || 1);
    }
    const cp = new Float32Array(nNode);
    for (let n = 0; n < nNode; n++) if (fnode[n] > 0 && area[n] > 0) cp[n] = fnode[n] / area[n];
    return { cp, nAct, nSlip, Fn };
  }

  return { surfaceNodes: S, beginStep, assemble, commit, freeze, lockFaces, summary, nonsymmetric: mu > 0, get changes() { return changes; }, slaves: nS, faces: nF };
}
