// 體素化 HEX8 網格（快速、穩健，但斜面／曲面為階梯狀）
import { ELEMENTS } from './elements.js';

const HEX = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];

export function makeGrid(parts, h) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3)
      for (let d = 0; d < 3; d++) { min[d] = Math.min(min[d], a[i + d]); max[d] = Math.max(max[d], a[i + d]); }
  }
  const ext = max.map((v, d) => v - min[d]);
  const n = ext.map((e) => Math.max(1, Math.ceil(e / h - 1e-9)));
  const origin = min.map((m, d) => m - (n[d] * h - ext[d]) / 2);
  return { h, nx: n[0], ny: n[1], nz: n[2], ox: origin[0], oy: origin[1], oz: origin[2] };
}

/** +x 射線奇偶法體素化 */
export function voxelizePart(pos, g, elemPart, tag) {
  const { nx, ny, nz, h, ox, oy, oz } = g;
  const cols = new Map();
  const jy = h * 1.2345e-4, jz = h * 2.3456e-4;
  for (let t = 0; t < pos.length; t += 9) {
    const x0 = pos[t], y0 = pos[t + 1], z0 = pos[t + 2];
    const x1 = pos[t + 3], y1 = pos[t + 4], z1 = pos[t + 5];
    const x2 = pos[t + 6], y2 = pos[t + 7], z2 = pos[t + 8];
    const d = (y1 - y0) * (z2 - z0) - (y2 - y0) * (z1 - z0);
    if (Math.abs(d) < 1e-14 * h * h) continue;
    const j0 = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - oy - jy) / h - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(y0, y1, y2) - oy - jy) / h - 0.5));
    const k0 = Math.max(0, Math.ceil((Math.min(z0, z1, z2) - oz - jz) / h - 0.5));
    const k1 = Math.min(nz - 1, Math.floor((Math.max(z0, z1, z2) - oz - jz) / h - 0.5));
    for (let k = k0; k <= k1; k++) {
      const zc = oz + (k + 0.5) * h + jz;
      for (let j = j0; j <= j1; j++) {
        const yc = oy + (j + 0.5) * h + jy;
        const l1 = ((yc - y0) * (z2 - z0) - (y2 - y0) * (zc - z0)) / d;
        const l2 = ((y1 - y0) * (zc - z0) - (yc - y0) * (z1 - z0)) / d;
        const l0 = 1 - l1 - l2;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const key = j + ny * k;
        let arr = cols.get(key);
        if (!arr) cols.set(key, (arr = []));
        arr.push(l0 * x0 + l1 * x1 + l2 * x2);
      }
    }
  }
  let count = 0;
  for (const [key, xs] of cols) {
    xs.sort((a, b) => a - b);
    const j = key % ny, k = (key - j) / ny;
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - ox) / h - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[q + 1] - ox) / h - 0.5));
      for (let i = i0; i <= i1; i++) {
        const idx = i + nx * (j + ny * k);
        if (!elemPart[idx]) { elemPart[idx] = tag; count++; }
      }
    }
  }
  return count;
}

/**
 * parts: [{ name, positions: Float32Array（三角形 soup） }]
 * 回傳通用 mesh 物件（含 BC 對應與顯示資料）
 */
export function voxelMesh(parts, h) {
  const g = makeGrid(parts, h);
  const warnings = [];
  const nGE = g.nx * g.ny * g.nz;
  const gridPart = new Uint16Array(nGE);
  parts.forEach((p, i) => {
    if (!voxelizePart(p.positions, g, gridPart, i + 1)) warnings.push(`零件「${p.name}」比元素尺寸還薄或不封閉，未產生元素`);
  });
  const NX = g.nx + 1, NY = g.ny + 1;
  const gridNode = new Int32Array(NX * NY * (g.nz + 2)).fill(-1);
  const elems = [], elemPart = [], coords = [];
  for (let k = 0; k < g.nz; k++)
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const tag = gridPart[i + g.nx * (j + g.ny * k)];
        if (!tag) continue;
        for (const [a, b, c] of HEX) {
          const gn = i + a + NX * (j + b + NY * (k + c));
          if (gridNode[gn] < 0) {
            gridNode[gn] = coords.length / 3;
            coords.push(g.ox + (i + a) * h, g.oy + (j + b) * h, g.oz + (k + c) * h);
          }
          elems.push(gridNode[gn]);
        }
        elemPart.push(tag - 1);
      }
  const nodes = Float64Array.from(coords);

  const nearest = (x, y, z) => {
    const fi = (x - g.ox) / h, fj = (y - g.oy) / h, fk = (z - g.oz) / h;
    const ri = Math.round(fi), rj = Math.round(fj), rk = Math.round(fk);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++)
      for (let dk = -r; dk <= r; dk++)
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
            const i = ri + di, j = rj + dj, k = rk + dk;
            if (i < 0 || j < 0 || k < 0 || i > g.nx || j > g.ny || k > g.nz) continue;
            const n = gridNode[i + NX * (j + NY * k)];
            if (n < 0) continue;
            const dd = (i - fi) ** 2 + (j - fj) ** 2 + (k - fk) ** 2;
            if (dd < bd) { bd = dd; best = n; }
          }
    return best;
  };

  // 顯示：沿用 CAD 三角網格，頂點對應最近節點
  const display = parts.map((p) => {
    const P = p.positions;
    const vn = new Int32Array(P.length / 3);
    for (let v = 0; v < vn.length; v++) vn[v] = nearest(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
    return { positions: P, index: null, vertexNode: vn, wire: null };
  });

  return {
    type: 'hex8',
    nodes,
    elems: Int32Array.from(elems),
    elemPart: Int32Array.from(elemPart),
    warnings,
    display,
    info: { h },
    /** BC 對應：取樣面上的點 → 最近節點；集中力平均分配 */
    mapFace(face, cb) {
      const t = face.soup;
      for (let i = 0; i < t.length; i += 9) {
        const set = new Set();
        sampleTriangle(t, i, h * 0.5, (x, y, z) => { const n = nearest(x, y, z); if (n >= 0) set.add(n); });
        const { area, n } = triAreaNormal(t, i);
        if (set.size) cb([...set].map((nd) => [nd, 1 / set.size]), area, n);
      }
    },
  };
}

export function sampleTriangle(t, i, spacing, cb) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2];
  const bx = t[i + 3] - ax, by = t[i + 4] - ay, bz = t[i + 5] - az;
  const cx = t[i + 6] - ax, cy = t[i + 7] - ay, cz = t[i + 8] - az;
  const len = Math.max(Math.hypot(bx, by, bz), Math.hypot(cx, cy, cz), Math.hypot(bx - cx, by - cy, bz - cz));
  const n = Math.min(200, Math.max(1, Math.ceil(len / spacing)));
  for (let u = 0; u <= n; u++)
    for (let v = 0; v <= n - u; v++) cb(ax + (bx * u) / n + (cx * v) / n, ay + (by * u) / n + (cy * v) / n, az + (bz * u) / n + (cz * v) / n);
  cb(ax + (bx + cx) / 3, ay + (by + cy) / 3, az + (bz + cz) / 3);
}

export function triAreaNormal(t, i) {
  const bx = t[i + 3] - t[i], by = t[i + 4] - t[i + 1], bz = t[i + 5] - t[i + 2];
  const cx = t[i + 6] - t[i], cy = t[i + 7] - t[i + 1], cz = t[i + 8] - t[i + 2];
  const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
  const l = Math.hypot(nx, ny, nz);
  return { area: l / 2, n: l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0] };
}

export { ELEMENTS };
