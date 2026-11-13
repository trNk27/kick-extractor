import { mixToMono } from './dsp.js';
import { preview, stopPreview, download } from './audio.js';
import { initLaunchpad, openPadPicker, CATEGORIES } from './launchpad.js';
import { initLibrary } from './library.js';
import { initTrack, redrawTrack } from './track.js';
import { load as loadStore, subscribe, state } from './store.js';
import { scene } from './scene.js';

// kick groups in the Extract tab (A, B, C ...)
const COLORS = ['#ff5a36', '#44a8ff', '#4fe08e', '#ffa21f', '#ff5c9d', '#3fd6c8', '#e6e36a', '#c9d2ea'];
const LETTERS = 'ABCDEFGH';
const $ = (s) => document.querySelector(s);

let song = null;     // { x: mono Float32Array, channels: Float32Array[], sr, name }
let result = null;
let runId = 0;
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// ------------------------------------------------------------------ tabs (bottom bar)

function selectTab(name) {
  document.querySelectorAll('.nav-btn').forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
  document.body.dataset.tab = name;
  $('#toast').classList.remove('show');
  stopPreview();
  if (name === 'extract') redraw();
  if (name === 'track') redrawTrack();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('.nav-btn').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
window.addEventListener('kx:tab', (e) => selectTab(e.detail));

scene.init();
initLaunchpad();
initLibrary();
initTrack();
subscribe(() => {
  const n = state.pads.filter(Boolean).length;
  const b = $('#lpCount');
  const prev = +b.textContent;
  b.textContent = n;
  b.hidden = n === 0;
  if (n > prev) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
});
loadStore();

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
  stopPreview();
  $('#fileName').textContent = file.name;
  $('#results').hidden = true;
  showError(null);
  setStatus('Decoding', 0.01);
  try {
    const buf = await file.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new Ctx(1, 1, 44100).decodeAudioData(buf);
    const channels = [];
    for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) channels.push(ab.getChannelData(c).slice());
    const x = mixToMono(channels);
    song = { x, channels, sr: ab.sampleRate, name: file.name.replace(/\.[^.]+$/, '') };
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

// ------------------------------------------------------------------ buttons next to each sound

const safe = (s) => s.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60);

// ⬇ WAV  ⬇ MP3  +LP
function actionButtons(sig, sr, filenameBase, lpSound) {
  const wrap = document.createElement('span');
  wrap.className = 'dls';
  for (const fmt of ['wav', 'mp3']) {
    const b = document.createElement('button');
    b.className = 'dl small dl-' + fmt;
    b.textContent = '⬇ ' + fmt.toUpperCase();
    if (fmt === 'mp3') b.title = 'MP3 adds ~25 ms of silence at the start (encoder delay). Use WAV for producing.';
    b.onclick = () => download(sig, sr, filenameBase, fmt).catch((err) => showError(err.message || String(err)));
    wrap.appendChild(b);
  }
  const lp = document.createElement('button');
  lp.className = 'lp-add';
  lp.textContent = '+LP';
  lp.title = 'Save to your library and put it on a Launchpad pad';
  lp.style.setProperty('--pc', CATEGORIES[lpSound.category].color);
  lp.onclick = () => openPadPicker({ sound: { sr, channels: Array.isArray(sig) ? sig : [sig], song: song.name, ...lpSound } });
  wrap.appendChild(lp);
  return wrap;
}

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
function drawWave(cv, sig, from, to, colorAt) {
  const { g, w, h } = sizeCanvas(cv);
  g.clearRect(0, 0, w, h);
  from = Math.max(0, Math.floor(from)); to = Math.min(sig.length, Math.ceil(to));
  const n = to - from;
  if (n <= 0 || w < 2) return { g, w, h };
  let peak = 1e-6;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(sig[i]));
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

// stereo slice of the song with 2 ms fades (for snippets)
function sliceSong(startSec, durSec) {
  const { channels, sr } = song;
  const a = Math.max(0, Math.round(startSec * sr));
  const n = Math.min(channels[0].length - a, Math.round(durSec * sr));
  const f = Math.round(0.002 * sr);
  return channels.map((ch) => {
    const out = ch.slice(a, a + n);
    for (let i = 0; i < f && i < n; i++) { out[i] *= i / f; out[n - 1 - i] *= i / f; }
    return out;
  });
}

// ------------------------------------------------------------------ results

function render() {
  const r = result;
  const { x, sr } = song;
  $('#results').hidden = false;

  const nGood = r.clusters.filter((c) => !c.noisy).length;
  $('#summary').innerHTML =
    `<b>${escapeHtml(song.name)}</b><span class="facts"><span>${r.bpm.toFixed(1)} BPM</span><span>${r.totalKicks} kicks</span>` +
    `<span>${nGood} kick type${nGood !== 1 ? 's' : ''}</span>` +
    (r.rejected.length ? `<span>${r.rejected.length} non-kick hits ignored</span>` : '') + `</span>`;

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
    r.clusters.forEach((c, ci) => { // kick ticks along the bottom
      g.fillStyle = COLORS[ci % COLORS.length];
      for (const t of c.times) g.fillRect(Math.round(t * sr / x.length * w), h - 4, 1.5, 4);
    });
    for (const s of r.snippets) { // snippet ranges along the top
      g.fillStyle = CATEGORIES[s.category].color;
      const xa = s.start * sr / x.length * w, xb = (s.start + s.duration) * sr / x.length * w;
      g.fillRect(xa, 0, Math.max(2, xb - xa), 4);
    }
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
    const L = LETTERS[ci];
    const row = $('#rowTpl').content.firstElementChild.cloneNode(true);
    row.style.setProperty('--c', color);
    row.querySelector('.tag').textContent = 'Kick ' + L;
    row.querySelector('.meta').innerHTML = `<span>${c.count} hit${c.count > 1 ? 's' : ''}</span>` +
      (c.tailHz ? `<span>tuned to ${c.note} (${c.tailHz.toFixed(0)} Hz)</span>` : '') +
      `<span>first at ${fmtTime(c.times[0])}</span>`;

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
    row.querySelector('.ctx .play').onclick = (e) => preview(x.subarray(cA, cB), sr, e.currentTarget);

    // right box: the extracted kick
    const kickCv = row.querySelector('.kick canvas');
    drawers.push(() => {
      const { g, w, h } = drawWave(kickCv, c.median, 0, c.median.length, () => color);
      if (c.parts) { // where the kick ends and the off-beat part begins
        const xs = Math.round(c.parts.splitAt * w) + 0.5;
        g.save();
        g.setLineDash([4, 4]);
        g.strokeStyle = '#ffffffcc';
        g.beginPath(); g.moveTo(xs, 0); g.lineTo(xs, h); g.stroke();
        g.restore();
        g.fillStyle = '#ffffffb0';
        g.font = '10px system-ui, sans-serif';
        g.fillText('kick', 4, h - 4);
        g.fillText('off-beat', xs + 4, h - 4);
      }
    });
    row.querySelector('.kick .play').onclick = (e) => preview(c.median, sr, e.currentTarget);

    const base = `${safe(song.name)}_kick-${L}${c.note ? '_' + c.note.replace('#', 's') : ''}`;
    const ms = (sig) => `${Math.round(sig.length / sr * 1000)} ms`;
    const parts = c.parts
      ? [
        { label: 'Kick only', sig: c.parts.kick, file: 'kick', main: true, lp: { name: `Kick ${L}`, category: 'kick' } },
        { label: 'Off-beat part', hint: 'reverse bass etc.', sig: c.parts.offbeat, file: 'offbeat', lp: { name: `Off-beat ${L}`, category: 'offbeat' } },
        { label: 'Full beat', sig: c.median, file: 'fullbeat', lp: { name: `Beat ${L}`, category: 'beat' } },
        { label: 'Full beat, mean', hint: 'smoother, outliers leak in', sig: c.mean, file: 'fullbeat_mean', lp: { name: `Beat ${L} (mean)`, category: 'beat' } },
      ]
      : [
        { label: 'Kick', sig: c.median, file: 'median', main: true, lp: { name: `Kick ${L}`, category: 'kick' } },
        { label: 'Kick, mean', hint: 'smoother, outliers leak in', sig: c.mean, file: 'mean', lp: { name: `Kick ${L} (mean)`, category: 'kick' } },
      ];
    const pl = row.querySelector('.parts');
    for (const p of parts) {
      const li = document.createElement('li');
      if (p.main) li.className = 'main';
      li.innerHTML = `<button class="play small" aria-label="Play">▶</button>` +
        `<span class="label"><b>${p.label}</b><small>${ms(p.sig)}</small>${p.hint ? `<small>${p.hint}</small>` : ''}</span>`;
      li.querySelector('.play').onclick = (e) => preview(p.sig, sr, e.currentTarget);
      li.appendChild(actionButtons(p.sig, sr, `${base}_${p.file}`, p.lp));
      pl.appendChild(li);
    }

    const ul = row.querySelector('.singles ul');
    c.cleanest.forEach((hit, hi) => {
      const li = document.createElement('li');
      li.innerHTML = `<button class="play small" aria-label="Play">▶</button>` +
        `<span class="t">${fmtTime(hit.time)}</span>` +
        `<span class="m" title="How closely this hit matches the averaged kick">${(hit.match * 100).toFixed(1)}% match</span>`;
      li.querySelector('.play').onclick = (e) => preview(hit.sig, sr, e.currentTarget);
      li.appendChild(actionButtons(hit.sig, sr, `${base}_hit${hi + 1}_${hit.time.toFixed(2)}s`,
        { name: `${L} hit ${fmtTime(hit.time).replace(/\.\d+$/, '')}`, category: 'hit' }));
      ul.appendChild(li);
    });

    (c.noisy ? noisyRows : rows).appendChild(row);
  });

  // ---- song snippets
  const snipWrap = $('#snippets');
  snipWrap.innerHTML = '';
  $('#snippetSection').hidden = !r.snippets.length;
  r.snippets.forEach((s) => {
    const cat = CATEGORIES[s.category];
    const card = $('#snipTpl').content.firstElementChild.cloneNode(true);
    card.style.setProperty('--c', cat.color);
    card.querySelector('.snip-name').textContent = s.label;
    card.querySelector('.snip-cat').textContent = cat.label;
    const bars = s.beats / 4;
    card.querySelector('.snip-meta').innerHTML =
      `<span>${bars >= 1 ? bars + ' bar' + (bars > 1 ? 's' : '') : s.beats + ' beats'}</span>` +
      `<span>${s.duration.toFixed(2)} s</span><span>at ${fmtTime(s.start)}</span>`;
    const audio = sliceSong(s.start, s.duration);
    const cv = card.querySelector('canvas');
    const a = Math.round(s.start * sr), b = a + audio[0].length;
    drawers.push(() => drawWave(cv, x, a, b, () => cat.color));
    card.querySelector('.play').onclick = (e) => preview(audio, sr, e.currentTarget);
    card.querySelector('.snip-actions').appendChild(actionButtons(audio, sr, `${safe(song.name)}_${safe(s.label)}`,
      { name: s.label, category: s.category, loop: s.loop, bpm: s.bpm, loopLen: s.duration }));
    snipWrap.appendChild(card);
  });

  $('#playSong').onclick = (e) => preview(x, sr, e.currentTarget);
  redraw = () => drawers.forEach((d) => d());
  redraw();

  // Share extracted kicks, off-beats, and snippets with Track Builder
  const extracted = [];
  r.clusters.forEach((c, ci) => {
    if (c.noisy) return;
    const L = LETTERS[ci];
    if (c.parts) {
      extracted.push({ key: `k-${L}`, name: `Kick ${L}`, category: 'kick', sr, channels: [c.parts.kick], loop: false, bpm: r.bpm, song: song.name });
      extracted.push({ key: `o-${L}`, name: `Off-beat ${L}`, category: 'offbeat', sr, channels: [c.parts.offbeat], loop: false, bpm: r.bpm, song: song.name });
      extracted.push({ key: `b-${L}`, name: `Beat ${L}`, category: 'beat', sr, channels: [c.median], loop: false, bpm: r.bpm, song: song.name });
    } else {
      extracted.push({ key: `k-${L}`, name: `Kick ${L}`, category: 'kick', sr, channels: [c.median], loop: false, bpm: r.bpm, song: song.name });
    }
    if (c.cleanest[0]) {
      const hit = c.cleanest[0];
      extracted.push({ key: `h-${L}`, name: `${L} hit ${fmtTime(hit.time).replace(/\.\d+$/, '')}`, category: 'hit', sr, channels: [hit.sig], loop: false, bpm: r.bpm, song: song.name });
    }
  });
  r.snippets.forEach((s, si) => {
    extracted.push({
      key: `s-${si}`,
      name: s.label,
      category: s.category,
      sr,
      channels: sliceSong(s.start, s.duration),
      loop: s.loop,
      bpm: s.bpm,
      loopLen: s.duration,
      song: song.name,
    });
  });
  window.dispatchEvent(new CustomEvent('kx:extracted', { detail: { bpm: r.bpm, sounds: extracted } }));
}

let redraw = () => {};
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { redraw(); redrawTrack(); }, 120);
});
// canvases inside a closed <details> have no size yet -> draw them when it opens
$('#noisyWrap').addEventListener('toggle', () => redraw());

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
