// 零件間結合：偵測接觸介面、依設定拆開介面節點，並建立介面彈簧（罰函數法）
//
// 結合方式：
//   bonded       黏合：介面共用節點（不拆開）
//   noSeparation 無分離：法向雙向拘束，可切向滑動
//   frictionless 無摩擦接觸：法向僅受壓（可分離），可切向滑動
//   rough        粗糙接觸：法向僅受壓（可分離），閉合時切向不可滑動
//   none         不結合：介面完全不傳力
import { HEX20_EDGES, TET10_EDGES } from './elements.js';
import { quadLoad, tri6Load } from './geom.js';

export const CONTACT_TYPES = {
  bonded: '黏合',
  noSeparation: '無分離（可滑動）',
  frictionless: '無摩擦接觸（可分離）',
  rough: '粗糙接觸（可分離、不可滑動）',
  none: '不結合',
};
export const SPRING_TYPE = { noSeparation: 1, frictionless: 2, rough: 3 };

const HEXF = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
const edgeOf = (edges, a, b) => edges.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));

/** 各元素型別的面：c 角點、all 全部節點（含邊中點）、opp 對面角點（判斷外法向） */
function elementFaces(type) {
  if (type === 'tet10')
    return [0, 1, 2, 3].map((k) => {
      const c = [0, 1, 2, 3].filter((i) => i !== k);
      return { c, all: [...c, ...[0, 1, 2].map((i) => 4 + edgeOf(TET10_EDGES, c[i], c[(i + 1) % 3]))], opp: k };
    });
  return HEXF.map((c) => ({
    c,
    all: type === 'hex20' ? [...c, ...[0, 1, 2, 3].map((i) => 8 + edgeOf(HEX20_EDGES, c[i], c[(i + 1) % 4]))] : c,
    opp: -1,
  }));
}

function faceLoad(mesh, nodes, e, f, nen) {
  const g = nodes;
  const gl = f.all.map((k) => mesh.elems[e * nen + k]);
  return f.opp >= 0 ? tri6Load(g, gl, mesh.elems[e * nen + f.opp]) : quadLoad(g, gl);
}

/** 偵測零件間的共用介面面（網格為共形時，介面面同時屬於兩個不同零件的元素） */
export function detectInterfaces(mesh) {
  const nen = mesh.elems.length / mesh.elemPart.length;
  const faces = elementFaces(mesh.type);
  const map = new Map();
  for (let e = 0; e < mesh.elemPart.length; e++)
    faces.forEach((f, fi) => {
      const key = f.c.map((k) => mesh.elems[e * nen + k]).sort((x, y) => x - y).join(',');
      const v = map.get(key);
      if (v) v.push(e, fi); else map.set(key, [e, fi]);
    });
  const pairs = new Map();
  for (const v of map.values()) {
    if (v.length !== 4) continue;
    let [e1, f1, e2, f2] = v;
    let a = mesh.elemPart[e1], b = mesh.elemPart[e2];
    if (a === b) continue;
    if (a > b) { [a, b, e1, f1, e2, f2] = [b, a, e2, f2, e1, f1]; }
    const key = `${a}-${b}`;
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { a, b, faces: [], area: 0 }));
    p.faces.push(e1, f1); // 以零件 a 這側的面為準（外法向由 a 指向 b）
    p.area += faceLoad(mesh, mesh.nodes, e1, faces[f1], nen).area;
  }
  return [...pairs.values()];
}

/**
 * 依結合設定拆開介面節點並建立彈簧
 * settings: { 'a-b': type }，未設定者為黏合
 * 回傳 { nodes, elems, springs, copies }（copies[p] = [原節點, 新節點] 對照，顯示用）
 */
export function applyInterfaces(mesh, interfaces, settings, materials, h, penalty = 10) {
  const typeOf = (a, b) => settings?.[`${Math.min(a, b)}-${Math.max(a, b)}`] || 'bonded';
  const active = interfaces.filter((I) => typeOf(I.a, I.b) !== 'bonded');
  const nParts = materials.length;
  if (!active.length) return { nodes: mesh.nodes, elems: mesh.elems, springs: null, copies: Array.from({ length: nParts }, () => [[], []]), nOrig: mesh.nodes.length / 3 };

  const nen = mesh.elems.length / mesh.elemPart.length;
  const nNode = mesh.nodes.length / 3;
  // 每個節點所屬零件
  const nodeParts = new Map();
  for (let e = 0; e < mesh.elemPart.length; e++) {
    const p = mesh.elemPart[e];
    for (let k = 0; k < nen; k++) {
      const n = mesh.elems[e * nen + k];
      const s = nodeParts.get(n);
      if (s === undefined) nodeParts.set(n, p);
      else if (typeof s === 'number') { if (s !== p) nodeParts.set(n, new Set([s, p])); }
      else s.add(p);
    }
  }
  // 依「黏合」關係分群：同群共用節點，不同群各自一份
  const copyOf = Array.from({ length: nParts }, () => new Map());
  const extra = [];
  for (const [n, s] of nodeParts) {
    if (typeof s === 'number') continue;
    const P = [...s].sort((x, y) => x - y);
    const root = new Map(P.map((p) => [p, p]));
    const find = (x) => { while (root.get(x) !== x) x = root.get(x); return x; };
    for (let i = 0; i < P.length; i++)
      for (let j = i + 1; j < P.length; j++)
        if (typeOf(P[i], P[j]) === 'bonded') { const ra = find(P[i]), rb = find(P[j]); if (ra !== rb) root.set(Math.max(ra, rb), Math.min(ra, rb)); }
    const clusters = new Map();
    for (const p of P) { const r = find(p); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(p); }
    let first = true;
    for (const ps of clusters.values()) {
      if (first) { first = false; continue; }
      const idx = nNode + extra.length;
      extra.push(n);
      for (const p of ps) copyOf[p].set(n, idx);
    }
  }
  const nodes = new Float64Array((nNode + extra.length) * 3);
  nodes.set(mesh.nodes);
  extra.forEach((src, i) => nodes.set(mesh.nodes.subarray(3 * src, 3 * src + 3), 3 * (nNode + i)));
  const elems = Int32Array.from(mesh.elems);
  for (let e = 0; e < mesh.elemPart.length; e++) {
    const cp = copyOf[mesh.elemPart[e]];
    if (!cp.size) continue;
    for (let k = 0; k < nen; k++) { const m = cp.get(elems[e * nen + k]); if (m !== undefined) elems[e * nen + k] = m; }
  }

  // 介面彈簧：每個介面節點的分擔面積與法向
  const faces = elementFaces(mesh.type);
  const sa = [], sb = [], sn = [], sk = [], st = [];
  for (const I of active) {
    const t = typeOf(I.a, I.b);
    if (t === 'none') continue;
    const acc = new Map(); // 原節點 → [面積, nx, ny, nz]
    for (let q = 0; q < I.faces.length; q += 2) {
      const e = I.faces[q], f = faces[I.faces[q + 1]];
      const r = faceLoad(mesh, mesh.nodes, e, f, nen);
      const share = r.area / f.all.length;
      for (const k of f.all) {
        const n = mesh.elems[e * nen + k];
        let v = acc.get(n);
        if (!v) acc.set(n, (v = [0, 0, 0, 0]));
        v[0] += share; v[1] += r.n[0] * share; v[2] += r.n[1] * share; v[3] += r.n[2] * share;
      }
    }
    const Eeff = Math.min(materials[I.a].E, materials[I.b].E);
    for (const [n, v] of acc) {
      const na = copyOf[I.a].get(n) ?? n, nb = copyOf[I.b].get(n) ?? n;
      if (na === nb) continue;
      const l = Math.hypot(v[1], v[2], v[3]) || 1;
      sa.push(na); sb.push(nb);
      sn.push(v[1] / l, v[2] / l, v[3] / l);
      sk.push((penalty * Eeff * v[0]) / h);
      st.push(SPRING_TYPE[t]);
    }
  }
  const copies = copyOf.map((m) => [Int32Array.from(m.keys()), Int32Array.from(m.values())]);
  return {
    nodes, elems, nOrig: nNode, copies,
    springs: sa.length ? { a: Int32Array.from(sa), b: Int32Array.from(sb), n: Float64Array.from(sn), k: Float64Array.from(sk), type: Uint8Array.from(st) } : null,
  };
}
