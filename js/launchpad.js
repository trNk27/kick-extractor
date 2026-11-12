// The Launchpad tab: a 4x4 sampler. Pads are grey until a sound is assigned, then take the colour of
// the sound's category. One-shots retrigger (and choke themselves); loops toggle and start on the
// next beat of whatever loop is already running, so they stay in time. Pads persist in IndexedDB.
import { audioCtx, makeBuffer, preview, stopPreview } from './audio.js';

export const CATEGORIES = {
  kick:    { label: 'Kick',         color: '#ff3d55' },
  offbeat: { label: 'Off-beat',     color: '#ff8a2b' },
  beat:    { label: 'Full beat',    color: '#ff4fcf' },
  hit:     { label: 'Single hit',   color: '#ffd43b' },
  loop:    { label: 'Loop',         color: '#22e57a' },
  break:   { label: 'Break',        color: '#9d7bff' },
  fx:      { label: 'Transition',   color: '#22d3ff' },
};

// physical key positions (so the 4x4 shape is the same on QWERTY and QWERTZ)
const KEY_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
let keyLabels = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];

const $ = (s) => document.querySelector(s);
let pads = new Array(16).fill(null);
const buffers = new Map();   // pad id -> AudioBuffer
const voices = new Map();    // pad index -> { src, gain, when }
let transport = null;        // { start, beat } while loops run
let master = null;
let editing = false;
let onCountChange = () => {};

// ---------------------------------------------------------------- persistence

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kick-extractor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function save() {
  try {
    const db = await idb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(pads, 'pads');
  } catch { /* private mode etc.: pads just won't survive a reload */ }
}
async function load() {
  try {
    const db = await idb();
    const v = await new Promise((res, rej) => {
      const r = db.transaction('kv').objectStore('kv').get('pads');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (Array.isArray(v) && v.length === 16) pads = v;
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- audio engine

function out() {
  const ctx = audioCtx();
  if (!master) {
    // gentle limiter so stacking pads doesn't clip
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -4; master.knee.value = 4; master.ratio.value = 12;
    master.attack.value = 0.002; master.release.value = 0.12;
    master.connect(ctx.destination);
  }
  return master;
}

function bufferFor(pad) {
  let b = buffers.get(pad.id);
  if (!b) { b = makeBuffer(pad.channels, pad.sr); buffers.set(pad.id, b); }
  return b;
}

const loopsRunning = () => [...voices.entries()].some(([i]) => pads[i]?.loop);

function stopVoice(i, fade = 0.012) {
  const v = voices.get(i);
  if (!v) return;
  const ctx = audioCtx();
  v.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
  try { v.src.stop(ctx.currentTime + fade); } catch { /* not started yet */ }
  voices.delete(i);
  padEl(i)?.classList.remove('looping', 'armed');
  if (!loopsRunning()) transport = null;
}

export function stopAll() {
  for (const i of [...voices.keys()]) stopVoice(i);
}

function startVoice(i) {
  const pad = pads[i];
  const ctx = audioCtx();
  const src = ctx.createBufferSource();
  src.buffer = bufferFor(pad);
  const gain = ctx.createGain();
  src.connect(gain).connect(out());
  let when = ctx.currentTime + 0.003;
  const el = padEl(i);
  if (pad.loop) {
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = Math.min(src.buffer.duration, pad.loopLen || src.buffer.duration);
    const beat = 60 / (pad.bpm || 150);
    if (transport && loopsRunning()) {
      const k = Math.ceil((ctx.currentTime + 0.01 - transport.start) / transport.beat);
      when = transport.start + k * transport.beat;
    } else {
      transport = { start: when, beat };
    }
    el.style.setProperty('--beat', `${transport.beat}s`);
    el.classList.add('armed');
    setTimeout(() => { if (voices.get(i)?.src === src) { el.classList.remove('armed'); el.classList.add('looping'); } },
      Math.max(0, (when - ctx.currentTime) * 1000));
  }
  src.start(when);
  voices.set(i, { src, gain, when });
  src.onended = () => {
    if (voices.get(i)?.src === src) {
      voices.delete(i);
      el.classList.remove('looping', 'armed');
      if (!loopsRunning()) transport = null;
    }
  };
}

function trigger(i) {
  const el = padEl(i);
  const pad = pads[i];
  if (editing) {
    if (pad) removePad(i);
    return;
  }
  if (!pad) { bounce(el, 'nope'); return; }
  bounce(el, 'hit');
  ripple(el);
  if (pad.loop) {
    if (voices.has(i)) { stopVoice(i); return; }
    startVoice(i);
  } else {
    stopVoice(i, 0.004); // choke the previous hit of the same pad
    startVoice(i);
  }
}

// ---------------------------------------------------------------- juice

function bounce(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // restart the CSS animation
  el.classList.add(cls);
}

function ripple(el) {
  const r = document.createElement('span');
  r.className = 'pad-ripple';
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}

// beat LEDs on the device follow the running loops
function tickLeds() {
  const leds = document.querySelectorAll('.lp-led');
  if (transport) {
    const ctx = audioCtx();
    const b = Math.floor((ctx.currentTime - transport.start) / transport.beat);
    leds.forEach((l, k) => l.classList.toggle('on', b >= 0 && ((b % 4) + 4) % 4 === k));
  } else {
    leds.forEach((l) => l.classList.remove('on'));
  }
  requestAnimationFrame(tickLeds);
}

export function toast(html) {
  const t = $('#toast');
  t.innerHTML = html;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- rendering

const padEl = (i) => document.querySelector(`#lpGrid .pad[data-i="${i}"]`);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderGrid() {
  const grid = $('#lpGrid');
  grid.innerHTML = '';
  pads.forEach((pad, i) => {
    const b = document.createElement('button');
    b.className = 'pad' + (pad ? ' on' : '');
    b.dataset.i = i;
    b.type = 'button';
    if (pad) {
      const cat = CATEGORIES[pad.category] || CATEGORIES.hit;
      b.style.setProperty('--pc', cat.color);
      b.innerHTML = `<span class="pad-name">${escapeHtml(pad.name)}</span>` +
        `<span class="pad-meta">${cat.label}${pad.loop && pad.category !== 'loop' ? ' · loop' : ''}</span>`;
      b.setAttribute('aria-label', `${pad.name} (${cat.label})`);
    } else {
      b.setAttribute('aria-label', `Empty pad ${i + 1}`);
    }
    b.insertAdjacentHTML('beforeend', `<kbd class="pad-key">${keyLabels[i]}</kbd>`);
    if (voices.has(i) && pad?.loop) { b.classList.add('looping'); b.style.setProperty('--beat', `${transport?.beat || 0.4}s`); }
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); trigger(i); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trigger(i); } });
    grid.appendChild(b);
  });
  const n = pads.filter(Boolean).length;
  $('#lpEmpty').hidden = n > 0;
  onCountChange(n);
}

function renderLegend() {
  const used = new Set(pads.filter(Boolean).map((p) => p.category));
  $('#lpLegend').innerHTML = Object.entries(CATEGORIES).map(([k, c]) =>
    `<span class="chip${used.has(k) ? ' used' : ''}" style="--pc:${c.color}"><i></i>${c.label}</span>`).join('');
}

function render() { renderGrid(); renderLegend(); }

function removePad(i) {
  const el = padEl(i);
  stopVoice(i);
  if (pads[i]) buffers.delete(pads[i].id);
  pads[i] = null;
  el.classList.add('poof');
  setTimeout(() => { render(); save(); }, 260);
}

function assign(i, sound) {
  stopVoice(i);
  if (pads[i]) buffers.delete(pads[i].id);
  pads[i] = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: sound.name, category: sound.category, loop: !!sound.loop,
    sr: sound.sr, bpm: sound.bpm || null, loopLen: sound.loopLen || null,
    channels: sound.channels,
  };
  render();
  save();
  const el = padEl(i);
  bounce(el, 'landed');
}

// ---------------------------------------------------------------- "+LP" window

let pending = null;

export function openAddModal(sound) {
  pending = { ...sound };
  const dlg = $('#lpModal');
  const cat = CATEGORIES[sound.category] || CATEGORIES.hit;
  dlg.style.setProperty('--pc', cat.color);
  dlg.style.setProperty('--mpc', cat.color);
  $('#mName').value = sound.name;
  $('#mCat').innerHTML = `<i></i>${cat.label}`;
  $('#mCat').style.setProperty('--pc', cat.color);
  $('#mLoop').checked = !!sound.loop;
  $('#mLen').textContent = `${(sound.channels[0].length / sound.sr).toFixed(2)} s`;
  const play = $('#mPlay');
  play.onclick = () => preview(sound.channels, sound.sr, play);

  const mg = $('#mGrid');
  mg.innerHTML = '';
  pads.forEach((pad, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini' + (pad ? ' taken' : '');
    if (pad) {
      b.style.setProperty('--pc', (CATEGORIES[pad.category] || CATEGORIES.hit).color);
      b.innerHTML = `<span>${escapeHtml(pad.name)}</span><em>replace</em>`;
      b.title = `Replace "${pad.name}"`;
    } else {
      b.innerHTML = `<span>${i + 1}</span>`;
    }
    b.onclick = () => {
      const name = $('#mName').value.trim() || sound.name;
      assign(i, { ...pending, name, loop: $('#mLoop').checked });
      closeModal();
      toast(`<b style="color:${cat.color}">${escapeHtml(name)}</b> → pad ${i + 1} <button class="toast-go" id="toastGo">Open Launchpad</button>`);
      $('#toastGo')?.addEventListener('click', () => document.querySelector('[data-tab="launchpad"]').click());
    };
    mg.appendChild(b);
  });
  dlg.showModal();
  dlg.classList.remove('closing');
}

function closeModal() {
  const dlg = $('#lpModal');
  stopPreview();
  dlg.classList.add('closing');
  setTimeout(() => { dlg.close(); dlg.classList.remove('closing'); }, 160);
}

// ---------------------------------------------------------------- init

export async function initLaunchpad({ onCount } = {}) {
  onCountChange = onCount || onCountChange;
  try {
    const map = await navigator.keyboard?.getLayoutMap?.();
    if (map) keyLabels = KEY_CODES.map((c, i) => (map.get(c) || keyLabels[i]).toUpperCase());
  } catch { /* not supported: keep US labels */ }
  await load();
  render();

  $('#lpStop').addEventListener('click', stopAll);
  $('#lpEdit').addEventListener('click', (e) => {
    editing = !editing;
    $('#lpGrid').classList.toggle('editing', editing);
    e.currentTarget.classList.toggle('active', editing);
    e.currentTarget.textContent = editing ? 'Done' : 'Edit';
    $('#lpHint').textContent = editing ? 'Tap a pad to remove its sound.' : 'Tap the pads (or use your keyboard).';
  });
  const clear = $('#lpClear');
  clear.addEventListener('click', () => {
    if (!clear.classList.contains('confirm')) {
      clear.classList.add('confirm');
      clear.textContent = 'Sure? Tap again';
      setTimeout(() => { clear.classList.remove('confirm'); clear.textContent = 'Clear all'; }, 2500);
      return;
    }
    stopAll();
    pads = new Array(16).fill(null);
    buffers.clear();
    clear.classList.remove('confirm');
    clear.textContent = 'Clear all';
    render();
    save();
  });

  const dlg = $('#lpModal');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeModal(); }); // backdrop
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(); }); // Esc
  $('#mClose').addEventListener('click', closeModal);

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#tab-launchpad').hidden || dlg.open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const i = KEY_CODES.indexOf(e.code);
    if (i >= 0) { e.preventDefault(); trigger(i); }
    if (e.code === 'Space') { e.preventDefault(); stopAll(); }
  });
  requestAnimationFrame(tickLeds);
}
