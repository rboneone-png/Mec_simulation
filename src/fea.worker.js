// 常駐 Worker：保留網格於記憶體，處理「產生網格」與「求解」
import { voxelMesh } from './fea/mesh-voxel.js';
import { gmshMesh } from './fea/mesh-gmsh.js';
import { buildLoads } from './fea/bc.js';
import { solveStatic } from './fea/solver.js';

let mesh = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const { id, cmd, data } = e.data;
  const progress = (p) => post({ id, type: 'progress', ...p });
  try {
    if (cmd === 'mesh') {
      const t0 = Date.now();
      mesh = null;
      if (data.method === 'tet') {
        const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        mesh = await gmshMesh(data.files, data.parts, { size: data.size, curvature: data.curvature, threads }, progress);
      } else {
        progress({ stage: '體素化', frac: 0.2 });
        mesh = voxelMesh(data.parts, data.size);
      }
      if (!mesh.elems.length) throw new Error('網格沒有任何元素（元素尺寸可能大於零件厚度）');
      const counts = new Array(data.parts.length).fill(0);
      for (const p of mesh.elemPart) counts[p]++;
      const result = {
        type: mesh.type,
        nodes: Float32Array.from(mesh.nodes),
        nodeCount: mesh.nodes.length / 3,
        elemCount: mesh.elemPart.length,
        partElems: counts,
        display: mesh.display,
        warnings: mesh.warnings,
        seconds: (Date.now() - t0) / 1000,
      };
      post({ id, type: 'done', result });
    } else if (cmd === 'solve') {
      if (!mesh) throw new Error('請先產生網格');
      progress({ stage: '套用邊界條件', frac: 0.01 });
      const { fixed, F, total, warnings: w1 } = buildLoads(mesh, data.bcs);
      if (!F.some((v) => v)) w1.push('沒有任何負載，結果將為零');
      const r = solveStatic(mesh, { ...data.setup, fixed, F }, progress);
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
