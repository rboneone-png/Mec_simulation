// 插入力計算（解析法）：壓入配合（干涉配合）與懸臂卡扣
// 單位：mm、N、MPa。材料非線性以應力-應變曲線（變形理論／割線模數）處理，摩擦以庫倫摩擦計。
import { stressStrainCurve } from './materials.js';

const D2R = Math.PI / 180;

/** 材料曲線工具：σ(ε)、ε(σ)（僅上升段，至抗拉強度） */
export function curveTools(m) {
  const { pts, ey, ef } = stressStrainCurve(m, 400);
  let iu = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[iu][1]) iu = i;
  const up = pts.slice(0, iu + 1);
  const sMax = up[iu][1], eMaxUp = up[iu][0];
  const sigma = (e) => {
    e = Math.abs(e);
    if (e >= ef) return pts[pts.length - 1][1];
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= e) lo = mid; else hi = mid; }
    const [e0, s0] = pts[lo], [e1, s1] = pts[hi];
    return s0 + ((s1 - s0) * (e - e0)) / (e1 - e0 || 1);
  };
  const strain = (s) => {
    if (s <= 0) return 0;
    if (s >= sMax) return eMaxUp;
    let lo = 0, hi = up.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (up[mid][1] <= s) lo = mid; else hi = mid; }
    const [e0, s0] = up[lo], [e1, s1] = up[hi];
    return e0 + ((e1 - e0) * (s - s0)) / (s1 - s0 || 1);
  };
  return { sigma, strain, sMax, eMaxUp, ey, ef };
}

/** 割線狀態：等效應力 → 割線模數、等效蒲松比（塑性時趨近 0.5） */
function secant(T, m, vm, linear) {
  if (linear || vm <= 0) return { E: m.E, nu: m.nu, eps: vm / m.E };
  const eps = Math.max(T.strain(vm), vm / m.E);
  const E = vm / eps;
  return { E, nu: 0.5 - (0.5 - m.nu) * (E / m.E), eps };
}

// ====================================================================
// 壓入配合（厚壁圓筒 Lamé 解 + 割線模數）
// ====================================================================
/**
 * p: { shaft, hub（材料）, d 公稱直徑, D 軸套外徑, di 軸內徑（0＝實心）, L 軸套長度,
 *      S 壓入深度（圓柱段嚙合長度）, delta 直徑干涉量, alpha 導角角度 [°], mu 摩擦係數, linear 線彈性 }
 */
export function pressFit(p) {
  const { shaft, hub, d, D, L, delta, mu } = p;
  const di = p.di || 0;
  const S = Math.min(p.S ?? L, L);
  const warnings = [];
  if (!(d > 0 && D > d && L > 0 && delta >= 0 && di >= 0 && di < d)) throw new Error('尺寸不合理：需 0 ≤ 軸內徑 < 公稱直徑 < 軸套外徑，且長度 > 0');
  const Kh = (D * D + d * d) / (D * D - d * d);
  const Ks = di > 0 ? (d * d + di * di) / (d * d - di * di) : 1;
  const ch = Math.sqrt(Kh * Kh + Kh + 1); // 軸套內壁 σvm / p（σθ = Kh·p、σr = −p、平面應力）
  const cs = di > 0 ? (2 * d * d) / (d * d - di * di) : 1; // 軸 σvm / p（空心取內壁）
  const Th = curveTools(hub), Ts = curveTools(shaft);

  const state = (pr, linear) => {
    const H = secant(Th, hub, ch * pr, linear), Sh = secant(Ts, shaft, cs * pr, linear);
    const dd = pr * d * ((Kh + H.nu) / H.E + (Ks - Sh.nu) / Sh.E);
    return { p: pr, delta: dd, hub: { vm: ch * pr, ...H }, shaft: { vm: cs * pr, ...Sh } };
  };
  // 任一零件達抗拉強度時的極限壓力
  const pMax = Math.min(Th.sMax / ch, Ts.sMax / cs);
  const solve = (dl, linear = !!p.linear) => {
    if (dl <= 0) return state(0, linear);
    if (linear) { const s1 = state(1, true); return state(dl / s1.delta, true); }
    const top = state(pMax, false);
    if (dl >= top.delta) return { ...top, over: true };
    let lo = 0, hi = pMax;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (state(mid, false).delta < dl) lo = mid; else hi = mid; }
    return state((lo + hi) / 2, false);
  };
  const fin = solve(delta);
  const el = solve(delta, true);
  if (fin.over) warnings.push('干涉量過大：零件應力已達抗拉強度，結果以極限壓力計算（實際可能破裂或嚴重塑性變形）');
  if (!p.linear) {
    if (fin.hub.vm > hub.sy) warnings.push(`軸套內壁已降伏（σvm ${fin.hub.vm.toFixed(0)} > σy ${hub.sy} MPa），配合壓力低於線彈性估算`);
    if (fin.shaft.vm > shaft.sy) warnings.push(`軸已降伏（σvm ${fin.shaft.vm.toFixed(0)} > σy ${shaft.sy} MPa）`);
  } else if (el.hub.vm > hub.sy || el.shaft.vm > shaft.sy) warnings.push('線彈性模式：應力已超過降伏強度，結果偏高，建議改用「依應力-應變曲線」');

  // 導角：軸端圓錐角 α（相對軸線），導角上干涉量由 0 線性增加到 δ
  const alpha = Math.min(Math.max(p.alpha ?? 15, 0.5), 89) * D2R;
  const ta = Math.tan(alpha);
  const c = delta / 2 / ta; // 有效導角軸向長度
  const lock = 1 - mu * ta;
  const wedge = lock > 0.02 ? (ta + mu) / lock : Infinity;
  if (!Number.isFinite(wedge)) warnings.push(`導角自鎖：μ·tanα ≥ 1（α = ${(alpha / D2R).toFixed(1)}°），軸無法壓入，請減小導角角度或摩擦係數`);

  // 插入力曲線：軸前端位於 x（自軸套入口起算），導角區 [x−c, x]、圓柱區 (−∞, x−c]，與軸套 [0, L] 重疊部分
  const xEnd = S + c;
  const makeCurve = (linear) => {
    const pEnd = linear ? el.p : fin.p;
    // 局部壓力 P(δ局部)：先建表再內插
    const NT = 48;
    const tab = Array.from({ length: NT + 1 }, (_, i) => solve((delta * i) / NT, linear).p);
    const P = (dl) => { const t = Math.min(Math.max(dl / (delta || 1), 0), 1) * NT; const i = Math.min(Math.floor(t), NT - 1); return tab[i] + (tab[i + 1] - tab[i]) * (t - i); };
    const force = (x) => {
      let F = mu * pEnd * Math.PI * d * Math.max(0, Math.min(x - c, L));
      const z0 = Math.max(x - c, 0), z1 = Math.min(x, L);
      if (z1 > z0 && c > 0) {
        const n = 24;
        let s = 0;
        for (let k = 0; k < n; k++) { const z = z0 + ((k + 0.5) * (z1 - z0)) / n; s += P((delta * (x - z)) / c); }
        F += wedge * Math.PI * d * s * ((z1 - z0) / n);
      }
      return F;
    };
    const N = 120;
    return Array.from({ length: N + 1 }, (_, i) => { const x = (xEnd * i) / N; return [x, force(x)]; });
  };
  const curve = makeCurve(!!p.linear);
  const curveLinear = p.linear ? curve : makeCurve(true);
  const Fmax = curve.reduce((a, q) => Math.max(a, q[1]), 0);
  const area = Math.PI * d * S;
  const Fpull = mu * fin.p * area;
  const torque = (Fpull * d) / 2 / 1000; // N·m
  const work = curve.reduce((a, q, i) => (i ? a + ((q[1] + curve[i - 1][1]) / 2) * (q[0] - curve[i - 1][0]) : 0), 0) / 1000; // J

  return {
    kind: 'press', p: fin.p, pLinear: el.p, Fmax, Fpull, torque, work, c, xEnd, curve, warnings,
    curveLinear, FmaxLinear: curveLinear.reduce((a, q) => Math.max(a, q[1]), 0),
    hub: { ...fin.hub, hoop: Kh * fin.p, radial: -fin.p, sy: hub.sy, su: hub.su, sf: hub.sy / Math.max(fin.hub.vm, 1e-9) },
    shaft: { ...fin.shaft, sy: shaft.sy, su: shaft.su, sf: shaft.sy / Math.max(fin.shaft.vm, 1e-9) },
    // 軸套外徑膨脹量（直徑，外緣以彈性計）
    hubGrowth: (2 * fin.p * d * d * D) / (hub.E * (D * D - d * d)),
  };
}

// ====================================================================
// 懸臂卡扣（矩形等截面，彎矩-曲率依應力-應變曲線積分）
// ====================================================================
/**
 * p: { mat, L 懸臂長, h 根部厚度, b 寬度, y 卡勾高度（撓度）, alpha 插入角 [°], alpha2 退出角 [°], mu, linear }
 */
export function snapFit(p) {
  const { mat, L, h, b, y: Y, mu } = p;
  if (!(L > 0 && h > 0 && b > 0 && Y >= 0)) throw new Error('尺寸不合理：長度、厚度、寬度需大於 0');
  const warnings = [];
  const T = curveTools(mat);
  const c = h / 2;
  // 彎矩-曲率表 M(κ) = 2b ∫0^c σ(κz) z dz（拉壓對稱）
  const kMax = T.ef / c;
  const NK = 300;
  const kap = [], mom = [];
  for (let i = 0; i <= NK; i++) {
    const k = (kMax * i) / NK;
    let M = 0;
    if (p.linear) M = (mat.E * k * b * h * h * h) / 12;
    else {
      const n = 40;
      for (let j = 0; j < n; j++) { const z = ((j + 0.5) * c) / n; M += T.sigma(k * z) * z; }
      M *= (2 * b * c) / n;
    }
    kap.push(k); mom.push(M);
  }
  // 僅取遞增段做反查
  let im = 0;
  for (let i = 1; i <= NK; i++) if (mom[i] > mom[im]) im = i;
  const Mlim = mom[im];
  const kOf = (M) => {
    if (p.linear) return (12 * M) / (mat.E * b * h * h * h);
    if (M >= Mlim) return Infinity;
    let lo = 0, hi = im;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (mom[mid] <= M) lo = mid; else hi = mid; }
    return kap[lo] + ((kap[hi] - kap[lo]) * (M - mom[lo])) / (mom[hi] - mom[lo] || 1);
  };
  // 尖端撓度 y(P) = ∫0^L κ(P·s)·s ds（s 為距尖端距離）
  const defl = (P) => {
    const n = 60;
    let y = 0;
    for (let i = 0; i < n; i++) { const s = ((i + 0.5) * L) / n; const k = kOf(P * s); if (!Number.isFinite(k)) return Infinity; y += k * s; }
    return (y * L) / n;
  };
  const Plim = Mlim / L;
  const Pof = (y) => {
    if (y <= 0) return { P: 0, over: false };
    if (p.linear) return { P: (3 * mat.E * (b * h ** 3) / 12 * y) / L ** 3, over: false };
    let lo = 0, hi = Plim * 0.999999;
    if (defl(hi) < y) return { P: hi, over: true };
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (defl(mid) < y) lo = mid; else hi = mid; }
    return { P: (lo + hi) / 2, over: false };
  };
  const fin = Pof(Y);
  const kRoot = kOf(fin.P * L);
  const eps = (p.linear ? (1.5 * h * Y) / (L * L) : kRoot * c);
  const sRoot = p.linear ? mat.E * eps : T.sigma(eps);
  const Pel = (3 * mat.E * (b * h ** 3) / 12 * Y) / L ** 3;
  const epsEl = (1.5 * h * Y) / (L * L);
  if (fin.over) warnings.push('撓度過大：根部已達材料極限（彎矩無法再增加），卡扣可能斷裂');
  else if (eps > T.ef) warnings.push('根部應變超過斷裂應變，卡扣會斷裂');
  if (eps > T.ey) warnings.push(`根部應變 ${(eps * 100).toFixed(2)}% 超過降伏應變 ${(T.ey * 100).toFixed(2)}%，卡扣可能產生永久變形`);
  if (mat.brittle && eps > T.ey * 0.6) warnings.push('脆性材料：建議根部應變控制在降伏應變的 60% 以下');

  const wedge = (a) => { const t = Math.tan(Math.min(Math.max(a, 0.5), 89.9) * D2R); const l = 1 - mu * t; return l > 0.02 ? (mu + t) / l : Infinity; };
  const wIn = wedge(p.alpha ?? 30), wOut = wedge(p.alpha2 ?? 90);
  if (!Number.isFinite(wIn)) warnings.push('插入面自鎖：μ·tanα ≥ 1，無法插入，請減小插入角或摩擦係數');
  const tIn = Math.tan(Math.min(Math.max(p.alpha ?? 30, 0.5), 89.9) * D2R);
  const xEnd = Y / tIn;
  const N = 60;
  const curve = [];
  for (let i = 0; i <= N; i++) { const x = (xEnd * i) / N; curve.push([x, Pof((Y * i) / N).P * wIn]); }
  // 卡勾頂部平面滑過（μ·P），再卡入
  const flat = Math.max(xEnd * 0.15, 0.2);
  curve.push([xEnd + 1e-6, fin.P * mu], [xEnd + flat, fin.P * mu], [xEnd + flat + 1e-6, 0]);
  const curveLinear = p.linear ? curve : curve.map(([x], i) => [x, i <= N ? (Pel * i / N) * wIn : i < N + 3 ? Pel * mu : 0]);
  const Fin = fin.P * wIn;
  const Fout = fin.P * wOut;
  return {
    kind: 'snap', P: fin.P, Pel, Fin, Fout, FinLinear: Pel * wIn, curveLinear, eps, epsEl, sRoot, xEnd, curve, warnings,
    ey: T.ey, eu: T.eMaxUp, ef: T.ef, selfLockOut: !Number.isFinite(wOut),
    work: curve.reduce((a, q, i) => (i ? a + ((q[1] + curve[i - 1][1]) / 2) * (q[0] - curve[i - 1][0]) : 0), 0) / 1000,
  };
}
