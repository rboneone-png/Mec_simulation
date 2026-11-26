// 小應變 J2（von Mises）彈塑性，等向硬化（分段線性硬化曲線），徑向回歸 + 一致切線
// Voigt：[xx, yy, zz, xy, yz, zx]，應變剪力分量為工程剪應變

/** 由工程應力-應變參數建立 真應力 vs 等效塑性應變 表 */
export function hardeningTable(m, n = 24) {
  const ey = m.sy / m.E;
  const eu = Math.max(m.eu || 0.1, ey * 1.5);
  const ep = [0], sy = [m.sy];
  for (let i = 1; i <= n; i++) {
    const e = ey + ((eu - ey) * i) / n;
    const x = (e - ey) / (eu - ey);
    const se = m.sy + (m.su - m.sy) * (1 - (1 - x) ** 2); // 與 materials.stressStrainCurve 相同
    const st = se * (1 + e); // 真應力
    const et = Math.log(1 + e); // 真應變
    const p = Math.max(ep[ep.length - 1] + 1e-9, et - st / m.E);
    ep.push(p); sy.push(Math.max(sy[sy.length - 1], st));
  }
  return { ep: Float64Array.from(ep), sy: Float64Array.from(sy) };
}

function yieldAt(tab, a) {
  const { ep, sy } = tab;
  const n = ep.length;
  if (a >= ep[n - 1]) return [sy[n - 1], 0]; // 超出表格：理想塑性
  let i = 1;
  while (ep[i] < a) i++;
  const H = (sy[i] - sy[i - 1]) / (ep[i] - ep[i - 1]);
  return [sy[i - 1] + H * (a - ep[i - 1]), H];
}

export function elasticD(E, nu, out = new Float64Array(36)) {
  out.fill(0);
  const c = E / ((1 + nu) * (1 - 2 * nu));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 6 + j] = c * (i === j ? 1 - nu : nu);
  for (let i = 3; i < 6; i++) out[i * 6 + i] = (c * (1 - 2 * nu)) / 2;
  return out;
}

/**
 * 應力更新
 * eps: 總應變；epsP/alpha: 上一個收斂步的塑性應變與等效塑性應變（不修改）
 * 輸出 sig、epsPNew、Dt（切線），回傳新的 alpha
 */
export function updateJ2(mat, eps, epsP, alpha, sig, epsPNew, Dt) {
  const { E, nu, tab, D } = mat;
  const G = E / (2 * (1 + nu));
  // 試探應力
  const ee = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) ee[i] = eps[i] - epsP[i];
  for (let i = 0; i < 6; i++) { let s = 0; for (let k = 0; k < 6; k++) s += D[i * 6 + k] * ee[k]; sig[i] = s; }
  for (let i = 0; i < 6; i++) epsPNew[i] = epsP[i];
  if (!tab) { if (Dt) Dt.set(D); return alpha; }

  const p = (sig[0] + sig[1] + sig[2]) / 3;
  const s0 = sig[0] - p, s1 = sig[1] - p, s2 = sig[2] - p, s3 = sig[3], s4 = sig[4], s5 = sig[5];
  const snorm = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2 + 2 * (s3 * s3 + s4 * s4 + s5 * s5));
  const q = Math.sqrt(1.5) * snorm;
  let [sy, H] = yieldAt(tab, alpha);
  if (q - sy <= 1e-10 * sy) { if (Dt) Dt.set(D); return alpha; }

  // 局部 Newton 求 Δγ
  let dg = 0;
  for (let it = 0; it < 50; it++) {
    [sy, H] = yieldAt(tab, alpha + dg);
    const f = q - 3 * G * dg - sy;
    if (Math.abs(f) < 1e-10 * sy) break;
    dg += f / (3 * G + H);
  }
  [sy, H] = yieldAt(tab, alpha + dg);
  const fac = 1 - (3 * G * dg) / q;
  const s = [s0, s1, s2, s3, s4, s5];
  for (let i = 0; i < 6; i++) sig[i] = s[i] * fac + (i < 3 ? p : 0);
  // 塑性應變增量 Δεp = Δγ · 3/2 · s/q（剪力分量為工程應變 ×2）
  const r = (1.5 * dg) / q;
  for (let i = 0; i < 6; i++) epsPNew[i] = epsP[i] + r * s[i] * (i < 3 ? 1 : 2);

  if (Dt) {
    Dt.set(D);
    const a = 2 * G * ((3 * G * dg) / q);
    const b = 6 * G * G * (dg / q - 1 / (3 * G + H));
    const n = s.map((v) => v / snorm);
    // 2G·I_dev（Voigt，工程剪應變）
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Dt[i * 6 + j] -= a * ((i === j ? 1 : 0) - 1 / 3);
    for (let i = 3; i < 6; i++) Dt[i * 6 + i] -= a * 0.5;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) Dt[i * 6 + j] += b * n[i] * n[j];
  }
  return alpha + dg;
}

export function vonMises(s) {
  return Math.sqrt(0.5 * ((s[0] - s[1]) ** 2 + (s[1] - s[2]) ** 2 + (s[2] - s[0]) ** 2) + 3 * (s[3] ** 2 + s[4] ** 2 + s[5] ** 2));
}
