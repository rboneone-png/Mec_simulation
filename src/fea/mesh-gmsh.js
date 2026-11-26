// Gmsh（WASM）四面體網格：STEP → OCC fragment（多件共節點）→ TET10 二次元素
let gmshPromise = null;

async function getGmsh() {
  if (!gmshPromise) {
    const isNode = typeof process !== 'undefined' && !!process.versions?.node;
    // 瀏覽器：由 /gmsh/ 載入未打包的 Emscripten 檔案（見 vite.config.js）
    const spec = isNode ? '@loumalouomega/gmsh-wasm' : new URL('../gmsh/gmsh.mjs', self.location.href).href;
    gmshPromise = import(/* @vite-ignore */ spec).then((m) => (m.default || m.initialize)());
  }
  return gmshPromise;
}

const pairs = (flat) => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

/** 點到三角形距離平方（Ericson, Real-Time Collision Detection） */
function distTri2(px, py, pz, t, i) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2];
  const abx = t[i + 3] - ax, aby = t[i + 4] - ay, abz = t[i + 5] - az;
  const acx = t[i + 6] - ax, acy = t[i + 7] - ay, acz = t[i + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - t[i + 3], bpy = py - t[i + 4], bpz = pz - t[i + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - t[i + 6], cpy = py - t[i + 7], cpz = pz - t[i + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { qx = t[i + 3]; qy = t[i + 4]; qz = t[i + 5]; }
    else if (d6 >= 0 && d5 <= d6) { qx = t[i + 6]; qy = t[i + 7]; qz = t[i + 8]; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = t[i + 3] + w * (t[i + 6] - t[i + 3]); qy = t[i + 4] + w * (t[i + 7] - t[i + 4]); qz = t[i + 5] + w * (t[i + 8] - t[i + 5]);
    } else {
      const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

function soupBBox(t) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3)
    for (let d = 0; d < 3; d++) { b[d] = Math.min(b[d], t[i + d]); b[3 + d] = Math.max(b[3 + d], t[i + d]); }
  return b;
}

// tri6 形狀函數（Gmsh 順序：0,1,2 角點；3:(0,1) 4:(1,2) 5:(2,0)）
function tri6N(x, y) {
  const L = [1 - x - y, x, y];
  return [L[0] * (2 * L[0] - 1), L[1] * (2 * L[1] - 1), L[2] * (2 * L[2] - 1), 4 * L[0] * L[1], 4 * L[1] * L[2], 4 * L[2] * L[0]];
}
function tri6dN(x, y) {
  const L0 = 1 - x - y;
  return [
    [-(4 * L0 - 1), -(4 * L0 - 1)], [4 * x - 1, 0], [0, 4 * y - 1],
    [4 * (L0 - x), -4 * x], [4 * y, 4 * x], [-4 * y, 4 * (L0 - y)],
  ];
}
const TRI_GP = [[1 / 6, 1 / 6], [2 / 3, 1 / 6], [1 / 6, 2 / 3]];

/**
 * files: [{ name, bytes: Uint8Array }]
 * parts: [{ name, fileIdx, com:[x,y,z], volume, bbox:[6] }]
 * opts:  { size, curvature, order, threads }
 */
export async function gmshMesh(files, parts, opts, progress = () => {}) {
  progress({ stage: '載入 Gmsh 核心（首次約 40 MB）', frac: 0.02 });
  const gmsh = await getGmsh();
  gmsh.initialize();
  const warnings = [];
  try {
    gmsh.option.setNumber('General.Terminal', 0);
    if (opts.threads) gmsh.option.setNumber('General.NumThreads', opts.threads);
    gmsh.option.setString('Geometry.OCCTargetUnit', 'MM');
    gmsh.model.add('mecsim');
    progress({ stage: '匯入幾何', frac: 0.08 });

    // 匯入並將 Gmsh 體積對應到零件（以質心比對）
    const usedFiles = [...new Set(parts.map((p) => p.fileIdx))];
    const volPart = new Map(); // gmsh 體積 tag -> 零件索引
    for (const fi of usedFiles) {
      gmsh.FS.writeFile(`/f${fi}.step`, files[fi].bytes);
      const out = pairs(gmsh.model.occ.importShapes(`/f${fi}.step`, true).outDimTags).filter(([d]) => d === 3);
      const cand = parts.map((p, i) => [p, i]).filter(([p]) => p.fileIdx === fi);
      const taken = new Set();
      for (const [, tag] of out) {
        const c = gmsh.model.occ.getCenterOfMass(3, tag);
        const m = gmsh.model.occ.getMass(3, tag).mass;
        let best = -1, bd = Infinity;
        for (const [p, i] of cand) {
          if (taken.has(i)) continue;
          const diag = Math.hypot(p.bbox[3] - p.bbox[0], p.bbox[4] - p.bbox[1], p.bbox[5] - p.bbox[2]);
          const d = Math.hypot(c.x - p.com[0], c.y - p.com[1], c.z - p.com[2]) / diag + Math.abs(m - p.volume) / Math.max(m, p.volume);
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0 && bd < 0.05) { volPart.set(tag, best); taken.add(best); }
        else gmsh.model.occ.remove([3, tag], true); // 使用者已移除的零件
      }
    }
    gmsh.model.occ.synchronize();
    const missing = parts.map((p, i) => i).filter((i) => ![...volPart.values()].includes(i));
    for (const i of missing) warnings.push(`零件「${parts[i].name}」無法對應到 Gmsh 幾何，未產生網格`);

    // fragment：讓接觸面共用節點（黏合）
    let vols = [...volPart.keys()];
    if (vols.length > 1) {
      progress({ stage: '布林 fragment（建立共用介面）', frac: 0.15 });
      const objs = vols.flatMap((t) => [3, t]);
      const res = gmsh.model.occ.fragment(objs.slice(0, 2), objs.slice(2));
      const newMap = new Map();
      res.outDimTagsMap.forEach((flat, i) => {
        const pi = volPart.get(vols[i]);
        for (const [d, t] of pairs(flat)) if (d === 3 && !newMap.has(t)) newMap.set(t, pi);
      });
      gmsh.model.occ.synchronize();
      volPart.clear();
      for (const [t, p] of newMap) volPart.set(t, p);
      vols = [...volPart.keys()];
    }

    // 網格參數
    gmsh.option.setNumber('Mesh.MeshSizeMax', opts.size);
    gmsh.option.setNumber('Mesh.MeshSizeMin', opts.size / 20);
    gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', opts.curvature ? 16 : 0);
    gmsh.option.setNumber('Mesh.ElementOrder', opts.order || 2);
    gmsh.option.setNumber('Mesh.HighOrderOptimize', 2);
    gmsh.option.setNumber('Mesh.Optimize', 1);
    progress({ stage: '產生四面體網格', frac: 0.3 });
    gmsh.model.mesh.generate(3);
    progress({ stage: '整理網格資料', frac: 0.85 });

    // 節點
    const N = gmsh.model.mesh.getNodes();
    let maxTag = 0;
    for (const t of N.nodeTags) if (t > maxTag) maxTag = t;
    const tagIdx = new Int32Array(maxTag + 1).fill(-1);
    N.nodeTags.forEach((t, i) => (tagIdx[t] = i));
    const nodes = Float64Array.from(N.coord);

    // 四面體
    const elems = [], elemPart = [];
    for (const v of vols) {
      const E = gmsh.model.mesh.getElements(3, v);
      E.elementTypes.forEach((type, k) => {
        if (type !== 11) { warnings.push(`忽略非 TET10 元素（type ${type}）`); return; }
        for (const t of E.nodeTags[k]) elems.push(tagIdx[t]);
        for (let q = 0; q < E.elementTags[k].length; q++) elemPart.push(volPart.get(v));
      });
    }

    // 四面體面 → 對面頂點（用來判斷邊界面的外法向）
    const opp = new Map();
    const fkey = (a, b, c) => { const v = [a, b, c].sort((x, y) => x - y); return `${v[0]},${v[1]},${v[2]}`; };
    for (let e = 0; e < elems.length; e += 10) {
      const c = [elems[e], elems[e + 1], elems[e + 2], elems[e + 3]];
      for (let k = 0; k < 4; k++) {
        const f = c.filter((_, i) => i !== k);
        opp.set(fkey(f[0], f[1], f[2]), c[k]);
      }
    }

    // 邊界曲面
    const surfaces = [];
    for (const [, s] of pairs(gmsh.model.getEntities(2).dimTags)) {
      const up = gmsh.model.getAdjacencies(2, s).upward.filter((v) => volPart.has(v));
      if (!up.length) continue;
      const E = gmsh.model.mesh.getElements(2, s);
      const tris = [];
      E.elementTypes.forEach((type, k) => { if (type === 9) for (const t of E.nodeTags[k]) tris.push(tagIdx[t]); });
      const tri = Int32Array.from(tris);
      const nset = [...new Set(tri)];
      const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const n of nset) for (let d = 0; d < 3; d++) { bb[d] = Math.min(bb[d], nodes[3 * n + d]); bb[3 + d] = Math.max(bb[3 + d], nodes[3 * n + d]); }
      surfaces.push({ tag: s, parts: up.map((v) => volPart.get(v)), tri, nodeSet: Int32Array.from(nset), bbox: bb, interface: up.length > 1 });
    }

    // 顯示資料：每個零件的外表面（介面不顯示），每個曲面獨立頂點以保留稜線
    const display = parts.map(() => ({ pos: [], idx: [], vn: [], wire: new Map() }));
    for (const s of surfaces) {
      if (s.interface) continue;
      const D = display[s.parts[0]];
      const local = new Map();
      const vid = (n) => {
        let v = local.get(n);
        if (v === undefined) {
          v = D.vn.length; local.set(n, v); D.vn.push(n);
          D.pos.push(nodes[3 * n], nodes[3 * n + 1], nodes[3 * n + 2]);
        }
        return v;
      };
      for (let i = 0; i < s.tri.length; i += 6) {
        const t = s.tri.subarray(i, i + 6);
        for (const [a, b, c] of [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]]) D.idx.push(vid(t[a]), vid(t[b]), vid(t[c]));
        for (const [a, b] of [[0, 3], [3, 1], [1, 4], [4, 2], [2, 5], [5, 0]]) {
          const k = t[a] < t[b] ? `${t[a]},${t[b]}` : `${t[b]},${t[a]}`;
          D.wire.set(k, [t[a], t[b]]);
        }
      }
    }
    const displayOut = display.map((D) => ({
      positions: Float32Array.from(D.pos),
      index: Uint32Array.from(D.idx),
      vertexNode: Int32Array.from(D.vn),
      wire: Int32Array.from([...D.wire.values()].flat()),
    }));

    const diag = Math.max(...parts.map((p) => Math.hypot(p.bbox[3] - p.bbox[0], p.bbox[4] - p.bbox[1], p.bbox[5] - p.bbox[2])));
    const tol = Math.max(diag * 0.004, opts.size * 0.05);

    return {
      type: 'tet10',
      nodes,
      elems: Int32Array.from(elems),
      elemPart: Int32Array.from(elemPart),
      warnings,
      display: displayOut,
      info: { size: opts.size, surfaces: surfaces.length },
      /** BC 對應：找出與 CAD 面重合的 Gmsh 曲面，以 tri6 一致性積分得到節點權重 */
      mapFace(face, cb) {
        const t = face.soup;
        const fb = soupBBox(t);
        let matched = 0;
        for (const s of surfaces) {
          if (s.interface || !s.parts.includes(face.part)) continue;
          let overlap = true;
          for (let d = 0; d < 3; d++) if (s.bbox[d] > fb[3 + d] + tol || s.bbox[3 + d] < fb[d] - tol) overlap = false;
          if (!overlap) continue;
          let inside = 0;
          const tol2 = tol * tol, ns = s.nodeSet;
          for (let q = 0; q < ns.length; q++) {
            const n = ns[q], px = nodes[3 * n], py = nodes[3 * n + 1], pz = nodes[3 * n + 2];
            for (let i = 0; i < t.length; i += 9) if (distTri2(px, py, pz, t, i) < tol2) { inside++; break; }
            if (q - inside > ns.length * 0.08) break; // 已不可能匹配
          }
          if (inside < ns.length * 0.92) continue;
          matched++;
          for (let i = 0; i < s.tri.length; i += 6) {
            const tn = s.tri.subarray(i, i + 6);
            const w = [0, 0, 0, 0, 0, 0];
            const nrm = [0, 0, 0];
            let area = 0;
            for (const [gx, gy] of TRI_GP) {
              const Nn = tri6N(gx, gy), dN = tri6dN(gx, gy);
              const a = [0, 0, 0], b = [0, 0, 0];
              for (let k = 0; k < 6; k++) for (let d = 0; d < 3; d++) { a[d] += dN[k][0] * nodes[3 * tn[k] + d]; b[d] += dN[k][1] * nodes[3 * tn[k] + d]; }
              const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
              const dA = Math.hypot(...cr) / 6;
              area += dA;
              for (let d = 0; d < 3; d++) nrm[d] += cr[d] / 6;
              for (let k = 0; k < 6; k++) w[k] += Nn[k] * dA;
            }
            if (!(area > 0)) continue;
            // 法向朝外：背向相鄰四面體的對面頂點
            const nl = Math.hypot(...nrm);
            let n = nrm.map((v) => v / nl);
            const o = opp.get(fkey(tn[0], tn[1], tn[2]));
            if (o !== undefined) {
              let dot = 0;
              for (let d = 0; d < 3; d++) dot += n[d] * (nodes[3 * o + d] - (nodes[3 * tn[0] + d] + nodes[3 * tn[1] + d] + nodes[3 * tn[2] + d]) / 3);
              if (dot > 0) n = n.map((v) => -v);
            }
            cb(Array.from(tn, (nd, k) => [nd, w[k] / area]), area, n);
          }
        }
        return matched;
      },
    };
  } finally {
    gmsh.finalize();
  }
}
