// 線彈性靜力分析：體素化（六面體網格）+ 矩陣自由 Jacobi-PCG
// 單位制：mm、N、MPa
import { HEX_NODES, bMatrix, dMatrix, unitKe, vonMises } from './hex8.js';

/** 建立包住所有零件的均勻網格 */
export function makeGrid(parts, resolution) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3)
      for (let d = 0; d < 3; d++) {
        if (a[i + d] < min[d]) min[d] = a[i + d];
        if (a[i + d] > max[d]) max[d] = a[i + d];
      }
  }
  const ext = max.map((v, d) => v - min[d]);
  const h = Math.max(...ext) / resolution;
  const n = ext.map((e) => Math.max(1, Math.ceil(e / h - 1e-9)));
  const origin = min.map((m, d) => m - (n[d] * h - ext[d]) / 2);
  return { h, nx: n[0], ny: n[1], nz: n[2], ox: origin[0], oy: origin[1], oz: origin[2] };
}

/** 以 +x 方向射線奇偶法將封閉三角網格體素化，tag 寫入空的 voxel */
export function voxelizePart(pos, g, elemPart, tag) {
  const { nx, ny, nz, h, ox, oy, oz } = g;
  const cols = new Map();
  const jy = h * 1.2345e-4, jz = h * 2.3456e-4; // 微小偏移避免射線剛好穿過邊
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

export function nodeIndex(g, i, j, k) {
  return i + (g.nx + 1) * (j + (g.ny + 1) * k);
}

/** 找最接近點 (x,y,z) 的有效節點，找不到回傳 -1 */
export function nearestActiveNode(g, nodeActive, x, y, z) {
  const fi = (x - g.ox) / g.h, fj = (y - g.oy) / g.h, fk = (z - g.oz) / g.h;
  const ri = Math.round(fi), rj = Math.round(fj), rk = Math.round(fk);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= 2 && best < 0; r++) {
    for (let dk = -r; dk <= r; dk++)
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
          const i = ri + di, j = rj + dj, k = rk + dk;
          if (i < 0 || j < 0 || k < 0 || i > g.nx || j > g.ny || k > g.nz) continue;
          const n = nodeIndex(g, i, j, k);
          if (!nodeActive[n]) continue;
          const dd = (i - fi) ** 2 + (j - fj) ** 2 + (k - fk) ** 2;
          if (dd < bestD) { bestD = dd; best = n; }
        }
  }
  return best;
}

function sampleTriangle(t, i, spacing, cb) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2];
  const bx = t[i + 3] - ax, by = t[i + 4] - ay, bz = t[i + 5] - az;
  const cx = t[i + 6] - ax, cy = t[i + 7] - ay, cz = t[i + 8] - az;
  const len = Math.max(Math.hypot(bx, by, bz), Math.hypot(cx, cy, cz),
    Math.hypot(bx - cx, by - cy, bz - cz));
  const n = Math.min(200, Math.max(1, Math.ceil(len / spacing)));
  for (let u = 0; u <= n; u++)
    for (let v = 0; v <= n - u; v++) {
      const a = u / n, b = v / n;
      cb(ax + bx * a + cx * b, ay + by * a + cy * b, az + bz * a + cz * b);
    }
  cb(ax + (bx + cx) / 3, ay + (by + cy) / 3, az + (bz + cz) / 3);
}

function triAreaNormal(t, i) {
  const bx = t[i + 3] - t[i], by = t[i + 4] - t[i + 1], bz = t[i + 5] - t[i + 2];
  const cx = t[i + 6] - t[i], cy = t[i + 7] - t[i + 1], cz = t[i + 8] - t[i + 2];
  const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
  const l = Math.hypot(nx, ny, nz);
  return { area: l / 2, n: l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0] };
}

/**
 * 執行分析
 * input = {
 *   parts: [{ name, positions: Float32Array(三角形 soup), E, nu }],
 *   resolution, tol, maxIter,
 *   bcs: [{ type:'fixed'|'force'|'pressure', tris: Float32Array, vector?:[fx,fy,fz], p? }]
 * }
 */
export function runAnalysis(input, progress = () => {}) {
  const { parts, bcs, resolution = 40, tol = 1e-6, maxIter = 20000 } = input;
  const warnings = [];
  progress({ stage: '建立網格', frac: 0 });

  const g = makeGrid(parts, resolution);
  const nElem = g.nx * g.ny * g.nz;
  const nNode = (g.nx + 1) * (g.ny + 1) * (g.nz + 1);
  const elemPart = new Uint16Array(nElem);
  parts.forEach((p, idx) => {
    const c = voxelizePart(p.positions, g, elemPart, idx + 1);
    if (c === 0) warnings.push(`零件「${p.name}」比網格尺寸還薄或不封閉，未產生元素`);
  });

  // 有效元素與節點
  const offs = HEX_NODES.map(([a, b, c]) => a + (g.nx + 1) * (b + (g.ny + 1) * c));
  let active = [];
  for (let e = 0; e < nElem; e++) if (elemPart[e]) active.push(e);
  const elemBase = (e) => {
    const i = e % g.nx, r = (e - i) / g.nx, j = r % g.ny, k = (r - j) / g.ny;
    return nodeIndex(g, i, j, k);
  };

  let nodeActive = new Uint8Array(nNode);
  for (const e of active) { const b = elemBase(e); for (const o of offs) nodeActive[b + o] = 1; }

  // 邊界條件 → 節點
  const spacing = g.h * 0.5;
  const fixed = new Uint8Array(nNode);
  const loadsRaw = []; // [node, fx, fy, fz]
  for (const bc of bcs) {
    const t = bc.tris;
    if (bc.type === 'fixed') {
      for (let i = 0; i < t.length; i += 9)
        sampleTriangle(t, i, spacing, (x, y, z) => {
          const n = nearestActiveNode(g, nodeActive, x, y, z);
          if (n >= 0) fixed[n] = 1;
        });
      continue;
    }
    let totalA = 0;
    for (let i = 0; i < t.length; i += 9) totalA += triAreaNormal(t, i).area;
    for (let i = 0; i < t.length; i += 9) {
      const { area, n } = triAreaNormal(t, i);
      let F;
      if (bc.type === 'pressure') F = n.map((c) => -c * bc.p * area); // 正壓力壓入表面
      else F = bc.vector.map((c) => (totalA > 0 ? (c * area) / totalA : 0));
      const set = new Set();
      sampleTriangle(t, i, spacing, (x, y, z) => {
        const nn = nearestActiveNode(g, nodeActive, x, y, z);
        if (nn >= 0) set.add(nn);
      });
      if (!set.size) continue;
      for (const nn of set) loadsRaw.push([nn, F[0] / set.size, F[1] / set.size, F[2] / set.size]);
    }
  }
  if (!fixed.some((v) => v)) throw new Error('至少需要一個「固定約束」才能求解');
  if (!loadsRaw.length) warnings.push('沒有任何負載，結果將為零');

  // 連通性檢查：未連到固定約束的零件區塊會造成剛體運動，予以排除
  progress({ stage: '連通性檢查', frac: 0.05 });
  const parent = new Int32Array(nNode).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (const e of active) {
    const b = elemBase(e), r0 = find(b + offs[0]);
    for (let q = 1; q < 8; q++) { const r = find(b + offs[q]); if (r !== r0) parent[r] = r0; }
  }
  const anchored = new Set();
  for (let n = 0; n < nNode; n++) if (fixed[n]) anchored.add(find(n));
  const removedParts = new Set();
  active = active.filter((e) => {
    const ok = anchored.has(find(elemBase(e)));
    if (!ok) { removedParts.add(elemPart[e] - 1); elemPart[e] = 0; }
    return ok;
  });
  for (const p of removedParts)
    warnings.push(`零件「${parts[p].name}」的部分或全部區域未連接到固定約束，已排除`);
  nodeActive = new Uint8Array(nNode);
  for (const e of active) { const b = elemBase(e); for (const o of offs) nodeActive[b + o] = 1; }

  // 元素資料
  const nA = active.length;
  if (!nA) throw new Error('沒有可計算的元素');
  const eNodes = new Int32Array(nA * 8);
  const eScale = new Float64Array(nA);
  const eMat = new Uint16Array(nA);
  const KeList = parts.map((p) => unitKe(p.nu));
  active.forEach((e, a) => {
    const b = elemBase(e);
    for (let q = 0; q < 8; q++) eNodes[a * 8 + q] = b + offs[q];
    const pi = elemPart[e] - 1;
    eMat[a] = pi;
    eScale[a] = parts[pi].E * g.h;
  });

  // 自由度
  const nDof = nNode * 3;
  const free = new Uint8Array(nDof);
  for (let n = 0; n < nNode; n++)
    if (nodeActive[n] && !fixed[n]) free[3 * n] = free[3 * n + 1] = free[3 * n + 2] = 1;
  const f = new Float64Array(nDof);
  for (const [n, fx, fy, fz] of loadsRaw) {
    if (!nodeActive[n]) continue;
    f[3 * n] += fx; f[3 * n + 1] += fy; f[3 * n + 2] += fz;
  }
  for (let d = 0; d < nDof; d++) if (!free[d]) f[d] = 0;

  const diag = new Float64Array(nDof);
  for (let a = 0; a < nA; a++) {
    const Ke = KeList[eMat[a]], s = eScale[a];
    for (let q = 0; q < 8; q++)
      for (let c = 0; c < 3; c++) diag[3 * eNodes[a * 8 + q] + c] += s * Ke[(3 * q + c) * 25];
  }
  const invD = new Float64Array(nDof);
  for (let d = 0; d < nDof; d++) if (free[d] && diag[d] > 0) invD[d] = 1 / diag[d];

  const xe = new Float64Array(24);
  const dofs = new Int32Array(24);
  const matvec = (x, y) => {
    y.fill(0);
    for (let a = 0; a < nA; a++) {
      for (let q = 0; q < 8; q++) {
        const n3 = 3 * eNodes[a * 8 + q];
        dofs[3 * q] = n3; dofs[3 * q + 1] = n3 + 1; dofs[3 * q + 2] = n3 + 2;
        xe[3 * q] = x[n3]; xe[3 * q + 1] = x[n3 + 1]; xe[3 * q + 2] = x[n3 + 2];
      }
      const Ke = KeList[eMat[a]], s = eScale[a];
      for (let r = 0; r < 24; r++) {
        let sum = 0;
        const row = r * 24;
        for (let c = 0; c < 24; c++) sum += Ke[row + c] * xe[c];
        y[dofs[r]] += s * sum;
      }
    }
    for (let d = 0; d < nDof; d++) if (!free[d]) y[d] = 0;
  };

  // PCG
  progress({ stage: '求解中', frac: 0.1 });
  const u = new Float64Array(nDof);
  const r = Float64Array.from(f);
  const z = new Float64Array(nDof);
  const p = new Float64Array(nDof);
  const Ap = new Float64Array(nDof);
  const dot = (a, b) => { let s = 0; for (let i = 0; i < nDof; i++) s += a[i] * b[i]; return s; };
  const fnorm = Math.sqrt(dot(f, f)) || 1;
  for (let i = 0; i < nDof; i++) z[i] = r[i] * invD[i];
  p.set(z);
  let rz = dot(r, z), iter = 0, rel = Math.sqrt(dot(r, r)) / fnorm;
  const t0 = Date.now();
  while (iter < maxIter && rel > tol) {
    matvec(p, Ap);
    const pAp = dot(p, Ap);
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < nDof; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    for (let i = 0; i < nDof; i++) z[i] = r[i] * invD[i];
    const rzNew = dot(r, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < nDof; i++) p[i] = z[i] + beta * p[i];
    iter++;
    if (iter % 25 === 0) {
      rel = Math.sqrt(dot(r, r)) / fnorm;
      const frac = 0.1 + 0.85 * Math.min(1, Math.log(rel) / Math.log(tol));
      progress({ stage: '求解中', frac, iter, residual: rel });
    }
  }
  rel = Math.sqrt(dot(r, r)) / fnorm;
  if (rel > tol * 10) warnings.push(`求解器未完全收斂（殘差 ${rel.toExponential(2)}）`);

  // 應力（元素中心）
  progress({ stage: '後處理', frac: 0.96 });
  const B0 = bMatrix(0, 0, 0, g.h);
  const Bc = HEX_NODES.map(([a, b, c]) => bMatrix(2 * a - 1, 2 * b - 1, 2 * c - 1, g.h));
  const Ds = parts.map((pp) => dMatrix(pp.E, pp.nu));
  const elemVM = new Float32Array(nElem);
  const nodeVM = new Float32Array(nNode);
  const nodeCnt = new Uint16Array(nNode);
  const eps = new Float64Array(6), sig = new Float64Array(6);
  const partStats = parts.map((pp) => ({ name: pp.name, elements: 0, maxVM: 0, maxU: 0 }));
  const stressAt = (B, D) => {
    for (let i = 0; i < 6; i++) { let s = 0; for (let c = 0; c < 24; c++) s += B[i * 24 + c] * xe[c]; eps[i] = s; }
    for (let i = 0; i < 6; i++) { let s = 0; for (let k = 0; k < 6; k++) s += D[i * 6 + k] * eps[k]; sig[i] = s; }
    return vonMises(sig);
  };
  for (let a = 0; a < nA; a++) {
    for (let q = 0; q < 8; q++) {
      const n3 = 3 * eNodes[a * 8 + q];
      xe[3 * q] = u[n3]; xe[3 * q + 1] = u[n3 + 1]; xe[3 * q + 2] = u[n3 + 2];
    }
    const D = Ds[eMat[a]];
    elemVM[active[a]] = stressAt(B0, D);
    const ps = partStats[eMat[a]];
    ps.elements++;
    for (let q = 0; q < 8; q++) {
      const n = eNodes[a * 8 + q];
      const vm = stressAt(Bc[q], D); // 於元素角點計算，再於節點平均
      nodeVM[n] += vm; nodeCnt[n]++;
      if (vm > ps.maxVM) ps.maxVM = vm;
      const um = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
      if (um > ps.maxU) ps.maxU = um;
    }
  }
  let maxVM = Math.max(...partStats.map((s) => s.maxVM)), maxU = 0;
  for (let n = 0; n < nNode; n++) {
    if (nodeCnt[n]) nodeVM[n] /= nodeCnt[n];
    const um = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
    if (um > maxU) maxU = um;
  }
  let reaction = 0;
  for (const [, fx, fy, fz] of loadsRaw) reaction += Math.hypot(fx, fy, fz);

  progress({ stage: '完成', frac: 1 });
  return {
    grid: g,
    nodeActive,
    nodeU: Float32Array.from(u),
    nodeVM,
    elemVM,
    elemPart,
    partStats,
    stats: {
      elements: nA,
      nodes: nodeActive.reduce((s, v) => s + v, 0),
      dofs: free.reduce((s, v) => s + v, 0),
      iterations: iter,
      residual: rel,
      maxVM, maxU,
      seconds: (Date.now() - t0) / 1000,
      h: g.h,
    },
    warnings,
  };
}
