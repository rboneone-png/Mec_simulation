// 幾何工具：點到三角形最近點、三角形空間格網、tri6 一致性積分

/** 點 p 到三角形 (t[i..i+8]) 的最近點，回傳 [qx,qy,qz,距離平方]（Ericson） */
export function closestPointTri(px, py, pz, t, i) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2];
  const abx = t[i + 3] - ax, aby = t[i + 4] - ay, abz = t[i + 5] - az;
  const acx = t[i + 6] - ax, acy = t[i + 7] - ay, acz = t[i + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - t[i + 3], bpy = py - t[i + 4], bpz = pz - t[i + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - t[i + 6], cpy = py - t[i + 7], cpz = pz - t[i + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { qx = t[i + 3]; qy = t[i + 4]; qz = t[i + 5]; }
    else if (d6 >= 0 && d5 <= d6) { qx = t[i + 6]; qy = t[i + 7]; qz = t[i + 8]; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = t[i + 3] + w * (t[i + 6] - t[i + 3]); qy = t[i + 4] + w * (t[i + 7] - t[i + 4]); qz = t[i + 5] + w * (t[i + 8] - t[i + 5]);
    } else {
      const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  return [qx, qy, qz, (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2];
}

/** 三角形 soup 的均勻空間格網，用於最近三角形查詢 */
export class TriGrid {
  /** soup: Float32Array（9 個數一個三角形）；tag: 每個三角形的附加資料（如零件、面） */
  constructor(soup, bbox, targetCells = 48) {
    this.t = soup;
    const ext = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]];
    this.h = Math.max(...ext) / targetCells || 1;
    this.o = [bbox[0] - this.h, bbox[1] - this.h, bbox[2] - this.h];
    this.n = ext.map((e) => Math.max(1, Math.ceil(e / this.h) + 2));
    this.cells = new Map();
    const nt = soup.length / 9;
    for (let k = 0; k < nt; k++) {
      const i = 9 * k;
      const lo = [0, 1, 2].map((d) => this.cellOf(Math.min(soup[i + d], soup[i + 3 + d], soup[i + 6 + d]), d));
      const hi = [0, 1, 2].map((d) => this.cellOf(Math.max(soup[i + d], soup[i + 3 + d], soup[i + 6 + d]), d));
      for (let z = lo[2]; z <= hi[2]; z++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let x = lo[0]; x <= hi[0]; x++) {
            const key = x + this.n[0] * (y + this.n[1] * z);
            let a = this.cells.get(key);
            if (!a) this.cells.set(key, (a = []));
            a.push(k);
          }
    }
  }
  cellOf(v, d) { return Math.min(this.n[d] - 1, Math.max(0, Math.floor((v - this.o[d]) / this.h))); }
  /** 對半徑 r 內的每個三角形呼叫 cb(k, [qx,qy,qz,d2])；filter(k) 可略過 */
  query(px, py, pz, r, cb, filter) {
    const c = [this.cellOf(px, 0), this.cellOf(py, 1), this.cellOf(pz, 2)];
    const R = Math.ceil(r / this.h);
    const seen = new Set();
    for (let z = c[2] - R; z <= c[2] + R; z++)
      for (let y = c[1] - R; y <= c[1] + R; y++)
        for (let x = c[0] - R; x <= c[0] + R; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= this.n[0] || y >= this.n[1] || z >= this.n[2]) continue;
          const a = this.cells.get(x + this.n[0] * (y + this.n[1] * z));
          if (!a) continue;
          for (const k of a) {
            if (seen.has(k) || (filter && !filter(k))) continue;
            seen.add(k);
            const q = closestPointTri(px, py, pz, this.t, 9 * k);
            if (q[3] <= r * r) cb(k, q);
          }
        }
  }
  /** 最近三角形（逐步擴大搜尋半徑） */
  nearest(px, py, pz, filter, rMax = Infinity) {
    let best = null;
    for (let r = this.h; r <= Math.max(rMax, this.h); r *= 2) {
      this.query(px, py, pz, r, (k, q) => { if (!best || q[3] < best.q[3]) best = { k, q }; }, filter);
      if (best || r > this.h * Math.max(...this.n)) break;
    }
    return best;
  }
}

// tri6 形狀函數（節點順序：0,1,2 角點；3:(0,1) 4:(1,2) 5:(2,0)）
function tri6N(x, y) {
  const L = [1 - x - y, x, y];
  return [L[0] * (2 * L[0] - 1), L[1] * (2 * L[1] - 1), L[2] * (2 * L[2] - 1), 4 * L[0] * L[1], 4 * L[1] * L[2], 4 * L[2] * L[0]];
}
function tri6dN(x, y) {
  const L0 = 1 - x - y;
  return [[-(4 * L0 - 1), -(4 * L0 - 1)], [4 * x - 1, 0], [0, 4 * y - 1], [4 * (L0 - x), -4 * x], [4 * y, 4 * x], [-4 * y, 4 * (L0 - y)]];
}
const TRI_GP = [[1 / 6, 1 / 6], [2 / 3, 1 / 6], [1 / 6, 2 / 3]];

/**
 * tri6 面的一致性節點權重（∫N dA / A）、面積與外法向
 * tn: 6 個節點索引；opp: 相鄰四面體的對面頂點（決定法向朝外）
 */
export function tri6Load(nodes, tn, opp) {
  const w = [0, 0, 0, 0, 0, 0], nrm = [0, 0, 0];
  let area = 0;
  for (const [gx, gy] of TRI_GP) {
    const Nn = tri6N(gx, gy), dN = tri6dN(gx, gy);
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let k = 0; k < 6; k++) for (let d = 0; d < 3; d++) { a[d] += dN[k][0] * nodes[3 * tn[k] + d]; b[d] += dN[k][1] * nodes[3 * tn[k] + d]; }
    const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dA = Math.hypot(...cr) / 6;
    area += dA;
    for (let d = 0; d < 3; d++) nrm[d] += cr[d] / 6;
    for (let k = 0; k < 6; k++) w[k] += Nn[k] * dA;
  }
  const nl = Math.hypot(...nrm) || 1;
  let n = nrm.map((v) => v / nl);
  if (opp !== undefined && opp >= 0) {
    let dot = 0;
    for (let d = 0; d < 3; d++) dot += n[d] * (nodes[3 * opp + d] - (nodes[3 * tn[0] + d] + nodes[3 * tn[1] + d] + nodes[3 * tn[2] + d]) / 3);
    if (dot > 0) n = n.map((v) => -v);
  }
  return { nw: Array.from(tn, (nd, k) => [nd, area > 0 ? w[k] / area : 0]), area, n };
}
