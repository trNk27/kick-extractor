// Launchpad tab + the "pick a pad" window.
// One-shots retrigger (and choke themselves); loops toggle and start on the next beat of whatever
// loop is already running, so they stay in time.
import { audioCtx, makeBuffer, preview, stopPreview } from './audio.js';
import { state, subscribe, padItem, padOf, addItem, assignPad, clearPad, clearPads, itemById } from './store.js';
import { scene } from './scene.js';

export const CATEGORIES = {
  kick:    { label: 'Kick',       color: '#ff5a36' },
  offbeat: { label: 'Off-beat',   color: '#ffa21f' },
  beat:    { label: 'Full beat',  color: '#ff5c9d' },
  hit:     { label: 'Single hit', color: '#f2df52' },
  loop:    { label: 'Loop',       color: '#4fe08e' },
  break:   { label: 'Break',      color: '#44a8ff' },
  fx:      { label: 'Transition', color: '#c9d2ea' },
};
export const catOf = (k) => CATEGORIES[k] || CATEGORIES.hit;

// physical key positions, so the 4x4 shape is the same on QWERTY and QWERTZ
const KEY_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
let keyLabels = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];

const $ = (s) => document.querySelector(s);
const buffers = new Map();   // item id -> AudioBuffer
const voices = new Map();    // pad index -> { src, gain, loop }
let transport = null;        // { start, beat } while loops run
let master = null;
let editing = false;

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- audio engine

function out() {
  const ctx = audioCtx();
  if (!master) {
    master = ctx.createDynamicsCompressor(); // gentle limiter so stacked pads don't clip
    master.threshold.value = -4; master.knee.value = 4; master.ratio.value = 12;
    master.attack.value = 0.002; master.release.value = 0.12;
    master.connect(ctx.destination);
  }
  return master;
}

function bufferFor(item) {
  let b = buffers.get(item.id);
  if (!b) { b = makeBuffer(item.channels, item.sr); buffers.set(item.id, b); }
  return b;
}

const loopsRunning = () => [...voices.values()].some((v) => v.loop);

function syncScene() {
  scene.setTransport(transport ? { start: transport.start, beat: transport.beat, ctx: audioCtx() } : null);
}

function stopVoice(i, fade = 0.012) {
  const v = voices.get(i);
  if (!v) return;
  const ctx = audioCtx();
  v.gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
  try { v.src.stop(ctx.currentTime + fade); } catch { /* not started yet */ }
  voices.delete(i);
  padEl(i)?.classList.remove('looping', 'armed');
  if (!loopsRunning()) { transport = null; syncScene(); }
}

export function stopAll() {
  for (const i of [...voices.keys()]) stopVoice(i);
}

function startVoice(i, item) {
  const ctx = audioCtx();
  const src = ctx.createBufferSource();
  src.buffer = bufferFor(item);
  const gain = ctx.createGain();
  src.connect(gain).connect(out());
  let when = ctx.currentTime + 0.003;
  const el = padEl(i);
  if (item.loop) {
    src.loop = true;
    src.loopEnd = Math.min(src.buffer.duration, item.loopLen || src.buffer.duration);
    if (transport && loopsRunning()) {
      const k = Math.ceil((ctx.currentTime + 0.01 - transport.start) / transport.beat);
      when = transport.start + k * transport.beat;
    } else {
      transport = { start: when, beat: 60 / (item.bpm || 150) };
      syncScene();
    }
    el.style.setProperty('--beat', `${transport.beat}s`);
    el.classList.add('armed');
    setTimeout(() => {
      if (voices.get(i)?.src === src) { el.classList.remove('armed'); el.classList.add('looping'); }
    }, Math.max(0, (when - ctx.currentTime) * 1000));
  }
  src.start(when);
  voices.set(i, { src, gain, loop: item.loop });
  src.onended = () => {
    if (voices.get(i)?.src !== src) return;
    voices.delete(i);
    el.classList.remove('looping', 'armed');
    if (!loopsRunning()) { transport = null; syncScene(); }
  };
}

function trigger(i) {
  const el = padEl(i);
  const item = padItem(i);
  if (editing) {
    if (item) { stopVoice(i); el.classList.add('leaving'); setTimeout(() => clearPad(i), 160); }
    return;
  }
  if (!item) { restart(el, 'empty-tap'); return; }
  restart(el, 'hit');
  scene.hit(catOf(item.category).color, item.category === 'kick' || item.category === 'beat' ? 1 : 0.5);
  if (item.loop) {
    if (voices.has(i)) { stopVoice(i); return; }
    startVoice(i, item);
  } else {
    stopVoice(i, 0.004); // choke the previous hit of the same pad
    startVoice(i, item);
  }
}

function restart(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // restart the CSS animation
  el.classList.add(cls);
}

// beat lights on the device follow the running loops
function tickLeds() {
  const leds = document.querySelectorAll('.lp-led');
  let b = -1;
  if (transport) b = Math.floor((audioCtx().currentTime - transport.start) / transport.beat);
  leds.forEach((l, k) => l.classList.toggle('on', b >= 0 && b % 4 === k));
  requestAnimationFrame(tickLeds);
}

export function toast(html, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${html}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); t.classList.remove('show'); };
    t.appendChild(b);
  }
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

const goTo = (tab) => window.dispatchEvent(new CustomEvent('kx:tab', { detail: tab }));

// ---------------------------------------------------------------- rendering

const padEl = (i) => document.querySelector(`#lpGrid .pad[data-i="${i}"]`);

function render() {
  const grid = $('#lpGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const item = padItem(i);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad' + (item ? ' on' : '');
    b.dataset.i = i;
    if (item) {
      const cat = catOf(item.category);
      b.style.setProperty('--pc', cat.color);
      b.innerHTML = `<span class="pad-name">${escapeHtml(item.name)}</span>` +
        `<span class="pad-meta">${item.loop && item.category !== 'loop' ? `${cat.label}, looped` : cat.label}</span>`;
      b.setAttribute('aria-label', `${item.name}, ${cat.label}`);
    } else {
      b.setAttribute('aria-label', `Pad ${i + 1}, empty`);
    }
    b.insertAdjacentHTML('beforeend', `<kbd class="pad-key">${keyLabels[i]}</kbd>`);
    if (voices.get(i)?.loop && item) { b.classList.add('looping'); b.style.setProperty('--beat', `${transport?.beat || 0.4}s`); }
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); trigger(i); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trigger(i); } });
    grid.appendChild(b);
  }
  const n = state.pads.filter(Boolean).length;
  $('#lpEmpty').hidden = n > 0;
  const used = new Set(state.pads.filter(Boolean).map((id) => itemById(id)?.category));
  $('#lpLegend').innerHTML = Object.entries(CATEGORIES).map(([k, c]) =>
    `<span class="key-item${used.has(k) ? ' used' : ''}" style="--pc:${c.color}"><i></i>${c.label}</span>`).join('');
}

// ---------------------------------------------------------------- pick-a-pad window
// openPadPicker({ sound })  -> a new sound from the Extract tab (saved to the library on pick)
// openPadPicker({ item })   -> an existing library item (put on a pad / moved to another pad)

let picking = null;

export function openPadPicker({ sound = null, item = null }) {
  picking = { sound, item };
  const src = item || sound;
  const cat = catOf(src.category);
  const dlg = $('#padPicker');
  dlg.style.setProperty('--pc', cat.color);
  $('#ppName').value = src.name;
  $('#ppName').readOnly = !!item;
  $('#ppSwatch').style.background = cat.color;
  $('#ppCat').textContent = cat.label;
  $('#ppLen').textContent = `${(src.channels[0].length / src.sr).toFixed(2)} s`;
  $('#ppLoop').checked = !!src.loop;
  $('#ppLoopRow').hidden = !!item;
  $('#ppLibOnly').hidden = !!item;
  $('#ppTitle').textContent = item ? 'Put on a pad' : 'Add to the Launchpad';
  const play = $('#ppPlay');
  play.onclick = () => preview(src.channels, src.sr, play);

  const current = item ? padOf(item.id) : -1;
  const grid = $('#ppGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const it = padItem(i);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot' + (it ? ' taken' : '') + (i === current ? ' current' : '');
    if (it) {
      b.style.setProperty('--sc', catOf(it.category).color);
      b.innerHTML = `<span class="slot-n">${i + 1}</span><span class="slot-name">${escapeHtml(it.name)}</span>`;
      b.title = i === current ? 'This sample is on this pad' : `Replace ${it.name}`;
    } else {
      b.innerHTML = `<span class="slot-n">${i + 1}</span>`;
      b.title = `Pad ${i + 1}`;
    }
    b.onclick = () => pick(i);
    grid.appendChild(b);
  }
  dlg.showModal();
}

function finishItem() {
  const { sound, item } = picking;
  if (item) return item;
  const name = $('#ppName').value.trim() || sound.name;
  return addItem({ ...sound, name, loop: $('#ppLoop').checked });
}

function pick(i) {
  const it = finishItem();
  assignPad(i, it.id);
  closePicker();
  restart(padEl(i), 'landed');
  toast(`${escapeHtml(it.name)} is on pad ${i + 1}`, { label: 'Open Launchpad', run: () => goTo('launchpad') });
}

function closePicker() {
  stopPreview();
  $('#padPicker').close();
}

// ---------------------------------------------------------------- init

export async function initLaunchpad() {
  try {
    const map = await navigator.keyboard?.getLayoutMap?.();
    if (map) keyLabels = KEY_CODES.map((c, i) => (map.get(c) || keyLabels[i]).toUpperCase());
  } catch { /* keep US labels */ }
  subscribe((what) => {
    if (what === 'items') for (const id of buffers.keys()) if (!itemById(id)) buffers.delete(id);
    for (const i of [...voices.keys()]) if (!state.pads[i]) stopVoice(i); // pad emptied: stop it
    render();
  });
  render();

  $('#lpStop').addEventListener('click', stopAll);
  $('#lpEdit').addEventListener('click', (e) => {
    editing = !editing;
    $('#lpGrid').classList.toggle('editing', editing);
    e.currentTarget.setAttribute('aria-pressed', editing);
    e.currentTarget.textContent = editing ? 'Done' : 'Edit pads';
    $('#lpHint').textContent = editing
      ? 'Tap a pad to take its sample off. It stays in your library.'
      : 'Tap the pads, or play them with your keyboard.';
  });
  const clear = $('#lpClear');
  clear.addEventListener('click', () => {
    if (!clear.classList.contains('confirm')) {
      clear.classList.add('confirm');
      clear.textContent = 'Tap again to clear';
      setTimeout(() => { clear.classList.remove('confirm'); clear.textContent = 'Clear pads'; }, 2500);
      return;
    }
    stopAll();
    clear.classList.remove('confirm');
    clear.textContent = 'Clear pads';
    clearPads();
  });

  const dlg = $('#padPicker');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closePicker(); }); // backdrop
  dlg.addEventListener('close', stopPreview);
  $('#ppClose').addEventListener('click', closePicker);
  $('#ppLibOnly').addEventListener('click', () => {
    const it = finishItem();
    closePicker();
    toast(`${escapeHtml(it.name)} is in your library`, { label: 'Open Library', run: () => goTo('library') });
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#tab-launchpad').hidden || dlg.open) return;
    const tag = document.activeElement?.tagName;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    const i = KEY_CODES.indexOf(e.code);
    if (i >= 0) { e.preventDefault(); trigger(i); }
    else if (e.code === 'Space' && tag !== 'BUTTON') { e.preventDefault(); stopAll(); }
  });
  requestAnimationFrame(tickLeds);
}
