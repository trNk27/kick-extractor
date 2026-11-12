import { mixToMono, encodeWav } from './dsp.js';

const COLORS = ['#ff4b5c', '#1cb0ff', '#1fd15f', '#ffb020', '#b18cff', '#2fd8c6', '#ff7ad9', '#c8d84a'];
const LETTERS = 'ABCDEFGH';
const $ = (s) => document.querySelector(s);

let song = null;     // { x: Float32Array, sr, name }
let result = null;
let runId = 0;
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// ------------------------------------------------------------------ worker

worker.onmessage = (e) => {
  const m = e.data;
  if (m.id !== runId) return; // stale run (settings changed meanwhile)
  if (m.type === 'progress') setStatus(m.stage, m.frac);
  else if (m.type === 'result') { setStatus(null); result = m.result; render(); }
  else if (m.type === 'error') { setStatus(null); showError(m.message); }
};
worker.onerror = (e) => { setStatus(null); showError('The analysis crashed: ' + (e.message || 'unknown error')); };

function run() {
  if (!song) return;
  runId++;
  showError(null);
  setStatus('Starting', 0.02);
  const k = $('#optK').value, len = $('#optLen').value;
  worker.postMessage({ type: 'analyze', id: runId, opts: { k: k ? +k : null, lengthMs: len ? +len : null, nCleanest: 5 } });
}

// ------------------------------------------------------------------ file input

async function loadFile(file) {
  if (!file) return;
  stopPlayback();
  $('#fileName').textContent = file.name;
  $('#results').hidden = true;
  showError(null);
  setStatus('Decoding', 0.01);
  try {
    const buf = await file.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new Ctx(1, 1, 44100).decodeAudioData(buf);
    const chans = [];
    for (let c = 0; c < ab.numberOfChannels; c++) chans.push(ab.getChannelData(c));
    const x = mixToMono(chans);
    song = { x, sr: ab.sampleRate, name: file.name.replace(/\.[^.]+$/, '') };
    const copy = x.slice();
    worker.postMessage({ type: 'load', x: copy, sr: ab.sampleRate }, [copy.buffer]);
    run();
  } catch (err) {
    setStatus(null);
    showError("Couldn't decode this file. Try an MP3 or WAV.");
    console.error(err);
  }
}

$('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
$('#optK').addEventListener('change', run);
$('#optLen').addEventListener('change', run);

// ------------------------------------------------------------------ status

function setStatus(label, frac) {
  const el = $('#status');
  if (label == null) { el.hidden = true; return; }
  el.hidden = false;
  $('#statusLabel').textContent = label + '…';
  $('#statusBar').style.width = Math.round(Math.max(0.02, frac) * 100) + '%';
}

function showError(msg) {
  const el = $('#error');
  el.hidden = !msg;
  el.textContent = msg || '';
}

// ------------------------------------------------------------------ audio playback

let actx = null, current = null;

function stopPlayback() {
  if (!current) return;
  try { current.src.stop(); } catch { /* already stopped */ }
  current.btn?.classList.remove('playing');
  if (current.btn) current.btn.textContent = '▶';
  current = null;
}

function play(sig, sr, btn) {
  const same = current && current.btn === btn;
  stopPlayback();
  if (same) return; // second tap = stop
  actx ??= new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();
  const b = actx.createBuffer(1, sig.length, sr);
  b.copyToChannel(sig, 0);
  const src = actx.createBufferSource();
  src.buffer = b;
  src.connect(actx.destination);
  src.start();
  current = { src, btn };
  btn.classList.add('playing');
  btn.textContent = '■';
  src.onended = () => { if (current?.src === src) stopPlayback(); };
}

// ------------------------------------------------------------------ downloads

function download(sig, sr, filename) {
  const blob = new Blob([encodeWav(sig, sr)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const safe = (s) => s.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60);

// ------------------------------------------------------------------ drawing

function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

// Min/max waveform of sig[from..to). colorAt(sampleIndex) picks the colour per column.
function drawWave(cv, sig, from, to, colorAt, { gain = null } = {}) {
  const { g, w, h } = sizeCanvas(cv);
  g.clearRect(0, 0, w, h);
  from = Math.max(0, Math.floor(from)); to = Math.min(sig.length, Math.ceil(to));
  const n = to - from;
  if (n <= 0) return { g, w, h };
  let peak = gain;
  if (peak == null) { peak = 1e-6; for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(sig[i])); }
  const mid = h / 2, amp = (h / 2 - 4) / peak;
  g.lineWidth = 1;
  for (let px = 0; px < w; px++) {
    const a = from + Math.floor(px / w * n), b = Math.max(a + 1, from + Math.floor((px + 1) / w * n));
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < b; i++) { const v = sig[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.strokeStyle = colorAt(a);
    g.beginPath();
    g.moveTo(px + 0.5, mid - hi * amp);
    g.lineTo(px + 0.5, mid - lo * amp + 0.5);
    g.stroke();
  }
  return { g, w, h };
}

const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

// ------------------------------------------------------------------ results

function render() {
  const r = result;
  const { x, sr } = song;
  $('#results').hidden = false;

  const ignored = r.rejected.length ? ` · ${r.rejected.length} non-kick hits ignored` : '';
  const nGood = r.clusters.filter((c) => !c.noisy).length;
  $('#summary').innerHTML =
    `<b>${escapeHtml(song.name)}</b><span>${r.bpm.toFixed(1)} BPM · ${r.totalKicks} kicks · ` +
    `${nGood} kick type${nGood !== 1 ? 's' : ''}${ignored}</span>`;

  // per-hit ownership (for colouring the overview): which group owns which sample range
  const spans = [];
  r.clusters.forEach((c, ci) => c.times.forEach((t) => {
    const a = Math.round((t - r.windowPre) * sr);
    spans.push([a, a + Math.round(r.windowLen * sr), ci]);
  }));
  spans.sort((p, q) => p[0] - q[0]);

  const drawOverview = () => {
    const cv = $('#overview');
    let si = 0;
    const { g, w, h } = drawWave(cv, x, 0, x.length, (i) => {
      while (si < spans.length && spans[si][1] < i) si++;
      return si < spans.length && spans[si][0] <= i ? COLORS[spans[si][2] % COLORS.length] + 'cc' : '#5b5b68';
    });
    // kick ticks along the bottom
    r.clusters.forEach((c, ci) => {
      g.fillStyle = COLORS[ci % COLORS.length];
      for (const t of c.times) g.fillRect(Math.round(t * sr / x.length * w), h - 4, 1.5, 4);
    });
  };

  const rows = $('#rows'), noisyRows = $('#noisyRows');
  rows.innerHTML = '';
  noisyRows.innerHTML = '';
  const nNoisy = r.clusters.filter((c) => c.noisy).length;
  $('#noisyWrap').hidden = !nNoisy;
  $('#noisySummary').textContent = `${nNoisy} noisy group${nNoisy > 1 ? 's' : ''}`;
  const drawers = [drawOverview];

  r.clusters.forEach((c, ci) => {
    const color = COLORS[ci % COLORS.length];
    const label = 'Kick ' + LETTERS[ci];
    const row = $('#rowTpl').content.firstElementChild.cloneNode(true);
    row.style.setProperty('--c', color);
    row.querySelector('.tag').textContent = label;
    const pitch = c.tailHz ? ` · tail ≈ ${c.tailHz.toFixed(0)} Hz (${c.note})` : '';
    row.querySelector('.meta').textContent = `${c.count} hit${c.count > 1 ? 's' : ''}${pitch} · first at ${fmtTime(c.times[0])}`;

    // left box: the song around the first appearance (2 beats before -> 2 beats after the kick window)
    const beat = 60 / r.bpm;
    const kA = Math.round((c.times[0] - r.windowPre) * sr);
    const kB = kA + Math.round(r.windowLen * sr);
    const cA = Math.max(0, kA - Math.round(2 * beat * sr));
    const cB = Math.min(x.length, kB + Math.round(2 * beat * sr));
    const ctxCv = row.querySelector('.ctx canvas');
    drawers.push(() => {
      const { g, w, h } = drawWave(ctxCv, x, cA, cB, (i) => (i >= kA && i < kB ? color : '#6b6b78'));
      const xa = (kA - cA) / (cB - cA) * w, xb = (kB - cA) / (cB - cA) * w;
      g.fillStyle = color + '22';
      g.fillRect(xa, 0, xb - xa, h);
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.strokeRect(xa + 0.75, 0.75, xb - xa - 1.5, h - 1.5);
    });
    row.querySelector('.ctx .play').onclick = (e) => play(x.subarray(cA, cB), sr, e.currentTarget);

    // right box: the extracted kick
    const kickCv = row.querySelector('.kick canvas');
    drawers.push(() => {
      const { g, w, h } = drawWave(kickCv, c.median, 0, c.median.length, () => color);
      if (c.parts) { // where the kick ends and the off-beat part begins
        const xs = Math.round(c.parts.splitAt * w) + 0.5;
        g.save();
        g.setLineDash([4, 4]);
        g.strokeStyle = '#ffffffcc';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(xs, 0); g.lineTo(xs, h); g.stroke();
        g.restore();
        g.fillStyle = '#ffffffb0';
        g.font = '10px system-ui, sans-serif';
        g.fillText('kick', 4, h - 4);
        g.fillText('off-beat', xs + 4, h - 4);
      }
    });
    row.querySelector('.kick .play').onclick = (e) => play(c.median, sr, e.currentTarget);

    const base = `${safe(song.name)}_kick-${LETTERS[ci]}${c.note ? '_' + c.note.replace('#', 's') : ''}`;
    const ms = (sig) => `${Math.round(sig.length / sr * 1000)} ms`;
    const parts = c.parts
      ? [
        { label: 'Kick only', sig: c.parts.kick, file: 'kick', main: true },
        { label: 'Off-beat part', hint: 'reverse bass etc.', sig: c.parts.offbeat, file: 'offbeat' },
        { label: 'Full beat', sig: c.median, file: 'fullbeat' },
        { label: 'Full beat, mean', hint: 'smoother, outliers leak in', sig: c.mean, file: 'fullbeat_mean' },
      ]
      : [
        { label: 'Kick', sig: c.median, file: 'median', main: true },
        { label: 'Kick, mean', hint: 'smoother, outliers leak in', sig: c.mean, file: 'mean' },
      ];
    const pl = row.querySelector('.parts');
    for (const p of parts) {
      const li = document.createElement('li');
      if (p.main) li.className = 'main';
      li.innerHTML = `<button class="play small" aria-label="Play">▶</button>` +
        `<span class="label"><b>${p.label}</b><small>${p.hint ? p.hint + ' · ' : ''}${ms(p.sig)}</small></span>` +
        `<button class="dl small">⬇ WAV</button>`;
      li.querySelector('.play').onclick = (e) => play(p.sig, sr, e.currentTarget);
      li.querySelector('.dl').onclick = () => download(p.sig, sr, `${base}_${p.file}.wav`);
      pl.appendChild(li);
    }

    const ul = row.querySelector('.singles ul');
    c.cleanest.forEach((hit, hi) => {
      const li = document.createElement('li');
      li.innerHTML = `<button class="play small" aria-label="Play">▶</button>` +
        `<span class="t">${fmtTime(hit.time)}</span>` +
        `<span class="m" title="How closely this hit matches the averaged kick">${(hit.match * 100).toFixed(1)}% match</span>` +
        `<button class="dl small">⬇ WAV</button>`;
      li.querySelector('.play').onclick = (e) => play(hit.sig, sr, e.currentTarget);
      li.querySelector('.dl').onclick = () => download(hit.sig, sr, `${base}_hit${hi + 1}_${hit.time.toFixed(2)}s.wav`);
      ul.appendChild(li);
    });

    (c.noisy ? noisyRows : rows).appendChild(row);
  });

  $('#playSong').onclick = (e) => play(x, sr, e.currentTarget);
  redraw = () => drawers.forEach((d) => d());
  redraw();
}

let redraw = () => {};
// canvases inside a closed <details> have no size yet -> draw them when it opens
$('#noisyWrap').addEventListener('toggle', () => redraw());
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redraw(), 120); });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
