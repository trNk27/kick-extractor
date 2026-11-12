// Kick Extractor – DSP core.
// Pure functions, no DOM, so the same code runs in the browser (inside a Web Worker) and in Node (tests).
//
// Pipeline (see analyze() at the bottom):
//   1. low-band onset envelope  -> where does energy below ~150 Hz jump up?
//   2. tempo + beat grid        -> hardstyle is steady 4/4, so keep only onsets that sit on the beat
//                                  (this throws away off-beat reverse bass hits)
//   3. alignment                -> cross-correlate every kick against the median kick, shift to line up
//   4. features + k-means       -> group kicks that sound different (re-pitched kicks, kick + clap, filtered intro)
//   5. per group                -> sample-wise median / mean of all aligned kicks, plus a ranking of the
//                                  cleanest individual hits (the ones closest to the group median)

// ---------------------------------------------------------------- basics

export function mixToMono(channels) {
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// In-place iterative radix-2 FFT on Float64Arrays.
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// RBJ biquad low-pass, Butterworth Q.
export function lowpass(x, sr, fc) {
  const w0 = 2 * Math.PI * fc / sr;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0;
  const a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

// Sample-wise median of many equal-length segments of x, each starting at starts[k].
function medianOfSegments(x, starts, len, gains = null) {
  const n = starts.length;
  const out = new Float32Array(len);
  const col = new Float32Array(n);
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < n; k++) col[k] = x[starts[k] + i] / (gains ? gains[k] : 1);
    col.sort();
    out[i] = n % 2 ? col[(n - 1) >> 1] : 0.5 * (col[n / 2 - 1] + col[n / 2]);
  }
  return out;
}

function meanOfSegments(x, starts, len, gains = null) {
  const out = new Float64Array(len);
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], g = gains ? gains[k] : 1;
    for (let i = 0; i < len; i++) out[i] += x[s + i] / g;
  }
  const r = new Float32Array(len);
  for (let i = 0; i < len; i++) r[i] = out[i] / starts.length;
  return r;
}

function dot(a, aOff, b, bOff, len) {
  let s = 0;
  for (let i = 0; i < len; i++) s += a[aOff + i] * b[bOff + i];
  return s;
}

// ---------------------------------------------------------------- 1. onset envelope

// Spectral flux: how much the (log-compressed) spectrum grows from one frame to the next, summed over
// 30 Hz–10 kHz. Works for kicks that are punchy/broadband (rawstyle) as well as for clean "boomy" ones.
// (A bass-only detector fails on rawstyle: the reverse bass swells up right before each kick, so the
// low end gets *quieter* when the kick hits.)
export function spectralFlux(x, sr, { hop = 256, frame = 1024 } = {}) {
  const nFrames = Math.max(0, Math.floor((x.length - frame) / hop) + 1);
  const win = new Float64Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame);
  const kLo = Math.max(1, Math.round(30 * frame / sr)), kHi = Math.min(frame / 2, Math.round(10000 * frame / sr));
  const re = new Float64Array(frame), im = new Float64Array(frame);
  let prev = new Float32Array(kHi - kLo + 1), cur = new Float32Array(kHi - kLo + 1);
  const flux = new Float32Array(nFrames);
  const norm = 2 / frame; // so a full-scale sine is ~1
  for (let f = 0; f < nFrames; f++) {
    const s = f * hop;
    for (let i = 0; i < frame; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let sum = 0;
    for (let k = kLo; k <= kHi; k++) {
      const m = Math.log1p(100 * norm * Math.hypot(re[k], im[k]));
      cur[k - kLo] = m;
      if (f > 0) { const d = m - prev[k - kLo]; if (d > 0) sum += d; }
    }
    flux[f] = sum;
    const t = prev; prev = cur; cur = t;
  }
  // a change shows up once it is inside the window's centre region -> onset ~ frame centre
  return { flux, hop, offset: frame / 2 };
}

// ---------------------------------------------------------------- 2. tempo + beat grid

function estimatePeriodFrames(flux, framesPerSec) {
  const n = flux.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n || 1;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = flux[i] - mean;
  const minLag = Math.floor(framesPerSec * 60 / 200);
  const maxLag = Math.ceil(framesPerSec * 60 / 90);
  let best = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < n; i++) ac += z[i] * z[i + lag];
    ac /= (n - lag);
    // gentle prior towards ~150 BPM (log-gaussian, ~0.6 octave wide)
    const bpm = framesPerSec * 60 / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 150) / 0.6, 2));
    const score = ac * w;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return best;
}

export function detectKicks(x, sr) {
  const { flux, hop, offset } = spectralFlux(x, sr);
  const fps = sr / hop;
  const p0 = estimatePeriodFrames(flux, fps); // frames

  // local maxima of the flux within +-0.2 beat
  const radius = Math.max(2, Math.floor(0.2 * p0));
  const peaks = [];
  for (let f = 1; f < flux.length - 1; f++) {
    const v = flux[f];
    if (v <= 0) continue;
    let isMax = true;
    for (let j = Math.max(0, f - radius); j <= Math.min(flux.length - 1, f + radius); j++) {
      if (flux[j] > v || (flux[j] === v && j < f)) { isMax = false; break; }
    }
    if (isMax) peaks.push(f);
  }
  const strengths = peaks.map(f => flux[f]);
  const thr = 0.3 * percentile(strengths, 0.9);
  const strong = peaks.filter(f => flux[f] >= thr);
  if (strong.length < 8) throw new Error('No clear kicks found in this file.');

  // Precise tempo + phase: maximise |sum w * exp(2*pi*i*t/P)| over P near the autocorrelation estimate.
  // This is a circular "periodogram" over the onset times; it is far more precise than the
  // autocorrelation lag, which matters because a 0.1 BPM error drifts by half a beat over a track.
  const times = strong.map(f => f * hop + offset); // samples
  const w = strong.map(f => flux[f]);
  const P0 = p0 * hop;
  const span = times[times.length - 1] - times[0];
  const nBeats = Math.max(1, span / P0);
  const step = 0.02 * P0 / nBeats;
  let bestP = P0, bestR = -1, bestPhase = 0;
  for (let P = P0 * 0.97; P <= P0 * 1.03; P += step) {
    let c = 0, s = 0;
    for (let k = 0; k < times.length; k++) {
      const a = 2 * Math.PI * times[k] / P;
      c += w[k] * Math.cos(a); s += w[k] * Math.sin(a);
    }
    const R = c * c + s * s;
    if (R > bestR) { bestR = R; bestP = P; bestPhase = Math.atan2(s, c); }
  }
  const t0 = (bestPhase / (2 * Math.PI)) * bestP; // a beat position (mod P)

  // Keep only onsets on the grid, one per beat (the strongest). Now that the grid is known we can use a
  // much lower threshold: a reverse bass ending right before the kick makes the kick's jump in low-band
  // energy small, and off-grid junk is excluded by position anyway.
  const lowThr = 0.08 * percentile(strengths, 0.9);
  const perBeat = new Map();
  for (const f of peaks) {
    if (flux[f] < lowThr) continue;
    const t = f * hop + offset;
    const pos = (t - t0) / bestP;
    const beat = Math.round(pos);
    if (Math.abs(pos - beat) > 0.12) continue;
    const prev = perBeat.get(beat);
    if (!prev || flux[f] > prev.w) perBeat.set(beat, { t, w: flux[f], beat });
  }
  const kicks = [...perBeat.values()].sort((a, b) => a.t - b.t);
  return {
    bpm: 60 * sr / bestP,
    periodSamples: bestP,
    times: kicks.map(k => k.t),
    beats: kicks.map(k => k.beat),
  };
}

// ---------------------------------------------------------------- 3. alignment

// Shift each time so its first `refLen` samples best match the median of all of them.
export function alignTimes(x, times, { pre, refLen, maxLag, iterations = 2 }) {
  let t = times.slice();
  const N = nextPow2(refLen + 2 * maxLag);
  for (let it = 0; it < iterations; it++) {
    const ref = medianOfSegments(x, t.map(v => v - pre), refLen);
    const rRe = new Float64Array(N), rIm = new Float64Array(N);
    for (let i = 0; i < refLen; i++) rRe[i] = ref[i];
    fft(rRe, rIm);
    const re = new Float64Array(N), im = new Float64Array(N);
    t = t.map(tk => {
      re.fill(0); im.fill(0);
      const s = tk - pre - maxLag;
      for (let i = 0; i < refLen + 2 * maxLag; i++) re[i] = x[s + i];
      fft(re, im);
      for (let i = 0; i < N; i++) { // seg * conj(ref)
        const a = re[i], b = im[i];
        re[i] = a * rRe[i] + b * rIm[i];
        im[i] = b * rRe[i] - a * rIm[i];
      }
      fft(re, im, true);
      let best = 0, bestV = -Infinity;
      for (let l = 0; l <= 2 * maxLag; l++) if (re[l] > bestV) { bestV = re[l]; best = l; }
      return tk + (best - maxLag);
    });
  }
  return t;
}

// ---------------------------------------------------------------- 4. features + clustering

function bandEdges(fLo, fHi, n) {
  const e = [];
  for (let i = 0; i <= n; i++) e.push(fLo * Math.pow(fHi / fLo, i / n));
  return e;
}

function bandDb(x, start, len, N, sr, edgeSets) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const L = Math.min(len, N);
  for (let i = 0; i < L; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)));
  fft(re, im);
  const out = [];
  const binHz = sr / N;
  for (const edges of edgeSets) {
    for (let b = 0; b < edges.length - 1; b++) {
      const lo = Math.max(1, Math.floor(edges[b] / binHz)), hi = Math.max(lo + 1, Math.ceil(edges[b + 1] / binHz));
      let e = 0;
      for (let k = lo; k < hi && k < N / 2; k++) e += re[k] * re[k] + im[k] * im[k];
      out.push(10 * Math.log10(e / (hi - lo) + 1e-12));
    }
  }
  return out;
}

// Features per kick: attack spectrum (first 60 ms) and tail spectrum (60 ms -> end),
// with fine (1/6 octave) resolution 30–250 Hz on the tail so re-pitched kicks separate.
export function kickFeatures(x, starts, len, sr) {
  const split = Math.round(0.06 * sr);
  const hiBands = bandEdges(250, Math.min(12000, sr / 2 - 100), 20);
  const lowFine = bandEdges(30, 250, 18);
  const Na = nextPow2(split);
  const tailLen = Math.max(256, len - split);
  const Nt = Math.min(16384, nextPow2(tailLen));
  // Weights: the tail pitch region matters most (re-pitched kicks), the attack next (claps / layered
  // snares on 2 & 4). The tail's upper bands mostly carry the melody, which we don't want to cluster on.
  const W_ATTACK = 1, W_LOW = 3, W_TAILHI = 0.3;
  const nLow = lowFine.length - 1;
  return starts.map(s => {
    const a = bandDb(x, s, split, Na, sr, [hiBands]).map(v => v * W_ATTACK);
    const t = bandDb(x, s + split, tailLen, Nt, sr, [lowFine, hiBands]).map((v, i) => v * (i < nLow ? W_LOW : W_TAILHI));
    return [...a, ...t];
  });
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

export function kmeans(X, k, { restarts = 6, iters = 60, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const n = X.length, d = X[0].length;
  let best = null;
  for (let r = 0; r < restarts; r++) {
    // k-means++ init
    const C = [X[Math.floor(rand() * n)].slice()];
    const D = new Float64Array(n);
    while (C.length < k) {
      let sum = 0;
      for (let i = 0; i < n; i++) { D[i] = Math.min(...C.map(c => dist2(X[i], c))); sum += D[i]; }
      let u = rand() * sum, idx = 0;
      for (; idx < n - 1; idx++) { u -= D[idx]; if (u <= 0) break; }
      C.push(X[idx].slice());
    }
    const labels = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bl = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const dd = dist2(X[i], C[c]); if (dd < bd) { bd = dd; bl = c; } }
        if (labels[i] !== bl || it === 0) { changed = changed || labels[i] !== bl; labels[i] = bl; }
      }
      for (let c = 0; c < k; c++) {
        const m = new Float64Array(d); let cnt = 0;
        for (let i = 0; i < n; i++) if (labels[i] === c) { cnt++; for (let j = 0; j < d; j++) m[j] += X[i][j]; }
        if (cnt) for (let j = 0; j < d; j++) C[c][j] = m[j] / cnt;
      }
      if (!changed && it > 0) break;
    }
    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += dist2(X[i], C[labels[i]]);
    if (!best || inertia < best.inertia) best = { labels, inertia };
  }
  return best.labels;
}

function silhouette(X, labels, k) {
  const n = X.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const sums = new Float64Array(k), cnts = new Float64Array(k);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      sums[labels[j]] += Math.sqrt(dist2(X[i], X[j])); cnts[labels[j]]++;
    }
    const own = labels[i];
    if (cnts[own] === 0) continue;
    const a = sums[own] / cnts[own];
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && cnts[c]) b = Math.min(b, sums[c] / cnts[c]);
    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

export function chooseK(X, maxK = 6) {
  const rand = mulberry32(7);
  let S = X;
  if (X.length > 300) { // subsample for speed (silhouette is O(n^2))
    const idx = X.map((_, i) => i).sort(() => rand() - 0.5).slice(0, 300);
    S = idx.map(i => X[i]);
  }
  let bestK = 1, bestS = 0.2; // need a reasonably clear structure before splitting at all
  for (let k = 2; k <= Math.min(maxK, S.length - 1); k++) {
    const s = silhouette(S, kmeans(S, k, { restarts: 3 }), k);
    if (s > bestS + 0.02) { bestS = s; bestK = k; }
  }
  return bestK;
}

// ---------------------------------------------------------------- 5. per cluster

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(hz) {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// Strongest spectral peak 30–200 Hz in the tail (after 60 ms) = the pitch the kick is tuned to.
export function tailPitch(sig, sr) {
  const s = Math.round(0.06 * sr);
  const len = sig.length - s;
  if (len < 1024) return null;
  const N = 1 << 16; // heavy zero padding for a fine peak estimate
  const re = new Float64Array(N), im = new Float64Array(N);
  const L = Math.min(len, N);
  for (let i = 0; i < L; i++) re[i] = sig[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)));
  fft(re, im);
  const binHz = sr / N;
  let best = 0, bestV = -1;
  for (let k = Math.floor(30 / binHz); k <= Math.ceil(200 / binHz); k++) {
    const v = re[k] * re[k] + im[k] * im[k];
    if (v > bestV) { bestV = v; best = k; }
  }
  return best * binHz;
}

// Kick start = the sharpest 2 ms rise in loudness within -20/+15 ms of where we expect it.
// (A plain threshold fails when a reverse bass swells up right before the kick and is still in the
// pre-roll: it would trigger on the bass instead.)
function findOnset(sig, sr, hint) {
  const w = Math.max(1, Math.round(0.001 * sr));
  const n = Math.floor(sig.length / w);
  const env = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let e = 0;
    for (let i = b * w; i < (b + 1) * w; i++) e += sig[i] * sig[i];
    env[b] = Math.sqrt(e / w);
  }
  const lo = Math.max(0, Math.floor((hint - 0.02 * sr) / w));
  const hi = Math.min(n - 3, Math.floor((hint + 0.015 * sr) / w));
  let best = lo, bv = -Infinity;
  for (let b = lo; b <= hi; b++) { const r = env[b + 2] - env[b]; if (r > bv) { bv = r; best = b; } }
  return best * w;
}

function finishSample(sig, sr, onsetHint = null) {
  let peak = 0;
  for (const v of sig) peak = Math.max(peak, Math.abs(v));
  let start;
  if (onsetHint != null) {
    start = Math.max(0, findOnset(sig, sr, onsetHint) - Math.round(0.002 * sr));
  } else {
    // no hint (e.g. the off-beat part): start shortly before the first strong sample
    let on = 0;
    while (on < sig.length && Math.abs(sig[on]) < 0.25 * peak) on++;
    start = Math.max(0, on - Math.round(0.004 * sr));
  }
  const out = sig.slice(start);
  // 0.5 ms fade-in, 10 ms fade-out, normalise to -0.3 dBFS
  const fi = Math.max(1, Math.round(0.0005 * sr)), fo = Math.max(1, Math.round(0.01 * sr));
  for (let i = 0; i < fi && i < out.length; i++) out[i] *= i / fi;
  for (let i = 0; i < fo && i < out.length; i++) out[out.length - 1 - i] *= i / fo;
  let p = 0;
  for (const v of out) p = Math.max(p, Math.abs(v));
  if (p > 0) { const g = Math.pow(10, -0.3 / 20) / p; for (let i = 0; i < out.length; i++) out[i] *= g; }
  return { sig: out, trim: start };
}

// Where does the kick end and the off-beat sound (reverse bass etc.) begin? Rawstyle kicks are hard-cut
// right before the off-beat, which leaves a short, near-silent gap. Returns a sample index or null.
export function findSplit(sig, sr) {
  const w = Math.max(1, Math.round(0.002 * sr));
  const n = Math.floor(sig.length / w);
  if (n < 20) return null;
  const env = new Float64Array(n);
  let mx = 0;
  for (let b = 0; b < n; b++) {
    let e = 0;
    for (let i = b * w; i < (b + 1) * w; i++) e += sig[i] * sig[i];
    env[b] = Math.sqrt(e / w);
    mx = Math.max(mx, env[b]);
  }
  let best = -1, bv = Infinity;
  for (let b = Math.floor(n * 0.2); b < Math.floor(n * 0.85); b++) if (env[b] < bv) { bv = env[b]; best = b; }
  return best >= 0 && bv < 0.06 * mx ? best * w + (w >> 1) : null;
}

// Highest normalised cross-correlation between two signals within +-maxLag samples.
function bestCorr(a, b, maxLag) {
  const L = Math.min(a.length, b.length) - 2 * maxLag;
  if (L <= 0) return 0;
  let best = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = maxLag; i < maxLag + L; i++) {
      const p = a[i], q = b[i + lag];
      ab += p * q; aa += p * p; bb += q * q;
    }
    if (aa > 0 && bb > 0) best = Math.max(best, ab / Math.sqrt(aa * bb));
  }
  return best;
}

// Align, level-match and average one group of hits.
function summarizeGroup(rawTimes, { x, sr, pre, len, refLen, maxLag, nClean }) {
  // Align within the group: different kick variants have different shapes, so a reference built
  // from all kicks at once would be mush. Each pass re-builds the group median and re-aligns to it.
  let t = rawTimes.slice();
  if (t.length >= 3) t = alignTimes(x, t, { pre, refLen, maxLag, iterations: 3 });
  const starts = t.map(v => v - pre);

  // level-match every hit to the group median before averaging (intro kicks are often quieter)
  const m0 = medianOfSegments(x, starts, len);
  const mm = dot(m0, 0, m0, 0, len) || 1;
  const gains = starts.map(s => {
    const g = dot(x, s, m0, 0, len) / mm;
    return g > 0.2 ? g : 1;
  });
  const medianRaw = t.length >= 3 ? medianOfSegments(x, starts, len, gains) : m0;
  const meanRaw = meanOfSegments(x, starts, len, gains);

  // cleanliness = how much of each single hit is explained by the group median (1 = identical shape)
  const m2 = dot(medianRaw, 0, medianRaw, 0, len);
  const scored = starts.map((s, j) => {
    const xx = dot(x, s, x, s, len), xm = dot(x, s, medianRaw, 0, len);
    return { j, time: t[j] / sr, match: xx > 0 && m2 > 0 ? (xm * xm) / (xx * m2) : 0 };
  }).sort((a, b) => b.match - a.match);
  const meanMatch = scored.reduce((a, s) => a + s.match, 0) / scored.length;

  const med = finishSample(medianRaw, sr, pre);
  const mean = finishSample(meanRaw, sr, pre);

  let parts = null;
  const split = findSplit(med.sig, sr);
  if (split != null) {
    parts = {
      splitAt: split / med.sig.length,
      kick: finishSample(med.sig.slice(0, split), sr).sig,
      offbeat: finishSample(med.sig.slice(split), sr).sig,
    };
  }
  const pitch = tailPitch(parts ? parts.kick : med.sig, sr);
  const cleanest = scored.slice(0, nClean).map(s => ({
    time: s.time,
    match: s.match,
    sig: finishSample(x.slice(starts[s.j], starts[s.j] + len), sr, pre).sig,
  }));
  return {
    count: t.length,
    times: t.map(v => v / sr),
    median: med.sig,
    mean: mean.sig,
    parts,
    tailHz: pitch,
    note: pitch ? noteName(pitch) : null,
    meanMatch,
    rms: Math.sqrt(m2 / len),
    quality: meanMatch * Math.min(1, t.length / 32), // re-weighted by loudness in analyze()
    noisy: meanMatch < 0.2 || t.length < 4,
    cleanest,
    medianRaw,
    rawTimes,
  };
}

// ---------------------------------------------------------------- full pipeline

/**
 * @param {Float32Array} x  mono audio
 * @param {number} sr
 * @param {{lengthMs?: number|null, k?: number|null, nCleanest?: number}} opts
 * @param {(stage: string, frac: number) => void} onProgress
 */
export function analyze(x, sr, opts = {}, onProgress = () => {}) {
  onProgress('Finding kicks', 0.05);
  const det = detectKicks(x, sr);

  // Detected onsets can be ~10–15 ms late (the onset function reacts once the attack is inside the
  // analysis frame), so keep a generous pre-roll; finishSample() trims the silence again later.
  const pre = Math.round(0.025 * sr);
  const maxLag = Math.round(0.020 * sr);
  const refLen = Math.round(0.080 * sr);
  const autoLen = Math.min(0.6 * sr, 0.95 * det.periodSamples);
  const len = Math.round(opts.lengthMs ? opts.lengthMs / 1000 * sr : autoLen) + pre;

  // drop kicks too close to the file edges
  const margin = pre + maxLag + 2;
  let times = det.times.filter(t => t - margin >= 0 && t + len + maxLag < x.length);
  if (times.length < 8) throw new Error('Too few kicks found to build an average.');

  // Throw out "kicks" that aren't bass-heavy (chord changes etc. that happened to land on the grid).
  // A real hardstyle kick puts most of its energy below ~200 Hz.
  const lp = lowpass(lowpass(x, sr, 200), sr, 200);
  const lowShare = times.map(t => {
    const s = t - pre, L = Math.min(len, Math.round(0.15 * sr));
    const e = dot(x, s, x, s, L);
    return e > 0 ? dot(lp, s, lp, s, L) / e : 0;
  });
  const shareCut = 0.2 * percentile(lowShare, 0.5); // distorted rawstyle kicks can have only ~25 % below 200 Hz
  const rejected = times.filter((_, i) => lowShare[i] < shareCut).map(t => t / sr);
  times = times.filter((_, i) => lowShare[i] >= shareCut);
  if (times.length < 8) throw new Error('Too few kicks found to build an average.');

  onProgress('Grouping kick types', 0.3);
  let feats = kickFeatures(x, times.map(t => t - pre), len, sr);
  // centre each dimension (dB values keep their natural scale)
  const d = feats[0].length;
  const mu = new Float64Array(d);
  for (const f of feats) for (let j = 0; j < d; j++) mu[j] += f[j] / feats.length;
  feats = feats.map(f => f.map((v, j) => v - mu[j]));

  // Auto mode: deliberately over-cluster, then merge groups whose averaged sounds turn out (nearly)
  // identical. Picking k up front (silhouette etc.) proved unreliable on real tracks, where the clean
  // drop kick is easily lumped together with melodic sections that just have a sub bass under the kick.
  const auto = !opts.k;
  const k = auto ? Math.min(8, Math.max(2, Math.floor(times.length / 20))) : opts.k;
  const labels = k === 1 ? new Int32Array(times.length) : kmeans(feats, k);
  let groups = [];
  for (let c = 0; c < k; c++) {
    const idx = [];
    for (let i = 0; i < times.length; i++) if (labels[i] === c) idx.push(i);
    if (idx.length) groups.push(idx.map(i => times[i]));
  }

  const ctx = { x, sr, pre, len, refLen, maxLag, nClean: opts.nCleanest ?? 3 };
  onProgress('Averaging', 0.45);
  let summaries = groups.map((g, gi) => {
    onProgress('Averaging', 0.45 + 0.35 * gi / groups.length);
    return summarizeGroup(g, ctx);
  });

  if (auto) {
    onProgress('Merging similar groups', 0.85);
    for (let round = 0; round < 6; round++) {
      let best = null;
      for (let i = 0; i < summaries.length; i++) for (let j = i + 1; j < summaries.length; j++) {
        const c = bestCorr(summaries[i].medianRaw, summaries[j].medianRaw, Math.round(0.005 * sr));
        if (c > 0.85 && (!best || c > best.c)) best = { i, j, c };
      }
      if (!best) break;
      const merged = summarizeGroup([...summaries[best.i].rawTimes, ...summaries[best.j].rawTimes].sort((p, q) => p - q), ctx);
      summaries = summaries.filter((_, n) => n !== best.i && n !== best.j);
      summaries.push(merged);
    }
  }

  // Best first: consistent groups with enough hits, weighted by loudness. In hardstyle the drop kick is
  // the loudest thing in the track, while melodic sections have a quieter kick buried in sub bass.
  const maxRms = Math.max(...summaries.map(g => g.rms)) || 1;
  for (const g of summaries) g.quality *= Math.sqrt(g.rms / maxRms);
  summaries.sort((p, q) => (p.noisy - q.noisy) || (q.quality - p.quality));
  const clusters = summaries.map(({ medianRaw, rawTimes, rms, ...rest }) => rest);

  return {
    bpm: det.bpm, sampleRate: sr, k: clusters.length, totalKicks: times.length, rejected, clusters,
    windowPre: pre / sr, windowLen: len / sr, // each hit's window is [time - windowPre, time - windowPre + windowLen]
  };
}

// ---------------------------------------------------------------- WAV export (24-bit PCM mono)

export function encodeWav(sig, sr) {
  const bytesPerSample = 3;
  const dataLen = sig.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * bytesPerSample, true);
  v.setUint16(32, bytesPerSample, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < sig.length; i++) {
    const s = Math.max(-1, Math.min(1, sig[i]));
    const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
    v.setUint8(o, n & 0xff); v.setUint8(o + 1, (n >> 8) & 0xff); v.setUint8(o + 2, (n >> 16) & 0xff);
    o += 3;
  }
  return buf;
}
