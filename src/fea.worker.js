// 常駐 Worker：保留網格於記憶體，處理「產生網格」與「求解」
import { voxelMesh } from './fea/mesh-voxel.js';
import { tetwildMesh } from './fea/mesh-tetwild.js';
import { hexMesh } from './fea/mesh-hex.js';
import { buildLoads } from './fea/bc.js';
import { solveStatic } from './fea/solver.js';
import { detectInterfaces, applyInterfaces } from './fea/contact.js';

let mesh = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const { id, cmd, data } = e.data;
  const progress = (p) => post({ id, type: 'progress', ...p });
  try {
    if (cmd === 'mesh') {
      const t0 = Date.now();
      mesh = null;
      if (data.method === 'tet') mesh = await tetwildMesh(data.parts, { size: data.size }, progress);
      else if (data.method === 'hex20' || data.method === 'hex8') mesh = hexMesh(data.parts, { size: data.size, order: data.method === 'hex20' ? 2 : 1 }, progress);
      else { progress({ stage: '體素化', frac: 0.2 }); mesh = voxelMesh(data.parts, data.size); }
      if (!mesh.elems.length) throw new Error('網格沒有任何元素（元素尺寸可能大於零件厚度）');
      progress({ stage: '偵測零件接觸面', frac: 0.95 });
      mesh.interfaces = detectInterfaces(mesh);
      const counts = new Array(data.parts.length).fill(0);
      for (const p of mesh.elemPart) counts[p]++;
      const result = {
        type: mesh.type,
        nodes: Float32Array.from(mesh.nodes),
        nodeCount: mesh.nodes.length / 3,
        elemCount: mesh.elemPart.length,
        partElems: counts,
        elems: mesh.elems,
        interfaces: mesh.interfaces.map((I) => ({ a: I.a, b: I.b, area: I.area, faces: I.faces.length / 2 })),
        elemPart: mesh.elemPart,
        quality: mesh.info?.worstQuality,
        display: mesh.display,
        warnings: mesh.warnings,
        seconds: (Date.now() - t0) / 1000,
      };
      post({ id, type: 'done', result });
    } else if (cmd === 'solve') {
      if (!mesh) throw new Error('請先產生網格');
      progress({ stage: '套用邊界條件', frac: 0.01 });
      // 依結合設定拆開介面節點、建立介面彈簧
      const h = mesh.info?.size || 1;
      const split = applyInterfaces(mesh, mesh.interfaces || [], data.contacts, data.setup.materials, h);
      const copyMap = split.copies.map(([from, to]) => new Map(Array.from(from, (n, i) => [n, to[i]])));
      const work = {
        type: mesh.type, nodes: split.nodes, elems: split.elems, elemPart: mesh.elemPart,
        mapFace: (face, cb) => mesh.mapFace(face, (nw, area, n) => cb(nw.map(([nd, w]) => [copyMap[face.part]?.get(nd) ?? nd, w]), area, n)),
      };
      const { fixed, F, total, warnings: w1 } = buildLoads(work, data.bcs);
      if (!F.some((v) => v)) w1.push('沒有任何負載，結果將為零');
      const r = solveStatic(work, { ...data.setup, fixed, F, springs: split.springs }, progress);
      if (split.nodes !== mesh.nodes) {
        r.split = { nodes: Float32Array.from(split.nodes), elems: split.elems, copies: split.copies };
      }
      r.warnings = [...w1, ...r.warnings];
      r.totalLoad = total;
      const transfer = r.steps.flatMap((s) => [s.u.buffer, s.vm.buffer, s.pe.buffer]);
      post({ id, type: 'done', result: r }, transfer);
    }
  } catch (err) {
    console.error(err);
    post({ id, type: 'error', message: err?.message || String(err) });
  }
};
