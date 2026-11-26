// 通用靜力求解器：線彈性 / J2 彈塑性（Newton-Raphson、負載增量、自動減步）
// 單位：mm、N、MPa
import { ELEMENTS, precomputeGeometry } from './elements.js';
import { updateJ2, elasticD, hardeningTable, vonMises } from './plasticity.js';

/** 依節點相鄰關係建立 3×3 區塊 CSR */
function buildCSR(nNode, elems, nen, act) {
  const nbr = Array.from({ length: nNode }, () => null);
  for (const e of act) {
    const o = e * nen;
    for (let a = 0; a < nen; a++) {
      const na = elems[o + a];
      let s = nbr[na];
      if (!s) s = nbr[na] = new Set();
      for (let b = 0; b < nen; b++) s.add(elems[o + b]);
    }
  }
  const rowPtr = new Int32Array(nNode + 1);
  for (let n = 0; n < nNode; n++) rowPtr[n + 1] = rowPtr[n] + (nbr[n] ? nbr[n].size : 0);
  const col = new Int32Array(rowPtr[nNode]);
  for (let n = 0; n < nNode; n++) {
    if (!nbr[n]) continue;
    const arr = Int32Array.from(nbr[n]).sort();
    col.set(arr, rowPtr[n]);
  }
  const find = (r, c) => {
    let lo = rowPtr[r], hi = rowPtr[r + 1] - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (col[m] === c) return m;
      if (col[m] < c) lo = m + 1; else hi = m - 1;
    }
    return -1;
  };
  const blk = new Int32Array(act.length * nen * nen);
  act.forEach((e, ai) => {
    const o = e * nen;
    for (let a = 0; a < nen; a++)
      for (let b = 0; b < nen; b++) blk[(ai * nen + a) * nen + b] = find(elems[o + a], elems[o + b]);
  });
  return { rowPtr, col, val: new Float64Array(9 * col.length), blk };
}

function csrMul(A, x, y, free) {
  const { rowPtr, col, val } = A;
  const n = rowPtr.length - 1;
  for (let r = 0; r < n; r++) {
    let y0 = 0, y1 = 0, y2 = 0;
    for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) {
      const c = 3 * col[k], v = 9 * k;
      const x0 = x[c], x1 = x[c + 1], x2 = x[c + 2];
      y0 += val[v] * x0 + val[v + 1] * x1 + val[v + 2] * x2;
      y1 += val[v + 3] * x0 + val[v + 4] * x1 + val[v + 5] * x2;
      y2 += val[v + 6] * x0 + val[v + 7] * x1 + val[v + 8] * x2;
    }
    y[3 * r] = free[3 * r] ? y0 : 0;
    y[3 * r + 1] = free[3 * r + 1] ? y1 : 0;
    y[3 * r + 2] = free[3 * r + 2] ? y2 : 0;
  }
}

/** 3×3 區塊 Jacobi 前置條件（受拘束自由度以單位矩陣取代） */
function blockJacobi(A, free) {
  const { rowPtr, col, val } = A;
  const n = rowPtr.length - 1;
  const inv = new Float64Array(9 * n);
  for (let r = 0; r < n; r++) {
    let k = rowPtr[r];
    while (k < rowPtr[r + 1] && col[k] !== r) k++;
    if (k === rowPtr[r + 1]) continue;
    const m = Array.from(val.subarray(9 * k, 9 * k + 9));
    for (let i = 0; i < 3; i++)
      if (!free[3 * r + i]) for (let j = 0; j < 3; j++) { m[3 * i + j] = i === j ? 1 : 0; m[3 * j + i] = i === j ? 1 : 0; }
    const [a, b, c, d, e, f, g, h, ii] = m;
    const det = a * (e * ii - f * h) - b * (d * ii - f * g) + c * (d * h - e * g);
    if (!(Math.abs(det) > 0)) continue;
    const o = 9 * r;
    inv[o] = (e * ii - f * h) / det; inv[o + 1] = (c * h - b * ii) / det; inv[o + 2] = (b * f - c * e) / det;
    inv[o + 3] = (f * g - d * ii) / det; inv[o + 4] = (a * ii - c * g) / det; inv[o + 5] = (c * d - a * f) / det;
    inv[o + 6] = (d * h - e * g) / det; inv[o + 7] = (b * g - a * h) / det; inv[o + 8] = (a * e - b * d) / det;
    for (let i = 0; i < 3; i++) if (!free[3 * r + i]) for (let j = 0; j < 3; j++) { inv[o + 3 * i + j] = 0; inv[o + 3 * j + i] = 0; }
  }
  return (r, z) => {
    for (let q = 0; q < n; q++) {
      const o = 9 * q, r0 = r[3 * q], r1 = r[3 * q + 1], r2 = r[3 * q + 2];
      z[3 * q] = inv[o] * r0 + inv[o + 1] * r1 + inv[o + 2] * r2;
      z[3 * q + 1] = inv[o + 3] * r0 + inv[o + 4] * r1 + inv[o + 5] * r2;
      z[3 * q + 2] = inv[o + 6] * r0 + inv[o + 7] * r1 + inv[o + 8] * r2;
    }
  };
}

/**
 * 不完全 Cholesky IC(0)（純量、零填入），對角位移 α 處理崩潰；失敗則回傳 null
 * 以列方式（left-looking）分解，下三角 CSR 儲存
 */
function incompleteCholesky(A, free) {
  const { rowPtr, col, val } = A;
  const nb = rowPtr.length - 1, n = 3 * nb;
  const lp = new Int32Array(n + 1);
  for (let r = 0; r < nb; r++)
    for (let a = 0; a < 3; a++) {
      const i = 3 * r + a;
      let cnt = 0;
      if (free[i]) for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) { const c = col[k]; if (c > r) break; for (let b2 = 0; b2 < 3; b2++) { const j = 3 * c + b2; if (j < i && free[j]) cnt++; } }
      lp[i + 1] = lp[i] + cnt + 1; // +1：對角
    }
  const lc = new Int32Array(lp[n]);
  const A0 = new Float64Array(lp[n]);
  for (let r = 0; r < nb; r++)
    for (let a = 0; a < 3; a++) {
      const i = 3 * r + a;
      let q = lp[i];
      if (free[i]) {
        for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) {
          const c = col[k];
          if (c > r) break;
          for (let b2 = 0; b2 < 3; b2++) {
            const j = 3 * c + b2;
            if (j < i && free[j]) { lc[q] = j; A0[q++] = val[9 * k + 3 * a + b2]; }
            else if (j === i) A0[lp[i + 1] - 1] = val[9 * k + 3 * a + b2];
          }
        }
      } else A0[lp[i + 1] - 1] = 1;
      lc[lp[i + 1] - 1] = i;
    }
  const lv = new Float64Array(lp[n]);
  const w = new Float64Array(n);
  for (const alpha of [0, 1e-4, 1e-3, 1e-2, 1e-1]) {
    lv.set(A0);
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const s0 = lp[i], dpos = lp[i + 1] - 1;
      for (let q = s0; q < dpos; q++) w[lc[q]] = lv[q];
      let d = lv[dpos] * (1 + alpha);
      for (let q = s0; q < dpos; q++) {
        const j = lc[q];
        let s = w[j];
        const jd = lp[j + 1] - 1;
        for (let t = lp[j]; t < jd; t++) s -= lv[t] * w[lc[t]];
        const l = s / lv[jd];
        w[j] = l; lv[q] = l;
        d -= l * l;
      }
      for (let q = s0; q < dpos; q++) w[lc[q]] = 0;
      if (!(d > 1e-14 * Math.abs(A0[dpos]))) ok = false;
      else lv[dpos] = Math.sqrt(d);
    }
    if (!ok) continue;
    const t = new Float64Array(n);
    return (r, z) => {
      for (let i = 0; i < n; i++) {
        let s = r[i];
        const dpos = lp[i + 1] - 1;
        for (let q = lp[i]; q < dpos; q++) s -= lv[q] * t[lc[q]];
        t[i] = s / lv[dpos];
      }
      for (let i = n - 1; i >= 0; i--) {
        const dpos = lp[i + 1] - 1;
        const zi = (z[i] = t[i] / lv[dpos]);
        for (let q = lp[i]; q < dpos; q++) t[lc[q]] -= lv[q] * zi;
      }
      for (let i = 0; i < n; i++) if (!free[i]) z[i] = 0;
    };
  }
  return null;
}

export function makePreconditioner(A, free) {
  return incompleteCholesky(A, free) || blockJacobi(A, free);
}

function pcg(A, b, x, free, tol, maxIter, onIter, precIn) {
  const n = b.length;
  const prec = precIn || makePreconditioner(A, free);
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  const dot = (a, c) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * c[i]; return s; };
  csrMul(A, x, Ap, free);
  for (let i = 0; i < n; i++) r[i] = free[i] ? b[i] - Ap[i] : 0;
  const bn = Math.sqrt(dot(b, b)) || 1;
  prec(r, z); p.set(z);
  let rz = dot(r, z), it = 0, rel = Math.sqrt(dot(r, r)) / bn;
  while (it < maxIter && rel > tol) {
    csrMul(A, p, Ap, free);
    const pAp = dot(p, Ap);
    if (!(pAp > 0)) break;
    const al = rz / pAp;
    for (let i = 0; i < n; i++) { x[i] += al * p[i]; r[i] -= al * Ap[i]; }
    prec(r, z);
    const rz2 = dot(r, z), be = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + be * p[i];
    it++;
    if (it % 20 === 0) { rel = Math.sqrt(dot(r, r)) / bn; onIter?.(it, rel); }
  }
  rel = Math.sqrt(dot(r, r)) / bn;
  return { iterations: it, residual: rel };
}

/**
 * mesh  = { type, nodes: Float64Array, elems: Int32Array, elemPart: Int32Array }
 * setup = { materials:[{E,nu,sy,su,eu,name}], plastic, steps, loadFactor, fixed: Uint8Array(nDof), F: Float64Array(nDof), tol }
 */
export function solveStatic(mesh, setup, progress = () => {}) {
  const t0 = Date.now();
  const el = ELEMENTS[mesh.type];
  const { nen } = el;
  const ng = el.gauss.length;
  const nNode = mesh.nodes.length / 3, nDof = nNode * 3;
  const ne = mesh.elems.length / nen;
  const { elems, elemPart } = mesh;
  const warnings = [];
  const { fixed, F, materials } = setup;
  const plastic = !!setup.plastic;
  const nSteps = plastic ? Math.max(1, setup.steps | 0) : 1;
  const loadFactor = setup.loadFactor ?? 1;
  const linTol = setup.tol ?? 1e-6;

  // --- 連通性：只保留與固定約束相連的元素 ---
  progress({ stage: '連通性檢查', frac: 0.01 });
  const parent = new Int32Array(nNode).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let e = 0; e < ne; e++) {
    const r0 = find(elems[e * nen]);
    for (let a = 1; a < nen; a++) { const r = find(elems[e * nen + a]); if (r !== r0) parent[r] = r0; }
  }
  const anchored = new Set();
  for (let n = 0; n < nNode; n++) if (fixed[3 * n] || fixed[3 * n + 1] || fixed[3 * n + 2]) anchored.add(find(n));
  if (!anchored.size) throw new Error('至少需要一個「固定約束」才能求解');
  const act = [];
  const dropped = new Set();
  for (let e = 0; e < ne; e++) { if (anchored.has(find(elems[e * nen]))) act.push(e); else dropped.add(elemPart[e]); }
  for (const p of dropped) warnings.push(`零件「${materials[p]?.name ?? p}」的部分或全部區域未連接到固定約束，已排除`);
  if (!act.length) throw new Error('沒有可計算的元素');
  const nA = act.length;

  const used = new Uint8Array(nNode);
  for (const e of act) for (let a = 0; a < nen; a++) used[elems[e * nen + a]] = 1;
  const free = new Uint8Array(nDof);
  for (let n = 0; n < nNode; n++) if (used[n]) for (let d = 0; d < 3; d++) free[3 * n + d] = fixed[3 * n + d] ? 0 : 1;
  const Fe = new Float64Array(nDof);
  for (let d = 0; d < nDof; d++) Fe[d] = free[d] ? F[d] : 0;

  // --- 幾何、材料 ---
  progress({ stage: '元素幾何', frac: 0.03 });
  const actElems = new Int32Array(nA * nen);
  act.forEach((e, i) => actElems.set(elems.subarray(e * nen, e * nen + nen), i * nen));
  const geo = precomputeGeometry(mesh.type, mesh.nodes, actElems);
  if (geo.bad) warnings.push(`${geo.bad} 個元素的 Jacobian 為負或零（網格品質不佳），結果可能失真`);
  const mats = materials.map((m) => ({
    E: m.E, nu: m.nu, D: elasticD(m.E, m.nu), tab: plastic ? hardeningTable(m) : null, sy: m.sy,
  }));

  progress({ stage: '建立稀疏矩陣', frac: 0.05 });
  const A = buildCSR(nNode, elems, nen, act);

  // --- 狀態 ---
  const nGp = nA * ng;
  let epsP = new Float64Array(nGp * 6), alpha = new Float64Array(nGp);
  let epsPN = new Float64Array(nGp * 6), alphaN = new Float64Array(nGp);
  const sigGp = new Float64Array(nGp * 6);

  const eps = new Float64Array(6), sig = new Float64Array(6), Dt = new Float64Array(36), ep6 = new Float64Array(6);
  const DB = new Float64Array(6 * 3 * nen);
  const Ke = new Float64Array(9 * nen * nen);

  /** 由位移 u 計算內力（並視需要組裝切線勁度） */
  const assemble = (u, wantK) => {
    const fint = new Float64Array(nDof);
    if (wantK) A.val.fill(0);
    for (let ai = 0; ai < nA; ai++) {
      const mat = mats[elemPart[act[ai]]];
      const on = ai * nen;
      if (wantK) Ke.fill(0);
      for (let g = 0; g < ng; g++) {
        const gi = ai * ng + g;
        const dn = geo.dNdx.subarray(gi * nen * 3, gi * nen * 3 + nen * 3);
        const w = geo.wdet[gi];
        eps.fill(0);
        for (let a = 0; a < nen; a++) {
          const p = 3 * actElems[on + a];
          const ux = u[p], uy = u[p + 1], uz = u[p + 2];
          const dx = dn[3 * a], dy = dn[3 * a + 1], dz = dn[3 * a + 2];
          eps[0] += dx * ux; eps[1] += dy * uy; eps[2] += dz * uz;
          eps[3] += dy * ux + dx * uy; eps[4] += dz * uy + dy * uz; eps[5] += dz * ux + dx * uz;
        }
        alphaN[gi] = updateJ2(mat, eps, epsP.subarray(gi * 6, gi * 6 + 6), alpha[gi], sig, ep6, wantK ? Dt : null);
        epsPN.set(ep6, gi * 6);
        sigGp.set(sig, gi * 6);
        for (let a = 0; a < nen; a++) {
          const dx = dn[3 * a], dy = dn[3 * a + 1], dz = dn[3 * a + 2];
          const p = 3 * actElems[on + a];
          fint[p] += w * (dx * sig[0] + dy * sig[3] + dz * sig[5]);
          fint[p + 1] += w * (dy * sig[1] + dx * sig[3] + dz * sig[4]);
          fint[p + 2] += w * (dz * sig[2] + dy * sig[4] + dx * sig[5]);
        }
        if (!wantK) continue;
        // DB = Dt · B
        for (let a = 0; a < nen; a++) {
          const dx = dn[3 * a], dy = dn[3 * a + 1], dz = dn[3 * a + 2];
          for (let k = 0; k < 6; k++) {
            const r = k * 6;
            const o = k * 3 * nen + 3 * a;
            DB[o] = Dt[r] * dx + Dt[r + 3] * dy + Dt[r + 5] * dz;
            DB[o + 1] = Dt[r + 1] * dy + Dt[r + 3] * dx + Dt[r + 4] * dz;
            DB[o + 2] = Dt[r + 2] * dz + Dt[r + 4] * dy + Dt[r + 5] * dx;
          }
        }
        // Ke += Bᵀ · DB · w
        const C = 3 * nen;
        for (let a = 0; a < nen; a++) {
          const dx = dn[3 * a] * w, dy = dn[3 * a + 1] * w, dz = dn[3 * a + 2] * w;
          for (let j = 0; j < C; j++) {
            const d0 = DB[j], d1 = DB[C + j], d2 = DB[2 * C + j], d3 = DB[3 * C + j], d4 = DB[4 * C + j], d5 = DB[5 * C + j];
            Ke[(3 * a) * C + j] += dx * d0 + dy * d3 + dz * d5;
            Ke[(3 * a + 1) * C + j] += dy * d1 + dx * d3 + dz * d4;
            Ke[(3 * a + 2) * C + j] += dz * d2 + dy * d4 + dx * d5;
          }
        }
      }
      if (!wantK) continue;
      const C = 3 * nen;
      for (let a = 0; a < nen; a++)
        for (let b = 0; b < nen; b++) {
          const v = 9 * A.blk[(ai * nen + a) * nen + b];
          for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++) A.val[v + 3 * i + j] += Ke[(3 * a + i) * C + 3 * b + j];
        }
    }
    return fint;
  };

  const norm = (v) => { let s = 0; for (let i = 0; i < v.length; i++) if (free[i]) s += v[i] * v[i]; return Math.sqrt(s); };
  const Fn = norm(Fe) || 1;

  // --- 節點後處理 ---
  const nodeOut = (u) => {
    const vm = new Float32Array(nNode), pe = new Float32Array(nNode), cnt = new Uint16Array(nNode);
    const gv = new Float64Array(ng), ga = new Float64Array(ng), nv = new Float64Array(nen), na = new Float64Array(nen);
    for (let ai = 0; ai < nA; ai++) {
      for (let g = 0; g < ng; g++) {
        const gi = ai * ng + g;
        gv[g] = vonMises(sigGp.subarray(gi * 6, gi * 6 + 6));
        ga[g] = alpha[gi];
      }
      el.extrapolate(gv, nv); el.extrapolate(ga, na);
      for (let a = 0; a < nen; a++) {
        const n = actElems[ai * nen + a];
        vm[n] += Math.max(0, nv[a]); pe[n] += Math.max(0, na[a]); cnt[n]++;
      }
    }
    const partMaxVM = new Float64Array(materials.length), partMaxU = new Float64Array(materials.length), partMaxPE = new Float64Array(materials.length);
    for (let n = 0; n < nNode; n++) if (cnt[n]) { vm[n] /= cnt[n]; pe[n] /= cnt[n]; }
    for (let ai = 0; ai < nA; ai++) {
      const p = elemPart[act[ai]];
      for (let a = 0; a < nen; a++) {
        const n = actElems[ai * nen + a];
        if (vm[n] > partMaxVM[p]) partMaxVM[p] = vm[n];
        if (pe[n] > partMaxPE[p]) partMaxPE[p] = pe[n];
        const um = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
        if (um > partMaxU[p]) partMaxU[p] = um;
      }
    }
    let reaction = [0, 0, 0];
    return { vm, pe, partMaxVM, partMaxU, partMaxPE, reaction };
  };

  // --- 增量 Newton-Raphson ---
  const u = new Float64Array(nDof);
  const steps = [];
  let lamDone = 0, totalNewton = 0, totalCG = 0, lastRes = 0;
  let dLam = loadFactor / nSteps, cuts = 0;
  const lamTarget = (k) => (loadFactor * k) / nSteps;
  let k = 1;
  const nlTol = 1e-4;
  const uSave = new Float64Array(nDof);
  let prec = null;
  const lastInc = new Float64Array(nDof); // 上一收斂步的位移增量（預測用）
  let lastDLam = 0;
  while (k <= nSteps) {
    const lam = Math.min(lamDone + dLam, lamTarget(k));
    uSave.set(u);
    let converged = false, it = 0;
    const maxIt = plastic ? 15 : 1;
    let prevRn = Infinity;
    for (; it < maxIt; it++) {
      const fint = assemble(u, true);
      const r = new Float64Array(nDof);
      for (let d = 0; d < nDof; d++) r[d] = free[d] ? lam * Fe[d] - fint[d] : 0;
      const rn = norm(r) / (lam * Fn);
      lastRes = rn;
      if (it > 0 && rn < nlTol) { converged = true; break; }
      // 發散判斷：殘差非有限、暴增，或多次迭代後仍無明顯下降
      if (!Number.isFinite(rn) || (it > 2 && rn > 10 * prevRn) || (it >= 8 && rn > 1e-2)) break;
      prevRn = rn;
      const du = new Float64Array(nDof);
      // 熱啟動：每步第一次迭代以前一步增量（依負載增量比例縮放）作為初始猜測
      if (plastic && it === 0 && lastDLam > 0) { const sc = (lam - lamDone) / lastDLam; for (let d = 0; d < nDof; d++) du[d] = lastInc[d] * sc; }
      // 非精確 Newton：線性求解容許誤差隨殘差調整（收斂仍以真實殘差判斷）
      const cgTol = plastic ? Math.min(1e-2, Math.max(linTol, (0.3 * nlTol) / Math.max(rn, 1e-12))) : linTol;
      const cgMax = plastic ? Math.max(3000, Math.round(Math.sqrt(nDof) * 40)) : 50000;
      // 前置條件：每個負載步只分解一次，Newton 迭代間重複使用（切線矩陣變化不大）
      if (it === 0 || !prec) prec = makePreconditioner(A, free);
      const res = pcg(A, r, du, free, cgTol, cgMax, (ci, cr) =>
        progress({ stage: plastic ? `負載步 ${k}/${nSteps}・Newton ${it + 1}` : '求解線性系統', frac: 0.08 + (0.85 * (lamDone + (lam - lamDone) * 0.5)) / loadFactor, iter: ci, residual: cr }), prec);
      totalCG += res.iterations;
      if (plastic && !(res.residual < Math.max(0.05, cgTol * 5))) break; // 切線矩陣近奇異（接近極限負載）
      for (let d = 0; d < nDof; d++) u[d] += du[d];
      totalNewton++;
      if (!plastic) { assemble(u, false); converged = true; lastRes = res.residual; break; }
    }
    if (!converged && plastic) {
      // 最後再檢查一次殘差
      const fint = assemble(u, false);
      let s = 0;
      for (let d = 0; d < nDof; d++) if (free[d]) s += (lam * Fe[d] - fint[d]) ** 2;
      lastRes = Math.sqrt(s) / (lam * Fn);
      converged = lastRes < nlTol * 10;
    }
    if (!converged) {
      u.set(uSave);
      if (++cuts > 6) { warnings.push(`負載因子 ${lam.toPrecision(3)} 無法收斂（可能已達極限負載／結構崩塌），分析提前終止`); break; }
      dLam /= 2;
      progress({ stage: `未收斂，減步重算（Δλ=${dLam.toPrecision(3)}）`, frac: 0.08 + (0.85 * lamDone) / loadFactor });
      continue;
    }
    // 收斂：提交狀態
    [epsP, epsPN] = [epsPN, epsP];
    [alpha, alphaN] = [alphaN, alpha];
    for (let d = 0; d < nDof; d++) lastInc[d] = u[d] - uSave[d];
    lastDLam = lam - lamDone;
    lamDone = lam;
    if (Math.abs(lam - lamTarget(k)) < 1e-12 * loadFactor) {
      const o = nodeOut(u);
      let maxU = 0;
      for (let n = 0; n < nNode; n++) if (used[n]) maxU = Math.max(maxU, Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]));
      steps.push({
        lambda: lam, u: Float32Array.from(u), vm: o.vm, pe: o.pe,
        partMaxVM: Array.from(o.partMaxVM), partMaxU: Array.from(o.partMaxU), partMaxPE: Array.from(o.partMaxPE),
        maxU, maxVM: Math.max(...o.partMaxVM), maxPE: Math.max(...o.partMaxPE), newton: it,
      });
      k++;
      dLam = loadFactor / nSteps;
      cuts = 0;
    }
  }
  if (!steps.length) throw new Error('第一個負載步即無法收斂，請降低負載或檢查邊界條件');

  const partElems = new Array(materials.length).fill(0);
  for (const e of act) partElems[elemPart[e]]++;
  progress({ stage: '完成', frac: 1 });
  return {
    steps,
    used,
    partElems,
    warnings,
    stats: {
      type: mesh.type, elements: nA, nodes: used.reduce((s, v) => s + v, 0), dofs: free.reduce((s, v) => s + v, 0),
      newton: totalNewton, cg: totalCG, residual: lastRes, seconds: (Date.now() - t0) / 1000, plastic,
    },
  };
}
