// 貼體六面體網格（HEX8 / HEX20）
// 流程：體素化 → 邊界四邊形對應 CAD 面 → 邊界節點投影回 CAD（多面交會處以交替投影保留稜線與角點）
//      → 元素品質檢查與鬆弛 → （HEX20）邊中點投影形成曲面元素
import { makeGrid, voxelizePart } from './mesh-voxel.js';
import { TriGrid, quadLoad } from './geom.js';
import { HEX_SIGN, HEX20_EDGES, ELEMENTS } from './elements.js';

const HEX = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
// 六個面：角點（由外側看逆時針）、相鄰體素偏移、外法向
const FACES = [
  { c: [0, 4, 7, 3], d: [-1, 0, 0] },
  { c: [1, 2, 6, 5], d: [1, 0, 0] },
  { c: [0, 1, 5, 4], d: [0, -1, 0] },
  { c: [3, 7, 6, 2], d: [0, 1, 0] },
  { c: [0, 3, 2, 1], d: [0, 0, -1] },
  { c: [4, 5, 6, 7], d: [0, 0, 1] },
];
const edgeIdx = (a, b) => HEX20_EDGES.findIndex(([p, q]) => (p === a && q === b) || (p === b && q === a));
for (const f of FACES) f.m = [0, 1, 2, 3].map((i) => 8 + edgeIdx(f.c[i], f.c[(i + 1) % 4]));
// 角點沿 ξ、η、ζ 方向的相鄰角點
const NB = HEX_SIGN.map((s) => [0, 1, 2].map((d) => HEX_SIGN.findIndex((t) => t.every((v, i) => (i === d ? v === -s[d] : v === s[i])))));

/** HEX8 角點的最小縮放 Jacobian（1 = 完美立方體，≤0 = 翻轉） */
function minScaledJac(pos, el, o) {
  let m = Infinity;
  for (let n = 0; n < 8; n++) {
    const s = HEX_SIGN[n], p = 3 * el[o + n];
    const e = NB[n].map((nb, d) => {
      const q = 3 * el[o + nb];
      return [s[d] * (pos[p] - pos[q]), s[d] * (pos[p + 1] - pos[q + 1]), s[d] * (pos[p + 2] - pos[q + 2])];
    });
    const det = e[0][0] * (e[1][1] * e[2][2] - e[1][2] * e[2][1]) - e[0][1] * (e[1][0] * e[2][2] - e[1][2] * e[2][0]) + e[0][2] * (e[1][0] * e[2][1] - e[1][1] * e[2][0]);
    const L = Math.hypot(...e[0]) * Math.hypot(...e[1]) * Math.hypot(...e[2]);
    m = Math.min(m, L > 0 ? det / L : -1);
  }
  return m;
}

const H20_CHECK = [...HEX_SIGN, [0, 0, 0]].map((xi) => ELEMENTS.hex20.dN(xi, new Float64Array(60)));
/** HEX20 在角點與中心的最小 Jacobian 行列式 */
function minDetHex20(pos, el, o) {
  let m = Infinity;
  for (const dn of H20_CHECK) {
    let j00 = 0, j01 = 0, j02 = 0, j10 = 0, j11 = 0, j12 = 0, j20 = 0, j21 = 0, j22 = 0;
    for (let n = 0; n < 20; n++) {
      const p = 3 * el[o + n], a = dn[3 * n], b = dn[3 * n + 1], c = dn[3 * n + 2];
      j00 += pos[p] * a; j01 += pos[p] * b; j02 += pos[p] * c;
      j10 += pos[p + 1] * a; j11 += pos[p + 1] * b; j12 += pos[p + 1] * c;
      j20 += pos[p + 2] * a; j21 += pos[p + 2] * b; j22 += pos[p + 2] * c;
    }
    m = Math.min(m, j00 * (j11 * j22 - j12 * j21) - j01 * (j10 * j22 - j12 * j20) + j02 * (j10 * j21 - j11 * j20));
  }
  return m;
}

/**
 * parts: [{ name, positions（CAD 三角形 soup）, faceOfTri, bbox }]
 * opts:  { size: 元素尺寸, order: 1（HEX8）| 2（HEX20） }
 */
export function hexMesh(parts, opts, progress = () => {}) {
  const h = opts.size, order = opts.order === 1 ? 1 : 2;
  const warnings = [];
  progress({ stage: '體素化', frac: 0.05 });
  const g = makeGrid(parts, h);
  const { nx, ny, nz } = g;
  const gridPart = new Uint16Array(nx * ny * nz);
  parts.forEach((p, i) => { if (!voxelizePart(p.positions, g, gridPart, i + 1)) warnings.push(`零件「${p.name}」比元素尺寸還薄或不封閉，未產生元素`); });

  // 1. 節點與元素（角點）
  const NX = nx + 1, NY = ny + 1;
  const gridNode = new Int32Array(NX * NY * (nz + 1)).fill(-1);
  const coords = [], corners = [], elemPart = [], cellElem = new Int32Array(nx * ny * nz).fill(-1);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k), tag = gridPart[c];
        if (!tag) continue;
        cellElem[c] = elemPart.length;
        for (const [a, b, d] of HEX) {
          const gn = i + a + NX * (j + b + NY * (k + d));
          if (gridNode[gn] < 0) { gridNode[gn] = coords.length / 3; coords.push(g.ox + (i + a) * h, g.oy + (j + b) * h, g.oz + (k + d) * h); }
          corners.push(gridNode[gn]);
        }
        elemPart.push(tag - 1);
      }
  const ne = elemPart.length;
  if (!ne) throw new Error('網格沒有任何元素（元素尺寸可能大於零件厚度）');
  const orig = Float64Array.from(coords);
  const nC = orig.length / 3;

  // 2. 邊界四邊形（外表面與零件介面）
  progress({ stage: '邊界面對應 CAD', frac: 0.2 });
  const quads = []; // { e, f, part, ext }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k), t = gridPart[c];
        if (!t) continue;
        FACES.forEach((f, fi) => {
          const a = i + f.d[0], b = j + f.d[1], d = k + f.d[2];
          const nt = a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz ? 0 : gridPart[a + nx * (b + ny * d)];
          if (nt === t) return;
          if (nt === 0) quads.push({ e: cellElem[c], f: fi, part: t - 1, ext: true });
          else if (t < nt) quads.push({ e: cellElem[c], f: fi, part: t - 1, ext: false });
        });
      }

  // CAD 三角形格網
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let d = 0; d < 3; d++) { bb[d] = Math.min(bb[d], p.bbox[d]); bb[3 + d] = Math.max(bb[3 + d], p.bbox[3 + d]); }
  let total = 0;
  for (const p of parts) total += p.positions.length;
  const soup = new Float32Array(total);
  const triPart = new Int32Array(total / 9), triFace = new Int32Array(total / 9);
  let off = 0;
  parts.forEach((p, pi) => {
    soup.set(p.positions, off);
    const t0 = off / 9, nt = p.positions.length / 9;
    for (let t = 0; t < nt; t++) { triPart[t0 + t] = pi; triFace[t0 + t] = p.faceOfTri ? p.faceOfTri[t] : 0; }
    off += p.positions.length;
  });
  const grid = new TriGrid(soup, bb, 64);
  const triN = new Float32Array((total / 9) * 3);
  for (let k = 0; k < total / 9; k++) {
    const i = 9 * k;
    const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1], uz = soup[i + 5] - soup[i + 2];
    const vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1], vz = soup[i + 8] - soup[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...n) || 1;
    triN.set(n.map((v) => v / l), 3 * k);
  }
  const keyOf = (k) => triPart[k] * 100000 + triFace[k];

  // 每個邊界四邊形 → CAD 面（距離近且法向一致者）
  for (const q of quads) {
    const el = q.e * 8, f = FACES[q.f];
    let cx = 0, cy = 0, cz = 0;
    for (const a of f.c) { const n = corners[el + a]; cx += orig[3 * n] / 4; cy += orig[3 * n + 1] / 4; cz += orig[3 * n + 2] / 4; }
    const filt = (k) => triPart[k] === q.part;
    const best = grid.nearest(cx, cy, cz, filt, 4 * h);
    if (!best) { q.key = -1; continue; }
    let pick = best.k, bs = -Infinity;
    grid.query(cx, cy, cz, Math.sqrt(best.q[3]) + 0.75 * h, (k, qq) => {
      const s = f.d[0] * triN[3 * k] + f.d[1] * triN[3 * k + 1] + f.d[2] * triN[3 * k + 2] - (0.5 * Math.sqrt(qq[3])) / h;
      if (s > bs) { bs = s; pick = k; }
    }, filt);
    q.key = keyOf(pick);
    q.face = triFace[pick];
  }

  // 3. 邊界節點 → 所屬 CAD 面集合
  const nodeKeys = new Map();
  for (const q of quads) {
    if (q.key < 0) continue;
    for (const a of FACES[q.f].c) {
      const n = corners[q.e * 8 + a];
      let s = nodeKeys.get(n);
      if (!s) nodeKeys.set(n, (s = new Set()));
      s.add(q.key);
    }
  }

  // 投影到 CAD 面（多面時交替投影 → 收斂至稜線／角點）
  const project = (x, y, z, keys, rMax) => {
    let p = [x, y, z];
    const ks = [...keys];
    for (let it = 0; it < (ks.length > 1 ? 40 : 1); it++) {
      const prev = p;
      for (const key of ks) {
        const r = grid.nearest(p[0], p[1], p[2], (k) => keyOf(k) === key, rMax);
        if (!r) return null;
        p = [r.q[0], r.q[1], r.q[2]];
      }
      if (Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) < 1e-6 * h) break;
    }
    return p;
  };

  progress({ stage: '邊界節點投影', frac: 0.35 });
  const target = Float64Array.from(orig);
  const snapped = new Uint8Array(nC);
  for (const [n, keys] of nodeKeys) {
    const p = project(orig[3 * n], orig[3 * n + 1], orig[3 * n + 2], keys, 3 * h);
    if (!p) continue;
    if (Math.hypot(p[0] - orig[3 * n], p[1] - orig[3 * n + 1], p[2] - orig[3 * n + 2]) > 1.2 * h) continue;
    target[3 * n] = p[0]; target[3 * n + 1] = p[1]; target[3 * n + 2] = p[2];
    snapped[n] = 1;
  }

  // 4. 品質鬆弛：品質過差的元素，其投影節點往原位退回
  progress({ stage: '網格品質檢查', frac: 0.5 });
  const alpha = new Float64Array(nC).fill(1);
  const pos = Float64Array.from(target);
  const setPos = (n) => { for (let d = 0; d < 3; d++) pos[3 * n + d] = orig[3 * n + d] + alpha[n] * (target[3 * n + d] - orig[3 * n + d]); };
  const QMIN = 0.12;
  let bad = [];
  for (let it = 0; it < 12; it++) {
    bad = [];
    for (let e = 0; e < ne; e++) if (minScaledJac(pos, corners, 8 * e) < QMIN) bad.push(e);
    if (!bad.length) break;
    const touched = new Set();
    for (const e of bad) for (let a = 0; a < 8; a++) { const n = corners[8 * e + a]; if (snapped[n]) touched.add(n); }
    for (const n of touched) { alpha[n] = it < 10 ? alpha[n] * 0.6 : 0; setPos(n); }
  }
  let worst = 1;
  for (let e = 0; e < ne; e++) worst = Math.min(worst, minScaledJac(pos, corners, 8 * e));
  if (worst <= 0) warnings.push('部分元素品質不佳（Jacobian ≤ 0），請調整元素尺寸');

  // 5. 元素連結（HEX20 加邊中點並投影曲面）
  const nen = order === 2 ? 20 : 8;
  const elems = new Int32Array(ne * nen);
  const nodeList = Array.from(pos);
  const edgeMid = new Map();
  const midKey = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  for (let e = 0; e < ne; e++) {
    for (let a = 0; a < 8; a++) elems[e * nen + a] = corners[8 * e + a];
    if (order === 1) continue;
    HEX20_EDGES.forEach(([a, b], k) => {
      const i = corners[8 * e + a], j = corners[8 * e + b], key = midKey(i, j);
      let m = edgeMid.get(key);
      if (m === undefined) {
        m = nodeList.length / 3;
        edgeMid.set(key, m);
        nodeList.push((pos[3 * i] + pos[3 * j]) / 2, (pos[3 * i + 1] + pos[3 * j + 1]) / 2, (pos[3 * i + 2] + pos[3 * j + 2]) / 2);
      }
      elems[e * nen + 8 + k] = m;
    });
  }
  const nodes = Float64Array.from(nodeList);
  if (order === 2) {
    progress({ stage: '二次元素曲面投影', frac: 0.65 });
    const straight = new Map();
    for (const q of quads) {
      if (q.key < 0) continue;
      const f = FACES[q.f];
      for (let i = 0; i < 4; i++) {
        const a = corners[q.e * 8 + f.c[i]], b = corners[q.e * 8 + f.c[(i + 1) % 4]];
        if (!snapped[a] || !snapped[b] || alpha[a] < 1 || alpha[b] < 1) continue;
        const m = edgeMid.get(midKey(a, b));
        if (straight.has(m)) continue;
        straight.set(m, [nodes[3 * m], nodes[3 * m + 1], nodes[3 * m + 2]]);
        const ka = nodeKeys.get(a), kb = nodeKeys.get(b);
        let keys = [...ka].filter((k) => kb.has(k));
        if (!keys.length) keys = [q.key];
        const p = project(nodes[3 * m], nodes[3 * m + 1], nodes[3 * m + 2], keys, 2 * h);
        const L = Math.hypot(nodes[3 * a] - nodes[3 * b], nodes[3 * a + 1] - nodes[3 * b + 1], nodes[3 * a + 2] - nodes[3 * b + 2]);
        if (p && Math.hypot(p[0] - nodes[3 * m], p[1] - nodes[3 * m + 1], p[2] - nodes[3 * m + 2]) < 0.3 * L) {
          nodes[3 * m] = p[0]; nodes[3 * m + 1] = p[1]; nodes[3 * m + 2] = p[2];
        }
      }
    }
    // 曲面化後若 Jacobian 不良：逐次將該元素的邊中點偏移量減半，直到有效
    const ref = (h / 2) ** 3 * 0.005;
    const curved = new Map();
    for (const [m, sp] of straight) curved.set(m, [nodes[3 * m] - sp[0], nodes[3 * m + 1] - sp[1], nodes[3 * m + 2] - sp[2]]);
    const fac = new Map([...straight.keys()].map((m) => [m, 1]));
    for (let it = 0; it < 8; it++) {
      const shrink = new Set();
      for (let e = 0; e < ne; e++) {
        if (minDetHex20(nodes, elems, 20 * e) > ref) continue;
        for (let k = 8; k < 20; k++) { const m = elems[20 * e + k]; if (fac.has(m) && fac.get(m) > 0) shrink.add(m); }
      }
      if (!shrink.size) break;
      for (const m of shrink) {
        const f = it < 7 ? fac.get(m) * 0.5 : 0;
        fac.set(m, f);
        const sp = straight.get(m), dv = curved.get(m);
        for (let d = 0; d < 3; d++) nodes[3 * m + d] = sp[d] + f * dv[d];
      }
    }
  }

  // 6. 顯示（依 CAD 面分組）與邊界條件資料
  progress({ stage: '整理顯示資料', frac: 0.85 });
  const ext = quads.filter((q) => q.ext);
  const quadNodes = (q) => {
    const f = FACES[q.f], o = q.e * nen;
    const c = f.c.map((a) => elems[o + a]);
    return order === 2 ? [...c, ...f.m.map((a) => elems[o + a])] : c;
  };
  const disp = parts.map(() => ({ pos: [], idx: [], vn: [], wire: new Map(), groups: new Map() }));
  for (const q of ext) {
    const D = disp[q.part];
    let local = D.groups.get(q.face);
    if (!local) D.groups.set(q.face, (local = new Map()));
    const vid = (n) => {
      let v = local.get(n);
      if (v === undefined) { v = D.vn.length; local.set(n, v); D.vn.push(n); D.pos.push(nodes[3 * n], nodes[3 * n + 1], nodes[3 * n + 2]); }
      return v;
    };
    const t = quadNodes(q);
    const tris = order === 2
      ? [[0, 4, 7], [4, 1, 5], [5, 2, 6], [6, 3, 7], [4, 5, 7], [5, 6, 7]]
      : [[0, 1, 2], [0, 2, 3]];
    for (const [a, b, c] of tris) D.idx.push(vid(t[a]), vid(t[b]), vid(t[c]));
    const loop = order === 2 ? [0, 4, 1, 5, 2, 6, 3, 7] : [0, 1, 2, 3];
    for (let i = 0; i < loop.length; i++) {
      const a = t[loop[i]], b = t[loop[(i + 1) % loop.length]];
      D.wire.set(a < b ? `${a},${b}` : `${b},${a}`, [a, b]);
    }
  }
  const display = disp.map((D) => ({
    positions: Float32Array.from(D.pos), index: Uint32Array.from(D.idx), vertexNode: Int32Array.from(D.vn),
    wire: Int32Array.from([...D.wire.values()].flat()),
  }));

  return {
    type: order === 2 ? 'hex20' : 'hex8',
    nodes,
    elems,
    elemPart: Int32Array.from(elemPart),
    warnings,
    display,
    info: { size: h, worstQuality: worst },
    mapFace(face, cb) {
      let cnt = 0;
      for (const q of ext) {
        if (q.part !== face.part || q.face !== face.faceId) continue;
        const r = quadLoad(nodes, quadNodes(q));
        if (r.area > 0) { cb(r.nw, r.area, r.n); cnt++; }
      }
      return cnt;
    },
  };
}
