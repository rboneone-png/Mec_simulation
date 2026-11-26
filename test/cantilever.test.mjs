import { runAnalysis } from '../src/fea/solve.js';

export function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  // 外法向的 12 個三角形
  const quads = { '-x': [0, 4, 6, 2], '+x': [1, 3, 7, 5], '-y': [0, 1, 5, 4], '+y': [2, 6, 7, 3], '-z': [0, 2, 3, 1], '+z': [4, 5, 7, 6] };
  const faces = {};
  for (const [k, [a, b, c, d]] of Object.entries(quads))
    faces[k] = new Float32Array([...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d)]);
  const all = new Float32Array(Object.values(faces).flatMap((f) => [...f]));
  return { all, faces };
}

const L = 200, b = 20, t = 20, F = 100, E = 200000;
const beam = boxTris(0, 0, 0, L, b, t);
const I = (b * t ** 3) / 12;
const exact = (F * L ** 3) / (3 * E * I);
for (const res of [40, 80]) {
  const r = runAnalysis({
    parts: [{ name: 'beam', positions: beam.all, E, nu: 0.3 }],
    resolution: res, tol: 1e-8,
    bcs: [
      { type: 'fixed', tris: beam.faces['-x'] },
      { type: 'force', tris: beam.faces['+x'], vector: [0, 0, -F] },
    ],
  });
  const sigmaExact = (F * L * (t / 2)) / I;
  console.log(`res=${res} elems=${r.stats.elements} iter=${r.stats.iterations} t=${r.stats.seconds}s`);
  console.log(`  δ FEA=${r.stats.maxU.toFixed(4)} 理論=${exact.toFixed(4)} 比=${(r.stats.maxU / exact).toFixed(3)}`);
  console.log(`  σmax FEA=${r.stats.maxVM.toFixed(1)} 理論根部=${sigmaExact.toFixed(1)}`, r.warnings);
}

// 兩件組合：未接觸的第二件應被排除
const b2 = boxTris(300, 0, 0, 320, 20, 20);
const r2 = runAnalysis({
  parts: [{ name: 'beam', positions: beam.all, E, nu: 0.3 }, { name: 'floating', positions: b2.all, E, nu: 0.3 }],
  resolution: 40, bcs: [{ type: 'fixed', tris: beam.faces['-x'] }, { type: 'force', tris: beam.faces['+x'], vector: [0, 0, -F] }],
});
console.log('floating test warnings:', r2.warnings, r2.partStats.map((p) => p.elements));
