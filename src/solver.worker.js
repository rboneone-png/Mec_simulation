import { runAnalysis } from './fea/solve.js';

self.onmessage = (e) => {
  try {
    const result = runAnalysis(e.data, (p) => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', result }, [result.nodeU.buffer, result.nodeVM.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
