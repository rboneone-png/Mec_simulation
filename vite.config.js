import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Gmsh WASM 使用 pthreads → 需要跨來源隔離（SharedArrayBuffer）
const COI = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Gmsh 的 Emscripten 輸出（含 pthread worker 自我載入）不適合被打包，
 * 因此原封不動地放在 /gmsh/ 下，於執行期以動態 import 載入。
 */
function gmshAssets() {
  const dir = path.resolve('node_modules/@loumalouomega/gmsh-wasm/dist');
  const files = ['gmsh.mjs', 'gmsh-core.mjs', 'gmsh-core.wasm', 'runtime.mjs', 'gmsh-descriptor.mjs'];
  const mime = { '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
  return {
    name: 'gmsh-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/gmsh\/([\w.-]+)(\?.*)?$/.exec(req.url || '');
        if (!m || !files.includes(m[1])) return next();
        res.setHeader('Content-Type', mime[path.extname(m[1])]);
        for (const [k, v] of Object.entries(COI)) res.setHeader(k, v);
        fs.createReadStream(path.join(dir, m[1])).pipe(res);
      });
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: 'asset', fileName: `gmsh/${f}`, source: fs.readFileSync(path.join(dir, f)) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [gmshAssets()],
  server: { headers: COI },
  preview: { headers: COI },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
