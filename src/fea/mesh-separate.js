// 各零件分別產生網格再合併（非共形、不共用節點）：插入模擬用，零件之間以點對面接觸傳力
// 零件可彼此重疊（干涉配合）而不互相影響網格

/** meshOne(parts[i]) → 單一零件網格；回傳合併後的網格（介面與 hexMesh 相同） */
export async function meshSeparately(parts, meshOne, progress = () => {}) {
  const subs = [];
  for (let i = 0; i < parts.length; i++) {
    const sub = await meshOne([parts[i]], (p) => progress({ ...p, stage: `零件 ${i + 1}/${parts.length}：${p.stage}`, frac: (i + (p.frac || 0)) / parts.length }));
    subs.push(sub);
  }
  const type = subs[0].type;
  if (subs.some((m) => m.type !== type)) throw new Error('零件網格型別不一致');
  let nn = 0, ne = 0;
  for (const m of subs) { nn += m.nodes.length / 3; ne += m.elemPart.length; }
  const nen = subs[0].elems.length / subs[0].elemPart.length;
  const nodes = new Float64Array(nn * 3), elems = new Int32Array(ne * nen), elemPart = new Int32Array(ne);
  const offs = [];
  let on = 0, oe = 0;
  const warnings = [], display = [];
  let worst = Infinity, size = 0;
  subs.forEach((m, i) => {
    offs.push(on);
    nodes.set(m.nodes, on * 3);
    for (let k = 0; k < m.elems.length; k++) elems[oe * nen + k] = m.elems[k] + on;
    elemPart.fill(i, oe, oe + m.elemPart.length);
    const d = m.display[0];
    display.push({ ...d, vertexNode: d.vertexNode.map((n) => (n >= 0 ? n + on : n)), wire: d.wire ? d.wire.map((n) => n + on) : d.wire });
    for (const w of m.warnings || []) warnings.push(`${parts[i].name}：${w}`);
    if (m.info?.worstQuality !== undefined) worst = Math.min(worst, m.info.worstQuality);
    size = Math.max(size, m.info?.size || 0);
    on += m.nodes.length / 3; oe += m.elemPart.length;
  });
  return {
    type, nodes, elems, elemPart, warnings, display, separate: true,
    info: { size, worstQuality: Number.isFinite(worst) ? worst : undefined },
    mapFace(face, cb) {
      const m = subs[face.part];
      if (!m) return 0;
      const o = offs[face.part];
      return m.mapFace({ ...face, part: 0 }, (nw, area, n) => cb(nw.map(([nd, w]) => [nd + o, w]), area, n));
    },
  };
}
