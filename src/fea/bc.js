// 將使用者在 CAD 面上設定的邊界條件，轉換成節點自由度拘束與節點力向量
/**
 * bcs: [{ type:'fixed'|'force'|'pressure', dirs?:[bool,bool,bool], vector?:[fx,fy,fz], p?, faces:[{ part, soup }] }]
 */
export function buildLoads(mesh, bcs) {
  const nNode = mesh.nodes.length / 3;
  const fixed = new Uint8Array(nNode * 3);
  const F = new Float64Array(nNode * 3);
  const warnings = [];
  let total = [0, 0, 0];
  for (const bc of bcs) {
    // 先算總面積（集中力依面積比例分配）
    const tris = [];
    let matched = 0;
    for (const face of bc.faces) {
      const m = mesh.mapFace(face, (nw, area, n) => tris.push({ nw, area, n }));
      matched += m === undefined ? 1 : m;
    }
    if (!tris.length || !matched) { warnings.push(`邊界條件「${bc.name}」對應不到網格節點（面太小或網格太粗）`); continue; }
    if (bc.type === 'fixed') {
      const dirs = bc.dirs || [true, true, true];
      for (const t of tris) for (const [nd] of t.nw) for (let d = 0; d < 3; d++) if (dirs[d]) fixed[3 * nd + d] = 1;
      continue;
    }
    const A = tris.reduce((s, t) => s + t.area, 0);
    for (const t of tris) {
      const f = bc.type === 'pressure' ? t.n.map((c) => -c * bc.p * t.area) : bc.vector.map((c) => (c * t.area) / A);
      for (const [nd, w] of t.nw) for (let d = 0; d < 3; d++) F[3 * nd + d] += f[d] * w;
      for (let d = 0; d < 3; d++) total[d] += f[d];
    }
  }
  return { fixed, F, total, warnings };
}
