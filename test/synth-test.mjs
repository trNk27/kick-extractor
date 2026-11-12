// Builds a synthetic hardstyle-ish track with known kicks, runs the pipeline, and checks the result.
// Usage: node test/synth-test.mjs [--write out.wav]
import { analyze, encodeWav } from '../js/dsp.js';
import { writeFileSync } from 'node:fs';

const sr = 44100, bpm = 150, beat = 60 / bpm, bars = 48;
const N = Math.round(bars * 4 * beat * sr) + sr;
const mix = new Float32Array(N);
let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function makeKick(tailHz, len = 0.38) {
  const n = Math.round(len * sr), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = tailHz + (350 - tailHz) * Math.exp(-t / 0.025);
    ph += 2 * Math.PI * f / sr;
    const amp = Math.min(1, t / 0.001) * (t < 0.3 ? 1 : Math.exp(-(t - 0.3) / 0.02));
    let s = Math.sin(ph) * amp;
    if (t < 0.004) s += 0.6 * rnd() * (1 - t / 0.004); // click
    out[i] = Math.tanh(4 * s) * 0.8;                     // distortion
  }
  return out;
}
const kickA = makeKick(55);            // A1
const kickB = makeKick(55 * 2 ** (3 / 12)); // C2
const add = (sig, t, g = 1) => { const s = Math.round(t * sr); for (let i = 0; i < sig.length && s + i < N; i++) mix[s + i] += g * sig[i]; };

const clap = Float32Array.from({ length: Math.round(0.15 * sr) }, (_, i) => rnd() * Math.exp(-i / sr / 0.04) * 0.5);
const hat = Float32Array.from({ length: Math.round(0.03 * sr) }, (_, i) => rnd() * Math.exp(-i / sr / 0.008) * 0.25);
const revBass = Float32Array.from({ length: Math.round(0.18 * sr) }, (_, i) => Math.tanh(3 * Math.sin(2 * Math.PI * 55 * i / sr)) * (i / (0.18 * sr)) * 0.5);
const truth = []; // [time, 'A'|'B']

for (let b = 0; b < bars; b++) {
  const sec = b < 8 ? 'intro' : b < 20 ? 'build' : b < 28 ? 'break' : 'drop';
  for (let q = 0; q < 4; q++) {
    const t = (b * 4 + q) * beat + 0.5;
    if (sec !== 'break') {
      const useB = sec === 'drop' && Math.floor((b - 28) / 2) % 2 === 1;
      add(useB ? kickB : kickA, t); truth.push([t, useB ? 'B' : 'A']);
    }
    if (sec === 'build' || sec === 'drop') {
      if (q % 2 === 1) add(clap, t);
      add(hat, t + beat / 2);
    }
    if (sec === 'drop') add(revBass, t + beat / 2);
  }
  // lead / pad: detuned saws on a 4-chord progression (not locked to the kicks' waveform)
  if (sec !== 'intro') {
    const root = [440, 349.2, 392, 329.6][b % 4];
    const g = sec === 'break' ? 0.25 : 0.12;
    for (let i = 0; i < Math.round(4 * beat * sr); i++) {
      const t = i / sr, s = Math.round(((b * 4) * beat + 0.5) * sr) + i;
      if (s >= N) break;
      let v = 0;
      for (const f of [root, root * 1.005, root * 1.5]) v += 2 * ((t * f) % 1) - 1;
      mix[s] += g * v / 3;
    }
  }
}
for (let i = 0; i < N; i++) mix[i] = Math.tanh(1.2 * mix[i]) * 0.9; // crude "master limiter"

const out = process.argv.indexOf('--write');
if (out > 0) writeFileSync(process.argv[out + 1], Buffer.from(encodeWav(mix, sr)));

const t0 = Date.now();
const res = analyze(mix, sr, {}, (s, f) => process.stdout.write(`\r${s} ${(f * 100).toFixed(0)}%   `));
console.log(`\nDone in ${Date.now() - t0} ms`);
console.log(`BPM ${res.bpm.toFixed(2)} (truth 150), kicks ${res.totalKicks} (truth ${truth.length}), groups ${res.k}`);

// compare only the first 180 ms: after that, the synthetic drop has an off-beat reverse bass that is
// locked to the kick grid and therefore (correctly) survives the averaging
function corrAtBestLag(a, b) {
  let best = 0;
  const L = Math.min(a.length, b.length, Math.round(0.18 * sr)) - 200;
  for (let lag = -200; lag <= 200; lag++) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 200; i < L; i++) { const x = a[i], y = b[i + lag]; ab += x * y; aa += x * x; bb += y * y; }
    best = Math.max(best, ab / Math.sqrt(aa * bb));
  }
  return best;
}
const refA = kickA.map(v => Math.tanh(1.2 * v) * 0.9), refB = kickB.map(v => Math.tanh(1.2 * v) * 0.9);
let ok = Math.abs(res.bpm - 150) < 0.2 && Math.abs(res.totalKicks - truth.length) <= 3;
console.log(`rejected (not bass-heavy): ${res.rejected.length}`);
for (const [i, c] of res.clusters.entries()) {
  const ca = corrAtBestLag(c.median, refA), cb = corrAtBestLag(c.median, refB);
  const label = ca > cb ? 'A' : 'B';
  const truthCounts = { A: 0, B: 0 };
  for (const t of c.times) {
    const near = truth.reduce((p, q) => Math.abs(q[0] - t) < Math.abs(p[0] - t) ? q : p);
    truthCounts[near[1]]++;
  }
  console.log(`group ${i + 1}: n=${c.count} tail ${c.tailHz?.toFixed(1)} Hz (${c.note}) ` +
    `corr A ${ca.toFixed(3)} B ${cb.toFixed(3)} -> ${label}; members A=${truthCounts.A} B=${truthCounts.B}; ` +
    `cleanest @ ${c.cleanest.map(h => h.time.toFixed(2) + 's').join(', ')}`);
  if (Math.max(ca, cb) < 0.9) ok = false;
  if (Math.min(truthCounts.A, truthCounts.B) > 0.1 * c.count) ok = false; // groups should not mix A and B
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
