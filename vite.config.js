import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  base: './',
  resolve: {
    // fTetWild 只用單執行緒版（不需 COOP/COEP 標頭）；套件 exports 未公開此路徑，故以 alias 指定
    alias: { 'ftetwild-serial': path.resolve('node_modules/float-tetwild-wasm/dist/floattetwild.serial.mjs') },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
