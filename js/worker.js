// Runs the analysis off the main thread so the page stays responsive.
import { analyze } from './dsp.js';

let x = null;
let sr = 44100;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    x = m.x;
    sr = m.sr;
    return;
  }
  if (m.type === 'analyze') {
    try {
      const result = analyze(x, sr, m.opts, (stage, frac) =>
        self.postMessage({ type: 'progress', id: m.id, stage, frac }));
      self.postMessage({ type: 'result', id: m.id, result });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: err.message || String(err) });
    }
  }
};
