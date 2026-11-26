// 求解器驗證：node test/fea.test.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { voxelMesh } from '../src/fea/mesh-voxel.js';
import { tetwildMesh } from '../src/fea/mesh-tetwild.js';
import { hexMesh } from '../src/fea/mesh-hex.js';
import { detectInterfaces, applyInterfaces } from '../src/fea/contact.js';
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
    const faceOfTri = new Int32Array(I.length / 3);
    m.brep_faces.forEach((f, fi) => { for (let t = f.first; t <= f.last; t++) faceOfTri[t] = fi; });
    // 質心與體積
    let V = 0; const c = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.subarray(i, i + 9);
      const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      V += v; c[0] += v * (ax + bx + cx) / 4; c[1] += v * (ay + by + cy) / 4; c[2] += v * (az + bz + cz) / 4;
    }
    const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let d = 0; d < 3; d++) { bbox[d] = Math.min(bbox[d], positions[i + d]); bbox[3 + d] = Math.max(bbox[3 + d], positions[i + d]); }
    return { name: `p${mi}`, positions, faces, faceOfTri, com: c.map((x) => x / V), volume: V, bbox, fileIdx: 0 };
  });
}
/** 找出中心座標在某軸為極值的面 */
const faceAt = (part, axis, sign, pi = 0) => {
  let best = 0, bv = -Infinity;
  part.faces.forEach((f, i) => {
    let s = 0; for (let k = axis; k < f.length; k += 3) s += f[k];
    const v = (sign * s) / (f.length / 3);
    if (v > bv) { bv = v; best = i; }
  });
  return { part: pi, faceId: best, soup: part.faces[best] };
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
  ['HEX20 貼體 h=5', hexMesh(beam, { size: 5, order: 2 })],
  ['HEX8 貼體 h=2.5', hexMesh(beam, { size: 2.5, order: 1 })],
  ['TET10 fTetWild h=6', await tetwildMesh(beam, { size: 6 })],
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

// ---------- 1b. 圓棒懸臂（曲面）----------
const rod = loadStep('test/data/rod.step');
const Ir = (Math.PI * 10 ** 4) / 4, dRod = (F * L ** 3) / (3 * steel.E * Ir);
for (const [label, mk] of [['HEX20 貼體 h=4', () => hexMesh(rod, { size: 4, order: 2 })], ['TET10 fTetWild h=5', () => tetwildMesh(rod, { size: 5 })]]) {
  const mesh = await mk();
  const { fixed, F: Fv } = buildLoads(mesh, beamBCs(rod[0]));
  const r = solveStatic(mesh, { materials: [steel], fixed, F: Fv, tol: 1e-8 });
  // 體積檢查（曲面貼合程度）
  let V = 0;
  const { precomputeGeometry } = await import('../src/fea/elements.js');
  const geo = precomputeGeometry(mesh.type, mesh.nodes, mesh.elems);
  for (const w of geo.wdet) V += w;
  console.log(`— 圓棒 ${label}：${r.stats.elements} 元素、${r.stats.dofs} 自由度、${r.stats.seconds}s`);
  check('  網格體積', V, Math.PI * 100 * 200, 0.01);
  check('  懸臂端撓度 δ', r.steps[0].maxU, dRod, 0.04);
}

// ---------- 2. 單軸拉伸（彈塑性，TET10） ----------
const bar = loadStep('test/data/bar.step');
const mesh = hexMesh(bar, { size: 2.5, order: 2 });
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
console.log(`— 單軸拉伸 HEX20：${r.stats.elements} 元素、Newton ${r.stats.newton} 次、${r.stats.seconds}s、${r.steps.length} 步`);
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

// ---------- 4. 零件結合（兩塊疊放）----------
{
  const stack = loadStep('test/data/stack.step');
  const [lo, up] = stack[0].com[2] < stack[1].com[2] ? [0, 1] : [1, 0];
  const parts = [stack[lo], stack[up]];
  const mesh = hexMesh(parts, { size: 4, order: 2 });
  const I = detectInterfaces(mesh);
  const okI = I.length === 1 && Math.abs(I[0].area - 400) < 1;
  if (!okI) failed++;
  console.log(`${okI ? '✔' : '✘'} 偵測到接觸面：${I.length} 個，面積 ${I[0]?.area.toFixed(1)}（參考 400）`);
  const run = (type, load) => {
    const split = applyInterfaces(mesh, I, { '0-1': typeof type === 'string' ? type : type }, [steel, steel], 4);
    const cp = split.copies.map(([f, t]) => new Map(Array.from(f, (n, i) => [n, t[i]])));
    const work = { type: mesh.type, nodes: split.nodes, elems: split.elems, elemPart: mesh.elemPart,
      mapFace: (face, cb) => mesh.mapFace(face, (nw, a, n) => cb(nw.map(([nd, w]) => [cp[face.part].get(nd) ?? nd, w]), a, n)) };
    const { fixed, F: Fv } = buildLoads(work, [
      { name: 'fix', type: 'fixed', faces: [faceAt(parts[0], 2, -1, 0)] },
      load.p !== undefined ? { name: 'p', type: 'pressure', p: load.p, faces: [faceAt(parts[1], 2, 1, 1)] }
        : { name: 'f', type: 'force', vector: load.v, faces: [faceAt(parts[1], 2, 1, 1)] },
    ]);
    const r = solveStatic(work, { materials: [{ ...steel, name: 'lo' }, { ...steel, name: 'up' }], fixed, F: Fv, springs: split.springs });
    return { lowerVM: r.steps[0].partMaxVM[0], maxU: r.steps[0].maxU, contact: r.contact, warnings: r.warnings, u: r.steps[0].u, nodes: split.nodes, elems: split.elems };
  };
  const bC = run('bonded', { p: 10 }), fC = run('frictionless', { p: 10 });
  check('  受壓：無摩擦接觸 ≈ 黏合（下塊應力）', fC.lowerVM, bC.lowerVM, 0.05);
  const bT = run('bonded', { p: -10 }), fT = run('frictionless', { p: -10 });
  const okT = fT.contact.closed === 0 && fT.warnings.some((w) => w.includes('分離'));
  if (!okT) failed++;
  console.log(`${okT ? '✔' : '✘'}   受拉：無摩擦接觸全部分離並發出警告（閉合 ${fT.contact.closed}/${fT.contact.springs}）`);
  void bT;
  const bS = run('bonded', { v: [4000, 0, 0] }), nS = run('noSeparation', { v: [4000, 0, 0] });
  const bR = run('bonded', { v: [4000, 0, -20000] }), rS = run('rough', { v: [4000, 0, -20000] });
  console.log(`    粗糙 vs 黏合（壓+剪）：下塊 ${rS.lowerVM.toFixed(2)} / ${bR.lowerVM.toFixed(2)} MPa，位移 ${rS.maxU.toExponential(3)} / ${bR.maxU.toExponential(3)}，閉合 ${rS.contact.closed}/${rS.contact.springs}`);
  const okR = Math.abs(rS.maxU / bR.maxU - 1) < 0.1, okN = nS.maxU > 100 * bS.maxU;
  if (!okR) failed++;
  if (!okN) failed++;
  console.log(`${okR ? '✔' : '✘'}   壓＋剪：粗糙接觸不滑動，位移與黏合一致`);
  console.log(`${okN ? '✔' : '✘'}   剪力：無分離可滑動，上塊滑移（位移 ${nS.maxU.toExponential(2)} vs 黏合 ${bS.maxU.toExponential(2)} mm）`);
  // ---------- 摩擦接觸（μ = 0.3，正壓力 N = 20000 N → 最大靜摩擦 6000 N）----------
  // 上塊頂面中心的 x 位移（扣除下塊同位置）作為滑移量
  const slipOf = (r) => {
    let up = 0, cu = 0, lo = 0, cl = 0;
    for (let n = 0; n < r.nodes.length / 3; n++) {
      const z = r.nodes[3 * n + 2];
      if (Math.abs(z - 40) < 1e-6) { up += r.u[3 * n]; cu++; }
      if (Math.abs(z - 20) < 1e-6) { lo += r.u[3 * n]; cl++; }
    }
    return up / cu - lo / cl;
  };
  const stick = run({ type: 'frictional', mu: 0.3 }, { v: [4000, 0, -20000] });
  const slip = run({ type: 'frictional', mu: 0.3 }, { v: [8000, 0, -20000] });
  const mu0 = run({ type: 'frictional', mu: 0 }, { v: [0, 0, -20000] });
  const fr0 = run('frictionless', { v: [0, 0, -20000] });
  console.log(`    摩擦 μ=0.3：T=4000（<μN）滑移 ${slipOf(stick).toExponential(2)} mm、滑動節點 ${stick.contact.sliding}；T=8000（>μN）滑移 ${slipOf(slip).toExponential(2)} mm、滑動節點 ${slip.contact.sliding}/${slip.contact.closed}`);
  console.log(`    T=4000：位移 ${stick.maxU.toExponential(3)}（粗糙接觸 ${rS.maxU.toExponential(3)}），滑動 ${stick.contact.sliding}/${stick.contact.closed} 節點（低壓力邊緣局部滑動）`);
  const okStick = Math.abs(stick.maxU / rS.maxU - 1) < 0.15 && Math.abs(slipOf(stick)) < 0.02 * slipOf(slip);
  const okSlip = slipOf(slip) > 50 * Math.abs(slipOf(stick)) && slip.warnings.some((w) => w.includes('穩定化'));
  const ok0 = Math.abs(mu0.maxU / fr0.maxU - 1) < 0.05;
  for (const [ok, msg] of [[okStick, 'T < μN：整體不滑動（僅邊緣局部滑移），位移與粗糙接觸相近'], [okSlip, 'T > μN：整體滑動並警告（形成機構）'], [ok0, `μ = 0 受壓與無摩擦接觸一致（位移 ${mu0.maxU.toExponential(3)} / ${fr0.maxU.toExponential(3)}）`]]) {
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✘'}   ${msg}`);
  }
}

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
