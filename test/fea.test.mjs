// 求解器驗證：node test/fea.test.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { voxelMesh } from '../src/fea/mesh-voxel.js';
import { gmshMesh } from '../src/fea/mesh-gmsh.js';
import { buildLoads } from '../src/fea/bc.js';
import { solveStatic } from '../src/fea/solver.js';
import { hardeningTable } from '../src/fea/plasticity.js';

const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();
let failed = 0;
const check = (name, val, ref, tol) => {
  const err = Math.abs(val - ref) / Math.abs(ref);
  const ok = err <= tol;
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}: ${val.toPrecision(5)}（參考 ${ref.toPrecision(5)}，誤差 ${(err * 100).toFixed(2)}%）`);
};

/** 用 occt-import-js 讀 STEP，回傳每個實體的 CAD 面（與瀏覽器端相同流程） */
function loadStep(path) {
  const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(path)), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 });
  return r.meshes.map((m, mi) => {
    const P = m.attributes.position.array, I = m.index.array;
    const soup = (t0, t1) => { const o = []; for (let t = t0; t <= t1; t++) for (let k = 0; k < 3; k++) { const v = I[3 * t + k]; o.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); } return Float32Array.from(o); };
    const positions = soup(0, I.length / 3 - 1);
    const faces = m.brep_faces.map((f) => soup(f.first, f.last));
    // 質心與體積
    let V = 0; const c = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(i, i + 9);
      const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      V += v; c[0] += v * (ax + bx + cx) / 4; c[1] += v * (ay + by + cy) / 4; c[2] += v * (az + bz + cz) / 4;
    }
    const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let d = 0; d < 3; d++) { bbox[d] = Math.min(bbox[d], positions[i + d]); bbox[3 + d] = Math.max(bbox[3 + d], positions[i + d]); }
    return { name: `p${mi}`, positions, faces, com: c.map((x) => x / V), volume: V, bbox, fileIdx: 0 };
  });
}
/** 找出中心座標在某軸為極值的面 */
const faceAt = (part, axis, sign) => {
  let best = 0, bv = -Infinity;
  part.faces.forEach((f, i) => {
    let s = 0; for (let k = axis; k < f.length; k += 3) s += f[k];
    const v = (sign * s) / (f.length / 3);
    if (v > bv) { bv = v; best = i; }
  });
  return { part: 0, soup: part.faces[best] };
};

const steel = { name: 'steel', E: 200000, nu: 0.3, sy: 250, su: 400, eu: 0.18 };

// ---------- 1. 懸臂樑（線彈性） ----------
const L = 200, b = 20, t = 20, F = 100;
const I = (b * t ** 3) / 12;
const dRef = (F * L ** 3) / (3 * steel.E * I);
const sRef = (F * L * (t / 2)) / I;
const beam = loadStep('test/data/beam.step');
const beamBCs = (p) => [
  { name: 'fix', type: 'fixed', faces: [faceAt(p, 0, -1)] },
  { name: 'load', type: 'force', vector: [0, 0, -F], faces: [faceAt(p, 0, 1)] },
];

for (const [label, mesh] of [
  ['HEX8 體素 h=2.5', voxelMesh(beam, 2.5)],
  ['TET10 Gmsh h=6', await gmshMesh([{ bytes: fs.readFileSync('test/data/beam.step') }], beam, { size: 6, curvature: false })],
]) {
  const { fixed, F: Fv } = buildLoads(mesh, beamBCs(beam[0]));
  const r = solveStatic(mesh, { materials: [steel], fixed, F: Fv, tol: 1e-8 });
  const s = r.steps[0];
  console.log(`— ${label}：${r.stats.elements} 元素、${r.stats.dofs} 自由度、PCG ${r.stats.cg} 次、${r.stats.seconds}s`);
  check('  懸臂端撓度 δ', s.maxU, dRef, 0.04);
  // 根部表面應力（避開固定端奇異點：取 x = L/4 處的上表面節點）
  let sv = 0;
  for (let n = 0; n < mesh.nodes.length / 3; n++) {
    const [x, , z] = [mesh.nodes[3 * n], mesh.nodes[3 * n + 1], mesh.nodes[3 * n + 2]];
    if (Math.abs(x - L / 4) < 3.5 && z > t - 0.01) sv = Math.max(sv, s.vm[n]);
  }
  check('  x=L/4 上表面彎曲應力', sv, (F * (L - L / 4) * (t / 2)) / I, 0.08);
}

// ---------- 2. 單軸拉伸（彈塑性，TET10） ----------
const bar = loadStep('test/data/bar.step');
const mesh = await gmshMesh([{ bytes: fs.readFileSync('test/data/bar.step') }], bar, { size: 4, curvature: false });
const A = 100, sigma = 330; // 超過降伏 250 MPa
const bcs = [
  { name: 'x0', type: 'fixed', dirs: [true, false, false], faces: [faceAt(bar[0], 0, -1)] },
  { name: 'y0', type: 'fixed', dirs: [false, true, false], faces: [faceAt(bar[0], 1, -1)] },
  { name: 'z0', type: 'fixed', dirs: [false, false, true], faces: [faceAt(bar[0], 2, -1)] },
  { name: 'pull', type: 'force', vector: [sigma * A, 0, 0], faces: [faceAt(bar[0], 0, 1)] },
];
const { fixed, F: Fv } = buildLoads(mesh, bcs);
const r = solveStatic(mesh, { materials: [steel], plastic: true, steps: 8, fixed, F: Fv });
const last = r.steps[r.steps.length - 1];
const tab = hardeningTable(steel);
let epRef = 0;
for (let i = 1; i < tab.ep.length; i++) if (tab.sy[i] >= sigma) { epRef = tab.ep[i - 1] + ((sigma - tab.sy[i - 1]) / (tab.sy[i] - tab.sy[i - 1])) * (tab.ep[i] - tab.ep[i - 1]); break; }
console.log(`— 單軸拉伸 TET10：${r.stats.elements} 元素、Newton ${r.stats.newton} 次、${r.stats.seconds}s、${r.steps.length} 步`);
check('  von Mises = 施加應力', last.maxVM, sigma, 0.01);
check('  等效塑性應變', last.maxPE, epRef, 0.03);
let ux = 0; for (let n = 0; n < mesh.nodes.length / 3; n++) ux = Math.max(ux, last.u[3 * n]);
check('  伸長量 = L(σ/E + εp)', ux, 100 * (sigma / steel.E + epRef), 0.03);

// ---------- 3. 理想塑性超過極限負載 → 應偵測到不收斂 ----------
const epp = { ...steel, su: 250.0001, eu: 0.002 }; // 幾乎無硬化
const r3 = solveStatic(mesh, { materials: [epp], plastic: true, steps: 4, fixed, F: Fv.map((v) => v * 1.2) });
const ok3 = r3.warnings.some((w) => w.includes('無法收斂'));
if (!ok3) failed++;
console.log(`${ok3 ? '✔' : '✘'} 超過極限負載時提前終止（完成 ${r3.steps.length}/4 步）`);

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
