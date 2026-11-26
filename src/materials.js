// 材料庫（典型值，單位：E [MPa]、強度 [MPa]、密度 [kg/m³]）
// εu：均勻伸長率（對應抗拉強度）、εf：斷裂應變
export const MATERIALS = {
  steel: { name: '結構鋼 A36', E: 200000, nu: 0.3, sy: 250, su: 400, eu: 0.18, ef: 0.25, rho: 7850 },
  sus304: { name: '不鏽鋼 SUS304', E: 193000, nu: 0.29, sy: 215, su: 505, eu: 0.45, ef: 0.55, rho: 8000 },
  s45c: { name: '碳鋼 S45C', E: 205000, nu: 0.29, sy: 490, su: 690, eu: 0.12, ef: 0.17, rho: 7850 },
  al6061: { name: '鋁合金 6061-T6', E: 68900, nu: 0.33, sy: 276, su: 310, eu: 0.08, ef: 0.12, rho: 2700 },
  al7075: { name: '鋁合金 7075-T6', E: 71700, nu: 0.33, sy: 503, su: 572, eu: 0.09, ef: 0.11, rho: 2810 },
  ti64: { name: '鈦合金 Ti-6Al-4V', E: 113800, nu: 0.342, sy: 880, su: 950, eu: 0.1, ef: 0.14, rho: 4430 },
  copper: { name: '純銅 C11000', E: 115000, nu: 0.31, sy: 69, su: 220, eu: 0.4, ef: 0.5, rho: 8900 },
  abs: { name: 'ABS 塑膠', E: 2300, nu: 0.35, sy: 40, su: 44, eu: 0.04, ef: 0.1, rho: 1050 },
};

export function cloneMaterial(key) {
  return { key, ...MATERIALS[key] };
}

/** 工程應力-應變曲線（彈性 → 加工硬化 → 頸縮） */
export function stressStrainCurve(m, n = 200) {
  const ey = m.sy / m.E;
  const eu = Math.max(m.eu, ey * 1.5);
  const ef = Math.max(m.ef, eu * 1.05);
  const sf = m.su * 0.85;
  const pts = [[0, 0], [ey, m.sy]];
  for (let i = 1; i <= n; i++) {
    const e = ey + ((ef - ey) * i) / n;
    let s;
    if (e <= eu) {
      const x = (e - ey) / (eu - ey);
      s = m.sy + (m.su - m.sy) * (1 - (1 - x) ** 2);
    } else {
      const x = (e - eu) / (ef - eu);
      s = m.su - (m.su - sf) * x * x;
    }
    pts.push([e, s]);
  }
  return { pts, ey, eu, ef };
}
