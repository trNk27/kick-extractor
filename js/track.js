// Track Builder tab: multi-lane beat/bar sequencer for kicks and samples.
// Supports Library samples, current Extract results, and direct WAV/MP3/FLAC imports,
// per-clip semitone pitch shifting, lookahead sample-accurate scheduling, and offline WAV/MP3/LP bounce.

import { audioCtx, asChannels, preview, stopPreview, download } from './audio.js';
import { mixToMono } from './dsp.js';
import {
  state, subscribe, itemById, addItem,
  setTrackMeta, addTrackLane, removeTrackLane, moveTrackLane,
  updateTrackLane, setLaneClips, clearTrack, scheduleSaveTrack,
} from './store.js';
import { CATEGORIES, catOf, openPadPicker, toast, escapeHtml } from './launchpad.js';
import { scene } from './scene.js';

const $ = (s) => document.querySelector(s);
const ZOOM_STEPS = [18, 26, 36, 52, 74];
const CLIP_MIN_PX = 14;
const LANE_H = 68;
const RULER_H = 28;

const buffers = new Map(); // item id -> AudioBuffer
const peaks = new Map();   // item id -> Float32Array(64)

// Playback state
let master = null;
let isPlaying = false;
let playheadBeat = 0;
let schedTimer = 0;
let rafId = 0;
let playOriginCtxTime = 0;
let playOriginBeat = 0;
let nextSchedBeat = 0;
let playRunId = 0;
const laneVoices = new Map(); // laneId -> { src, gain, baseGain }[]
const hitTimers = new Set();

// UI state
let zoomIdx = 2; // 36 px/beat
let snapBeats = 1;
let tool = 'draw'; // 'draw' | 'pitch'
let selectedClip = null; // { laneId, clipId }
let palSource = 'library'; // 'library' | 'extracted'
let palFilter = 'all';
let extractedSounds = [];
let extractedBpm = null;
let dragSample = null; // { kind: 'library'|'extracted', idOrKey }
let redrawQueued = false;

const pxPerBeat = () => {
  const raw = ZOOM_STEPS[zoomIdx];
  const totalBeats = state.track.bars * 4;
  return Math.min(raw, Math.floor(15000 / Math.max(1, totalBeats)));
};

const newClipId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ------------------------------------------------------------------ audio helpers

function outNode() {
  const ctx = audioCtx();
  if (!master) {
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -3;
    master.knee.value = 4;
    master.ratio.value = 12;
    master.attack.value = 0.002;
    master.release.value = 0.1;
    master.connect(ctx.destination);
  }
  return master;
}

function bufferFor(item) {
  let b = buffers.get(item.id);
  if (!b) {
    const ctx = audioCtx();
    const ch = asChannels(item.channels);
    b = ctx.createBuffer(ch.length, ch[0].length, item.sr);
    ch.forEach((c, i) => b.copyToChannel(c, i));
    buffers.set(item.id, b);
  }
  return b;
}

function peaksFor(item) {
  let p = peaks.get(item.id);
  if (p) return p;
  const ch = asChannels(item.channels)[0];
  const bins = 64;
  p = new Float32Array(bins);
  let max = 1e-6;
  const n = ch.length;
  for (let i = 0; i < bins; i++) {
    const a = Math.floor(i / bins * n);
    const b = Math.max(a + 1, Math.floor((i + 1) / bins * n));
    let m = 0;
    for (let j = a; j < b; j++) {
      const v = Math.abs(ch[j]);
      if (v > m) m = v;
    }
    p[i] = m;
    if (m > max) max = m;
  }
  for (let i = 0; i < bins; i++) p[i] /= max;
  peaks.set(item.id, p);
  return p;
}

function isLaneAudible(lane) {
  const anySolo = state.track.lanes.some((l) => l.solo);
  if (anySolo) return !!lane.solo;
  return !lane.mute;
}

function effectiveLaneGain(lane) {
  return isLaneAudible(lane) ? (lane.gain ?? 1) : 0;
}

function updateLiveGains() {
  const ctx = audioCtx();
  for (const lane of state.track.lanes) {
    const g = effectiveLaneGain(lane);
    const list = laneVoices.get(lane.id);
    if (!list) continue;
    for (const v of list) {
      v.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.015);
    }
  }
}

function auditionSample(item, gain = 1, pitch = 0) {
  if (!item) return;
  const ctx = audioCtx();
  const src = ctx.createBufferSource();
  src.buffer = bufferFor(item);
  src.playbackRate.value = Math.pow(2, pitch / 12);
  const g = ctx.createGain();
  g.gain.value = Math.min(1.5, Math.max(0.05, gain));
  src.connect(g).connect(outNode());
  src.start();
  // Short audition cap for very long loops so placing a loop doesn't play for 10s
  if (src.buffer.duration > 1.8) {
    const tEnd = ctx.currentTime + 1.5;
    g.gain.setValueAtTime(g.gain.value, tEnd - 0.04);
    g.gain.linearRampToValueAtTime(0, tEnd);
    src.stop(tEnd + 0.01);
  }
}

// ------------------------------------------------------------------ transport & scheduler

function syncSceneTransport() {
  if (!isPlaying) {
    scene.setTransport(null);
    return;
  }
  const secPerBeat = 60 / state.track.bpm;
  scene.setTransport({
    start: playOriginCtxTime - playOriginBeat * secPerBeat,
    beat: secPerBeat,
    ctx: audioCtx(),
  });
}

function clearScheduledVoices() {
  const ctx = audioCtx();
  const now = ctx.currentTime;
  for (const list of laneVoices.values()) {
    for (const v of list) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.004);
        v.src.stop(now + 0.02);
      } catch { /* ignore */ }
    }
  }
  laneVoices.clear();
  for (const t of hitTimers) clearTimeout(t);
  hitTimers.clear();
}

function scheduleClip(lane, item, clip, when, maxDurSec) {
  const ctx = audioCtx();
  const src = ctx.createBufferSource();
  src.buffer = bufferFor(item);
  const semi = (lane.pitch || 0) + (clip.pitch || 0);
  const rate = Math.pow(2, semi / 12);
  src.playbackRate.value = rate;

  const g = ctx.createGain();
  const level = effectiveLaneGain(lane);
  g.gain.setValueAtTime(level, when);

  // Choke any active voice on the same lane right as this new hit starts
  const active = laneVoices.get(lane.id) || [];
  for (const prev of active) {
    if (prev.when < when) {
      const fadeEnd = when + 0.004;
      prev.gain.gain.setValueAtTime(effectiveLaneGain(lane), when);
      prev.gain.gain.linearRampToValueAtTime(0, fadeEnd);
      try { prev.src.stop(fadeEnd + 0.002); } catch { /* ignore */ }
    }
  }

  const natDur = src.buffer.duration / rate;
  const dur = Math.min(natDur, maxDurSec);
  if (dur < natDur) {
    const fadeStart = Math.max(when, when + dur - 0.006);
    g.gain.setValueAtTime(level, fadeStart);
    g.gain.linearRampToValueAtTime(0, when + dur);
  }

  src.connect(g).connect(outNode());
  src.start(when);
  src.stop(when + dur + 0.005);

  const entry = { src, gain: g, when };
  active.push(entry);
  laneVoices.set(lane.id, active);

  src.onended = () => {
    const arr = laneVoices.get(lane.id);
    if (!arr) return;
    const idx = arr.indexOf(entry);
    if (idx >= 0) arr.splice(idx, 1);
  };

  if (level > 0.02) {
    const runId = playRunId;
    const ms = Math.max(0, (when - ctx.currentTime) * 1000);
    const tid = setTimeout(() => {
      hitTimers.delete(tid);
      if (!isPlaying || playRunId !== runId) return;
      if (effectiveLaneGain(lane) <= 0.02) return;
      const strength = item.category === 'kick' || item.category === 'beat' ? 0.95 : 0.4;
      scene.hit(catOf(item.category).color, strength);
    }, ms);
    hitTimers.add(tid);
  }
}

function schedulerTick() {
  if (!isPlaying) return;
  const ctx = audioCtx();
  const secPerBeat = 60 / state.track.bpm;
  const totalBeats = state.track.bars * 4;
  const lookAheadBeats = 0.16 / secPerBeat;
  const currentBeat = playOriginBeat + (ctx.currentTime - playOriginCtxTime) / secPerBeat;
  const targetBeat = currentBeat + lookAheadBeats;

  if (nextSchedBeat < currentBeat - 0.25) nextSchedBeat = currentBeat;

  while (nextSchedBeat <= targetBeat) {
    if (nextSchedBeat >= totalBeats) {
      if (state.track.loop) {
        const overflow = nextSchedBeat - totalBeats;
        playOriginBeat = 0;
        playOriginCtxTime += totalBeats * secPerBeat;
        nextSchedBeat = overflow;
        syncSceneTransport();
      } else {
        break;
      }
    }

    const windowStart = nextSchedBeat;
    const windowEnd = Math.min(totalBeats, nextSchedBeat + Math.max(0.05, lookAheadBeats * 0.6));

    for (const lane of state.track.lanes) {
      const item = itemById(lane.itemId);
      if (!item) continue;
      for (let i = 0; i < lane.clips.length; i++) {
        const c = lane.clips[i];
        if (c.beat >= windowStart - 1e-6 && c.beat < windowEnd - 1e-6) {
          const when = Math.max(ctx.currentTime + 0.002, playOriginCtxTime + (c.beat - playOriginBeat) * secPerBeat);
          const nextBeat = i + 1 < lane.clips.length ? lane.clips[i + 1].beat : totalBeats;
          const maxDur = Math.max(0.02, (Math.min(totalBeats, nextBeat) - c.beat) * secPerBeat + 0.004);
          scheduleClip(lane, item, c, when, maxDur);
        }
      }
    }
    nextSchedBeat = windowEnd;
    if (!state.track.loop && nextSchedBeat >= totalBeats) break;
  }

  if (!state.track.loop && currentBeat >= totalBeats) {
    stopPlayback(true);
  }
}

function updatePlayheadUI() {
  const totalBeats = state.track.bars * 4;
  let beat = playheadBeat;
  if (isPlaying) {
    const secPerBeat = 60 / state.track.bpm;
    beat = playOriginBeat + (audioCtx().currentTime - playOriginCtxTime) / secPerBeat;
    if (state.track.loop) {
      beat = ((beat % totalBeats) + totalBeats) % totalBeats;
    } else if (beat >= totalBeats) {
      beat = totalBeats;
    }
    playheadBeat = beat;
  }

  const ph = $('#trkPlayhead');
  if (ph) {
    const x = beat * pxPerBeat();
    ph.style.transform = `translateX(${x}px)`;
  }

  const barNum = Math.min(state.track.bars, Math.floor(beat / 4) + 1);
  const beatInBar = Math.floor(beat % 4) + 1;
  const secs = beat * (60 / state.track.bpm);
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  const clk = $('#trkClock');
  if (clk) {
    clk.innerHTML = `BAR ${String(barNum).padStart(2, '0')}.${beatInBar} <small>${m}:${s.toFixed(1).padStart(4, '0')}</small>`;
  }

  if (isPlaying) rafId = requestAnimationFrame(updatePlayheadUI);
}

function startPlayback(fromBeat = playheadBeat) {
  if (!state.track.lanes.length) return;
  stopPreview();
  window.dispatchEvent(new CustomEvent('kx:play', { detail: 'track' }));
  const totalBeats = state.track.bars * 4;
  if (fromBeat >= totalBeats) fromBeat = 0;

  clearScheduledVoices();
  playRunId++;
  isPlaying = true;
  const ctx = audioCtx();
  playOriginBeat = fromBeat;
  playOriginCtxTime = ctx.currentTime + 0.03;
  nextSchedBeat = fromBeat;
  playheadBeat = fromBeat;

  syncSceneTransport();
  schedulerTick();
  clearInterval(schedTimer);
  schedTimer = setInterval(schedulerTick, 25);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(updatePlayheadUI);
  updateTransportButtons();
}

function pausePlayback() {
  if (!isPlaying) return;
  const secPerBeat = 60 / state.track.bpm;
  const totalBeats = state.track.bars * 4;
  const b = playOriginBeat + (audioCtx().currentTime - playOriginCtxTime) / secPerBeat;
  playheadBeat = state.track.loop ? ((b % totalBeats) + totalBeats) % totalBeats : Math.min(totalBeats, b);
  isPlaying = false;
  playRunId++;
  clearInterval(schedTimer);
  cancelAnimationFrame(rafId);
  clearScheduledVoices();
  syncSceneTransport();
  updatePlayheadUI();
  updateTransportButtons();
}

export function stopPlayback(resetToZero = true) {
  isPlaying = false;
  playRunId++;
  clearInterval(schedTimer);
  cancelAnimationFrame(rafId);
  clearScheduledVoices();
  syncSceneTransport();
  if (resetToZero) playheadBeat = 0;
  updatePlayheadUI();
  updateTransportButtons();
}

function seekToBeat(beat) {
  const totalBeats = state.track.bars * 4;
  const clamped = Math.max(0, Math.min(totalBeats - 0.01, beat));
  playheadBeat = clamped;
  if (isPlaying) startPlayback(clamped);
  else updatePlayheadUI();
}

function updateTransportButtons() {
  const playBtn = $('#trkPlay');
  if (!playBtn) return;
  playBtn.textContent = isPlaying ? '❚❚ Pause' : '▶ Play';
  playBtn.setAttribute('aria-pressed', isPlaying);
  playBtn.classList.toggle('playing', isPlaying);
}

// ------------------------------------------------------------------ offline bounce / export

async function renderTrackOffline() {
  const { bpm, bars, lanes } = state.track;
  if (!lanes.length) throw new Error('Add at least one kick or sample first.');

  const used = lanes.map((l) => itemById(l.itemId)).filter(Boolean);
  const sr = Math.max(44100, ...used.map((it) => it.sr));
  const secPerBeat = 60 / bpm;
  const totalBeats = bars * 4;
  const totalSec = totalBeats * secPerBeat;
  const totalFrames = Math.max(1, Math.round(totalSec * sr));

  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new Offline(2, totalFrames, sr);

  const limiter = off.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 4;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  limiter.connect(off.destination);

  const offBufCache = new Map();
  let clipCount = 0;

  for (const lane of lanes) {
    const level = effectiveLaneGain(lane);
    if (level <= 0) continue;
    const item = itemById(lane.itemId);
    if (!item) continue;

    let buf = offBufCache.get(item.id);
    if (!buf) {
      const ch = asChannels(item.channels);
      buf = off.createBuffer(ch.length, ch[0].length, item.sr);
      ch.forEach((c, i) => buf.copyToChannel(c, i));
      offBufCache.set(item.id, buf);
    }

    const sorted = [...lane.clips].sort((a, b) => a.beat - b.beat);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const when = c.beat * secPerBeat;
      if (when >= totalSec || when < 0) continue;
      clipCount++;

      const src = off.createBufferSource();
      src.buffer = buf;
      const semi = (lane.pitch || 0) + (c.pitch || 0);
      const rate = Math.pow(2, semi / 12);
      src.playbackRate.value = rate;

      const g = off.createGain();
      g.gain.setValueAtTime(level, when);

      const natDur = buf.duration / rate;
      const nextWhen = i + 1 < sorted.length ? sorted[i + 1].beat * secPerBeat : Infinity;
      const maxEnd = Math.min(totalSec, nextWhen + 0.004);
      const stopAt = Math.min(when + natDur, maxEnd);

      if (stopAt < when + natDur) {
        const fadeStart = Math.max(when, stopAt - 0.004);
        g.gain.setValueAtTime(level, fadeStart);
        g.gain.linearRampToValueAtTime(0, stopAt);
      }

      src.connect(g).connect(limiter);
      src.start(when);
      src.stop(Math.min(totalSec + 0.02, stopAt + 0.002));
    }
  }

  if (clipCount === 0) throw new Error('Place some kicks or samples on the grid first.');

  const rendered = await off.startRendering();
  return {
    sr,
    totalSec,
    channels: [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()],
  };
}

// ------------------------------------------------------------------ canvas drawing

function sizeHiDpi(cv, cssW, cssH) {
  const safeDpr = Math.min(window.devicePixelRatio || 1, Math.max(1, Math.floor(15500 / Math.max(1, cssW))));
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  cv.width = Math.max(1, Math.round(cssW * safeDpr));
  cv.height = Math.max(1, Math.round(cssH * safeDpr));
  const g = cv.getContext('2d');
  g.setTransform(safeDpr, 0, 0, safeDpr, 0, 0);
  return g;
}

function drawRuler() {
  const cv = $('#trkRuler');
  if (!cv || $('#tab-track').hidden) return;
  const ppb = pxPerBeat();
  const totalBeats = state.track.bars * 4;
  const w = totalBeats * ppb;
  const g = sizeHiDpi(cv, w, RULER_H);
  g.clearRect(0, 0, w, RULER_H);

  // Bar & beat ticks
  g.font = '600 11px "Chakra Petch", sans-serif';
  g.textBaseline = 'top';
  for (let b = 0; b <= totalBeats; b++) {
    const x = Math.round(b * ppb) + 0.5;
    const isBar = b % 4 === 0;
    g.strokeStyle = isBar ? '#4e60a3' : '#263264';
    g.beginPath();
    g.moveTo(x, isBar ? 0 : RULER_H - 8);
    g.lineTo(x, RULER_H);
    g.stroke();

    if (isBar && b < totalBeats) {
      const bar = b / 4 + 1;
      g.fillStyle = bar % 4 === 1 ? '#dde5ff' : '#8f9bc7';
      g.fillText(String(bar), x + 5, 5);
    }
  }
  g.strokeStyle = '#222e5a';
  g.beginPath();
  g.moveTo(0, RULER_H - 0.5);
  g.lineTo(w, RULER_H - 0.5);
  g.stroke();
}

function clipWidthPx(lane, item, clip, ppb) {
  const secPerBeat = 60 / state.track.bpm;
  const rate = Math.pow(2, ((lane.pitch || 0) + (clip.pitch || 0)) / 12);
  const durBeats = (item.channels[0].length / item.sr / rate) / secPerBeat;
  return Math.max(CLIP_MIN_PX, durBeats * ppb);
}

function drawLaneCanvas(cv, lane) {
  const item = itemById(lane.itemId);
  const ppb = pxPerBeat();
  const totalBeats = state.track.bars * 4;
  const w = totalBeats * ppb;
  const g = sizeHiDpi(cv, w, LANE_H);
  g.clearRect(0, 0, w, LANE_H);

  const audible = isLaneAudible(lane);

  // Subtle alternating bar shading
  for (let bar = 0; bar < state.track.bars; bar++) {
    if (bar % 2 === 1) {
      g.fillStyle = '#ffffff05';
      g.fillRect(bar * 4 * ppb, 0, 4 * ppb, LANE_H);
    }
  }

  // Snap subdivisions, beats, bars
  const step = snapBeats;
  for (let b = 0; b < totalBeats; b += step) {
    const x = Math.round(b * ppb) + 0.5;
    const isBar = Math.abs(b % 4) < 1e-6;
    const isBeat = Math.abs(b % 1) < 1e-6;
    g.strokeStyle = isBar ? '#2d3b75' : isBeat ? '#1c264f' : '#121938';
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, LANE_H);
    g.stroke();
  }

  if (!item) return;

  const color = catOf(item.category).color;
  const pk = peaksFor(item);
  const sorted = [...lane.clips].sort((a, b) => a.beat - b.beat);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const x = c.beat * ppb;
    const rawW = clipWidthPx(lane, item, c, ppb);
    const nextX = i + 1 < sorted.length ? sorted[i + 1].beat * ppb : w;
    const cw = Math.max(CLIP_MIN_PX, Math.min(rawW, nextX - x - 1, w - x));
    if (cw <= 1) continue;

    const top = 6;
    const ch = LANE_H - 12;
    const isSel = selectedClip && selectedClip.laneId === lane.id && selectedClip.clipId === c.id;

    // Clip body
    g.save();
    g.globalAlpha = audible ? 1 : 0.35;
    g.fillStyle = color + '30';
    g.fillRect(x + 0.5, top, cw - 1, ch);

    // Top accent bar
    g.fillStyle = color;
    g.fillRect(x + 0.5, top, cw - 1, 3);

    // Mini waveform
    const waveLeft = x + 2;
    const waveW = Math.max(1, cw - 4);
    const mid = top + 3 + (ch - 3) / 2;
    const amp = (ch - 10) / 2;
    g.fillStyle = color + 'cc';
    const cols = Math.min(Math.floor(waveW), 64);
    for (let px = 0; px < cols; px++) {
      const idx = Math.min(pk.length - 1, Math.floor(px / cols * pk.length));
      const h = Math.max(2, pk[idx] * amp * 2);
      const bx = waveLeft + (px / cols) * waveW;
      const bw = Math.max(1, waveW / cols);
      g.fillRect(bx, mid - h / 2, bw, h);
    }

    // Border / selection ring
    g.strokeStyle = isSel ? '#ffffff' : color;
    g.lineWidth = isSel ? 2 : 1;
    g.strokeRect(x + 0.5, top + 0.5, cw - 1, ch - 1);

    // Pitch badge if pitched
    const totalSemi = (lane.pitch || 0) + (c.pitch || 0);
    if (c.pitch) {
      const txt = (c.pitch > 0 ? '+' : '') + c.pitch;
      g.font = '700 10px "Chakra Petch", sans-serif';
      const tw = g.measureText(txt).width + 6;
      g.fillStyle = '#070a16e6';
      g.fillRect(x + 2, top + 4, tw, 13);
      g.fillStyle = '#ffb43a';
      g.fillText(txt, x + 5, top + 5);
    } else if (totalSemi && cw > 26) {
      const txt = (totalSemi > 0 ? '+' : '') + totalSemi;
      g.font = '600 10px "Chakra Petch", sans-serif';
      g.fillStyle = '#dde5ffb0';
      g.fillText(txt, x + 4, top + 6);
    }
    g.restore();
  }
}

function redrawAllCanvases() {
  if ($('#tab-track').hidden) return;
  drawRuler();
  for (const lane of state.track.lanes) {
    const cv = document.querySelector(`.trk-lane-cv[data-lane="${lane.id}"]`);
    if (cv) drawLaneCanvas(cv, lane);
  }
  updatePlayheadUI();
}

export function redrawTrack() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    redrawAllCanvases();
  });
}

// ------------------------------------------------------------------ lane & clip interaction

function snapBeat(rawBeat) {
  const s = snapBeats;
  const totalBeats = state.track.bars * 4;
  const b = Math.floor(rawBeat / s) * s;
  return Math.max(0, Math.min(totalBeats - s, Number(b.toFixed(4))));
}

function findClipAt(lane, xPx) {
  const item = itemById(lane.itemId);
  if (!item) return null;
  const ppb = pxPerBeat();
  const sorted = [...lane.clips].sort((a, b) => a.beat - b.beat);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i];
    const x = c.beat * ppb;
    const rawW = clipWidthPx(lane, item, c, ppb);
    const nextX = i + 1 < sorted.length ? sorted[i + 1].beat * ppb : state.track.bars * 4 * ppb;
    const cw = Math.max(CLIP_MIN_PX, Math.min(rawW, nextX - x));
    if (xPx >= x && xPx <= x + cw) return c;
  }
  return null;
}

function attachLanePointer(cv, lane) {
  let mode = null; // 'paint' | 'erase' | 'pitch'
  let lastBeat = null;
  let pitchClip = null;
  let pitchStartY = 0;
  let pitchStartVal = 0;

  const beatFromEvent = (e) => {
    const r = cv.getBoundingClientRect();
    const x = Math.max(0, e.clientX - r.left);
    return { x, beat: snapBeat(x / pxPerBeat()) };
  };

  cv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const hit = findClipAt(lane, e.clientX - r.left);
    if (hit) {
      setLaneClips(lane.id, lane.clips.filter((c) => c.id !== hit.id), false);
      if (selectedClip?.clipId === hit.id) { selectedClip = null; updatePitchBar(); }
      drawLaneCanvas(cv, lane);
    }
  });

  cv.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const { x, beat } = beatFromEvent(e);
    const item = itemById(lane.itemId);
    const hit = findClipAt(lane, x);

    if (tool === 'pitch') {
      if (!hit) {
        selectedClip = null;
        updatePitchBar();
        redrawAllCanvases();
        return;
      }
      selectedClip = { laneId: lane.id, clipId: hit.id };
      mode = 'pitch';
      pitchClip = hit;
      pitchStartY = e.clientY;
      pitchStartVal = hit.pitch || 0;
      updatePitchBar();
      drawLaneCanvas(cv, lane);
      if (!isPlaying) auditionSample(item, lane.gain, (lane.pitch || 0) + (hit.pitch || 0));
      return;
    }

    // Draw mode
    if (hit) {
      mode = 'erase';
      lastBeat = hit.beat;
      setLaneClips(lane.id, lane.clips.filter((c) => c.id !== hit.id), false);
      drawLaneCanvas(cv, lane);
    } else {
      mode = 'paint';
      lastBeat = beat;
      if (!lane.clips.some((c) => Math.abs(c.beat - beat) < 1e-4)) {
        const created = { id: newClipId(), beat, pitch: 0 };
        setLaneClips(lane.id, [...lane.clips, created], false);
        drawLaneCanvas(cv, lane);
        if (!isPlaying) auditionSample(item, lane.gain, lane.pitch || 0);
      }
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (mode === 'pitch' && pitchClip) {
      const dy = pitchStartY - e.clientY;
      const next = Math.max(-12, Math.min(12, pitchStartVal + Math.round(dy / 10)));
      if (next !== (pitchClip.pitch || 0)) {
        pitchClip.pitch = next;
        scheduleSaveTrack();
        updatePitchBar();
        drawLaneCanvas(cv, lane);
        if (!isPlaying) auditionSample(itemById(lane.itemId), lane.gain, (lane.pitch || 0) + next);
      }
      return;
    }

    const { x, beat } = beatFromEvent(e);
    if (mode === 'paint') {
      if (beat === lastBeat) return;
      lastBeat = beat;
      if (!lane.clips.some((c) => Math.abs(c.beat - beat) < 1e-4)) {
        setLaneClips(lane.id, [...lane.clips, { id: newClipId(), beat, pitch: 0 }], false);
        drawLaneCanvas(cv, lane);
      }
    } else if (mode === 'erase') {
      const hit = findClipAt(lane, x);
      if (hit) {
        setLaneClips(lane.id, lane.clips.filter((c) => c.id !== hit.id), false);
        drawLaneCanvas(cv, lane);
      }
    }
  });

  const end = () => { mode = null; lastBeat = null; pitchClip = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  // Drag-and-drop a sample from the palette onto an existing lane
  cv.addEventListener('dragover', (e) => {
    if (!dragSample) return;
    e.preventDefault();
    cv.classList.add('drop-hover');
  });
  cv.addEventListener('dragleave', () => cv.classList.remove('drop-hover'));
  cv.addEventListener('drop', (e) => {
    cv.classList.remove('drop-hover');
    if (!dragSample) return;
    e.preventDefault();
    e.stopPropagation();
    const item = resolveDraggedItem();
    if (!item) return;
    const { beat } = beatFromEvent(e);
    if (item.id === lane.itemId) {
      if (!lane.clips.some((c) => Math.abs(c.beat - beat) < 1e-4)) {
        setLaneClips(lane.id, [...lane.clips, { id: newClipId(), beat, pitch: 0 }]);
      }
    } else {
      addSampleAsLane(item, beat);
    }
  });
}

function updatePitchBar() {
  const bar = $('#trkPitchBar');
  if (!bar) return;
  bar.hidden = tool !== 'pitch';
  if (tool !== 'pitch') return;

  const lane = selectedClip ? state.track.lanes.find((l) => l.id === selectedClip.laneId) : null;
  const clip = lane ? lane.clips.find((c) => c.id === selectedClip.clipId) : null;
  const item = lane ? itemById(lane.itemId) : null;

  if (!lane || !clip || !item) {
    $('#trkPitchInfo').textContent = 'Click any hit or clip to select it, or drag up/down to shift pitch.';
    $('#trkPitchVal').textContent = '—';
    bar.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    return;
  }

  const barNum = Math.floor(clip.beat / 4) + 1;
  const beatNum = (clip.beat % 4) + 1;
  const semi = clip.pitch || 0;
  $('#trkPitchInfo').textContent = `${item.name} · Bar ${barNum}, Beat ${Number(beatNum.toFixed(2))}`;
  $('#trkPitchVal').textContent = `${semi > 0 ? '+' : ''}${semi} st`;
  bar.querySelectorAll('button').forEach((b) => { b.disabled = false; });
}

function shiftSelectedPitch(delta, absolute = false) {
  if (!selectedClip) return;
  const lane = state.track.lanes.find((l) => l.id === selectedClip.laneId);
  const clip = lane ? lane.clips.find((c) => c.id === selectedClip.clipId) : null;
  if (!lane || !clip) return;
  const next = absolute ? delta : Math.max(-12, Math.min(12, (clip.pitch || 0) + delta));
  clip.pitch = next;
  scheduleSaveTrack();
  updatePitchBar();
  const cv = document.querySelector(`.trk-lane-cv[data-lane="${lane.id}"]`);
  if (cv) drawLaneCanvas(cv, lane);
  if (!isPlaying) auditionSample(itemById(lane.itemId), lane.gain, (lane.pitch || 0) + next);
}

// ------------------------------------------------------------------ fill helpers & adding samples

function fillPatternFor(item, mode) {
  const totalBeats = state.track.bars * 4;
  const clips = [];
  if (mode === 'clear') return clips;
  if (mode === '4/4') {
    const durBeats = (item.channels[0].length / item.sr) / (60 / state.track.bpm);
    const step = (item.loop || item.category === 'loop' || item.category === 'break') && durBeats > 1.5
      ? Math.max(1, Math.round(durBeats / 4) * 4)
      : 1;
    for (let b = 0; b < totalBeats; b += step) clips.push({ id: newClipId(), beat: b, pitch: 0 });
  } else if (mode === 'offbeat') {
    for (let b = 0.5; b < totalBeats; b += 1) clips.push({ id: newClipId(), beat: b, pitch: 0 });
  } else if (mode === '2and4') {
    for (let b = 1; b < totalBeats; b += 2) clips.push({ id: newClipId(), beat: b, pitch: 0 });
  } else if (mode === 'bar1') {
    for (let b = 0; b < totalBeats; b += 4) clips.push({ id: newClipId(), beat: b, pitch: 0 });
  }
  return clips;
}

function defaultClipsForNewLane(item, dropBeat = null) {
  if (dropBeat !== null) return [{ id: newClipId(), beat: dropBeat, pitch: 0 }];
  if (item.category === 'kick' || item.category === 'beat') return fillPatternFor(item, '4/4');
  if (item.category === 'offbeat') return fillPatternFor(item, 'offbeat');
  if (item.category === 'loop' || item.category === 'break') return [{ id: newClipId(), beat: 0, pitch: 0 }];
  return [{ id: newClipId(), beat: 0, pitch: 0 }];
}

function adoptBpmIfEmpty(item) {
  if (state.track.lanes.length === 0 && item.bpm && Math.abs(item.bpm - state.track.bpm) >= 0.5) {
    const bpm = Math.round(item.bpm * 10) / 10;
    setTrackMeta({ bpm });
    toast(`Track BPM set to ${bpm}`);
  }
}

function addSampleAsLane(item, dropBeat = null) {
  if (!item) return;
  adoptBpmIfEmpty(item);
  const clips = defaultClipsForNewLane(item, dropBeat);
  addTrackLane(item.id, clips);
  toast(`Added ${escapeHtml(item.name)} to track`);
}

function ensureExtractedInLibrary(sound) {
  const existing = state.items.find(
    (it) => it.name === sound.name && it.category === sound.category && it.song === sound.song && it.channels[0].length === sound.channels[0].length,
  );
  if (existing) return existing;
  return addItem(sound);
}

function resolveDraggedItem() {
  if (!dragSample) return null;
  if (dragSample.kind === 'library') return itemById(dragSample.id);
  const ext = extractedSounds.find((s) => s.key === dragSample.id);
  return ext ? ensureExtractedInLibrary(ext) : null;
}

// ------------------------------------------------------------------ file import

function guessCategory(name, durSec) {
  const n = name.toLowerCase();
  if (/kick|bd|bassdrum/.test(n)) return 'kick';
  if (/offbeat|rev.?bass|reverse/.test(n)) return 'offbeat';
  if (/loop|synth|melody|lead|arp/.test(n) || durSec >= 2.2) return 'loop';
  if (/break|pad|atmos/.test(n)) return 'break';
  if (/fx|riser|sweep|downlifter|uplifter|crash|impact|trans/.test(n)) return 'fx';
  return 'hit';
}

async function importAudioFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f && (/^audio\//.test(f.type) || /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(f.name)));
  if (!files.length) return;
  const chosenCat = $('#trkImportCat')?.value || 'auto';
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let added = 0;

  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const ab = await new Ctx(1, 1, 44100).decodeAudioData(buf);
      const channels = [];
      for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) {
        channels.push(ab.getChannelData(c).slice());
      }
      if (!channels.length) continue;
      // Verify valid mono mix possible
      if (!channels[0].length) continue;
      const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 28);
      const dur = channels[0].length / ab.sampleRate;
      const category = chosenCat === 'auto' ? guessCategory(baseName, dur) : chosenCat;
      const item = addItem({
        name: baseName,
        category,
        loop: category === 'loop',
        sr: ab.sampleRate,
        bpm: category === 'loop' ? state.track.bpm : null,
        loopLen: category === 'loop' ? dur : null,
        song: 'Imported',
        channels: channels.length === 2 ? channels : [mixToMono(channels)],
      });
      addTrackLane(item.id, defaultClipsForNewLane(item));
      added++;
    } catch (err) {
      console.error(err);
      toast(`Could not decode ${escapeHtml(file.name)}`);
    }
  }
  if (added) {
    toast(`Imported ${added} sample${added > 1 ? 's' : ''} & added to track`);
  }
}

// ------------------------------------------------------------------ rendering

function renderConsole() {
  const t = state.track;
  $('#trkName').value = t.name;
  $('#trkBpm').value = t.bpm;
  $('#trkBars').textContent = `${t.bars} bars`;
  $('#trkLoop').setAttribute('aria-pressed', !!t.loop);
  $('#trkBarsDown').disabled = t.bars <= 4;
  $('#trkBarsUp').disabled = t.bars >= 64;
  $('#trkZoomOut').disabled = zoomIdx <= 0;
  $('#trkZoomIn').disabled = zoomIdx >= ZOOM_STEPS.length - 1;

  const syncBtn = $('#trkSyncBpm');
  if (extractedBpm && Math.abs(extractedBpm - t.bpm) >= 0.2) {
    syncBtn.hidden = false;
    syncBtn.textContent = `Sync ${extractedBpm.toFixed(1)}`;
  } else {
    syncBtn.hidden = true;
  }
}

function renderStage() {
  const lanes = state.track.lanes;
  $('#trkEmpty').hidden = lanes.length > 0;
  $('#trkGridWrap').hidden = lanes.length === 0;
  $('#trkLaneCount').textContent = lanes.length ? `(${lanes.length})` : '';

  const headerList = $('#trkHeaderList');
  const lanesWrap = $('#trkLanes');
  const playhead = $('#trkPlayhead');

  headerList.innerHTML = '';
  // Keep playhead element, remove lane rows
  lanesWrap.querySelectorAll('.trk-lane').forEach((el) => el.remove());

  if (!lanes.length) return;

  const totalBeats = state.track.bars * 4;
  const totalW = totalBeats * pxPerBeat();
  lanesWrap.style.width = totalW + 'px';

  for (let idx = 0; idx < lanes.length; idx++) {
    const lane = lanes[idx];
    const item = itemById(lane.itemId);
    const cat = catOf(item?.category);

    // Header
    const hd = document.createElement('div');
    hd.className = 'trk-lane-head';
    hd.style.setProperty('--pc', cat.color);
    hd.innerHTML =
      `<div class="trk-lh-top">` +
        `<button type="button" class="play small" aria-label="Preview ${escapeHtml(item?.name || 'Sample')}">▶</button>` +
        `<span class="trk-lh-name" title="${escapeHtml(item?.name || 'Missing sample')}">${escapeHtml(item?.name || 'Missing')}</span>` +
        `<button type="button" class="trk-lh-del" aria-label="Remove lane" title="Remove lane">×</button>` +
      `</div>` +
      `<div class="trk-lh-ctrl">` +
        `<button type="button" class="hw trk-mute" aria-pressed="${!!lane.mute}" title="Mute">M</button>` +
        `<button type="button" class="hw trk-solo" aria-pressed="${!!lane.solo}" title="Solo">S</button>` +
        `<input type="range" class="trk-gain" min="0" max="1.5" step="0.02" value="${lane.gain ?? 1}" aria-label="Volume" title="Volume">` +
        `<select class="trk-fill" aria-label="Pattern actions" title="Quick fill or reorder">` +
          `<option value="">Fill…</option>` +
          `<option value="4/4">4/4 beats</option>` +
          `<option value="offbeat">Off-beats (&amp;)</option>` +
          `<option value="2and4">2 &amp; 4 (clap)</option>` +
          `<option value="bar1">Downbeats (bar 1)</option>` +
          `<option value="clear">Clear lane</option>` +
          (idx > 0 ? `<option value="up">Move up</option>` : '') +
          (idx < lanes.length - 1 ? `<option value="down">Move down</option>` : '') +
        `</select>` +
      `</div>`;

    hd.querySelector('.play').onclick = (e) => {
      if (item) preview(item.channels, item.sr, e.currentTarget);
    };
    hd.querySelector('.trk-lh-del').onclick = () => {
      if (selectedClip?.laneId === lane.id) { selectedClip = null; updatePitchBar(); }
      removeTrackLane(lane.id);
    };
    hd.querySelector('.trk-mute').onclick = () => {
      updateTrackLane(lane.id, { mute: !lane.mute });
      updateLiveGains();
    };
    hd.querySelector('.trk-solo').onclick = () => {
      updateTrackLane(lane.id, { solo: !lane.solo });
      updateLiveGains();
    };
    const gainInput = hd.querySelector('.trk-gain');
    gainInput.addEventListener('input', (e) => {
      updateTrackLane(lane.id, { gain: +e.target.value }, false);
      updateLiveGains();
    });
    hd.querySelector('.trk-fill').addEventListener('change', (e) => {
      const val = e.target.value;
      e.target.value = '';
      if (!val) return;
      if (val === 'up') { moveTrackLane(lane.id, -1); return; }
      if (val === 'down') { moveTrackLane(lane.id, 1); return; }
      if (!item) return;
      setLaneClips(lane.id, fillPatternFor(item, val));
    });
    headerList.appendChild(hd);

    // Canvas row
    const row = document.createElement('div');
    row.className = 'trk-lane';
    const cv = document.createElement('canvas');
    cv.className = 'trk-lane-cv';
    cv.dataset.lane = lane.id;
    attachLanePointer(cv, lane);
    row.appendChild(cv);
    lanesWrap.insertBefore(row, playhead);
  }

  redrawAllCanvases();
}

function renderPalette() {
  $('#trkLibBadge').textContent = state.items.length;
  const extBtn = $('#trkSourceTabs [data-src="extracted"]');
  extBtn.hidden = extractedSounds.length === 0;
  $('#trkExtBadge').textContent = extractedSounds.length;
  if (palSource === 'extracted' && extractedSounds.length === 0) palSource = 'library';

  $('#trkSourceTabs').querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.src === palSource);
  });

  const sourceList = palSource === 'extracted' ? extractedSounds : state.items;
  const used = Object.keys(CATEGORIES).filter((k) => sourceList.some((it) => it.category === k));
  if (palFilter !== 'all' && !used.includes(palFilter)) palFilter = 'all';

  const fr = $('#trkPalFilter');
  fr.hidden = used.length < 2;
  fr.innerHTML = '';
  for (const k of ['all', ...used]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter';
    b.setAttribute('aria-pressed', palFilter === k);
    if (k !== 'all') b.style.setProperty('--pc', CATEGORIES[k].color);
    b.innerHTML = k === 'all' ? 'All' : `<i></i>${CATEGORIES[k].label}`;
    b.onclick = () => { palFilter = k; renderPalette(); };
    fr.appendChild(b);
  }

  const list = $('#trkPalList');
  const empty = $('#trkPalEmpty');
  const filtered = sourceList.filter((it) => palFilter === 'all' || it.category === palFilter);
  list.innerHTML = '';

  if (!sourceList.length) {
    empty.hidden = false;
    empty.textContent = palSource === 'library'
      ? 'Your library is empty. Import WAV/MP3 samples above, or save kicks from the Extract tab with +LP.'
      : 'Analyze a track in the Extract tab to grab its kicks and snippets here.';
    return;
  }
  empty.hidden = true;

  for (const it of filtered) {
    const cat = catOf(it.category);
    const secs = (it.channels[0].length / it.sr).toFixed(2);
    const li = document.createElement('li');
    li.className = 'trk-pal-item';
    li.style.setProperty('--pc', cat.color);
    li.draggable = true;
    li.innerHTML =
      `<button type="button" class="play small" aria-label="Preview ${escapeHtml(it.name)}">▶</button>` +
      `<div class="trk-pal-meta">` +
        `<span class="trk-pal-name">${escapeHtml(it.name)}</span>` +
        `<span class="trk-pal-facts"><i></i>${cat.label} · ${secs} s${it.bpm ? ` · ${it.bpm.toFixed(0)} BPM` : ''}</span>` +
      `</div>` +
      `<button type="button" class="btn small primary trk-pal-add">+ Add</button>`;

    li.querySelector('.play').onclick = (e) => preview(it.channels, it.sr, e.currentTarget);
    li.querySelector('.trk-pal-add').onclick = () => {
      const libItem = palSource === 'extracted' ? ensureExtractedInLibrary(it) : it;
      addSampleAsLane(libItem);
    };
    li.addEventListener('dragstart', (e) => {
      dragSample = { kind: palSource, id: palSource === 'extracted' ? it.key : it.id };
      e.dataTransfer?.setData('text/plain', it.name);
    });
    li.addEventListener('dragend', () => { dragSample = null; });
    list.appendChild(li);
  }
}

function renderAll() {
  renderConsole();
  renderStage();
  renderPalette();
  updatePitchBar();
}

// ------------------------------------------------------------------ init

export function initTrack() {
  subscribe((what) => {
    if (what === 'load' || what === 'track') {
      renderConsole();
      renderStage();
      updatePitchBar();
    }
    if (what === 'load' || what === 'items') {
      renderPalette();
      if (what === 'items') renderStage();
    }
  });

  // Transport buttons
  $('#trkPlay').addEventListener('click', () => {
    if (isPlaying) pausePlayback();
    else startPlayback();
  });
  $('#trkStop').addEventListener('click', () => stopPlayback(true));
  $('#trkLoop').addEventListener('click', () => setTrackMeta({ loop: !state.track.loop }));

  // Settings
  $('#trkName').addEventListener('change', (e) => {
    setTrackMeta({ name: e.target.value.trim() || 'My Track' });
  });
  $('#trkBpm').addEventListener('change', (e) => {
    const v = Math.max(60, Math.min(240, parseFloat(e.target.value) || 150));
    setTrackMeta({ bpm: v });
    if (isPlaying) startPlayback(playheadBeat);
  });
  $('#trkSyncBpm').addEventListener('click', () => {
    if (!extractedBpm) return;
    setTrackMeta({ bpm: Math.round(extractedBpm * 10) / 10 });
    if (isPlaying) startPlayback(playheadBeat);
  });
  $('#trkBarsDown').addEventListener('click', () => {
    const bars = Math.max(4, state.track.bars - 4);
    if (playheadBeat >= bars * 4) playheadBeat = 0;
    setTrackMeta({ bars });
  });
  $('#trkBarsUp').addEventListener('click', () => {
    setTrackMeta({ bars: Math.min(64, state.track.bars + 4) });
  });
  $('#trkSnap').addEventListener('change', (e) => {
    snapBeats = parseFloat(e.target.value) || 1;
    redrawAllCanvases();
  });

  // Tool toggle
  const setTool = (next) => {
    tool = next;
    $('#trkToolDraw').setAttribute('aria-pressed', tool === 'draw');
    $('#trkToolPitch').setAttribute('aria-pressed', tool === 'pitch');
    if (tool === 'draw') selectedClip = null;
    updatePitchBar();
    redrawAllCanvases();
  };
  $('#trkToolDraw').addEventListener('click', () => setTool('draw'));
  $('#trkToolPitch').addEventListener('click', () => setTool('pitch'));

  // Pitch bar controls
  $('#trkPitchBar').querySelectorAll('[data-semi]').forEach((b) => {
    b.addEventListener('click', () => shiftSelectedPitch(parseInt(b.dataset.semi, 10), false));
  });
  $('#trkPitchReset').addEventListener('click', () => shiftSelectedPitch(0, true));

  // Zoom
  $('#trkZoomOut').addEventListener('click', () => {
    zoomIdx = Math.max(0, zoomIdx - 1);
    renderConsole();
    renderStage();
  });
  $('#trkZoomIn').addEventListener('click', () => {
    zoomIdx = Math.min(ZOOM_STEPS.length - 1, zoomIdx + 1);
    renderConsole();
    renderStage();
  });

  // Ruler scrubbing
  const ruler = $('#trkRuler');
  let scrubbing = false;
  const scrubFrom = (e) => {
    const r = ruler.getBoundingClientRect();
    const x = Math.max(0, e.clientX - r.left);
    seekToBeat(x / pxPerBeat());
  };
  ruler.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    scrubbing = true;
    ruler.setPointerCapture(e.pointerId);
    scrubFrom(e);
  });
  ruler.addEventListener('pointermove', (e) => { if (scrubbing) scrubFrom(e); });
  const endScrub = () => { scrubbing = false; };
  ruler.addEventListener('pointerup', endScrub);
  ruler.addEventListener('pointercancel', endScrub);

  // Export & Clear
  const safe = (s) => String(s).replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'track';
  const doExport = async (fmt, btn) => {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const { channels, sr } = await renderTrackOffline();
      await download(channels, sr, safe(state.track.name), fmt);
    } catch (err) {
      toast(escapeHtml(err.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  };
  $('#trkWav').addEventListener('click', (e) => doExport('wav', e.currentTarget));
  $('#trkMp3').addEventListener('click', (e) => doExport('mp3', e.currentTarget));
  $('#trkToLp').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { channels, sr, totalSec } = await renderTrackOffline();
      openPadPicker({
        sound: {
          name: state.track.name || 'My Track',
          category: 'loop',
          loop: true,
          bpm: state.track.bpm,
          loopLen: totalSec,
          sr,
          channels,
          song: 'Track Builder',
        },
      });
    } catch (err) {
      toast(escapeHtml(err.message || String(err)));
    } finally {
      btn.disabled = false;
    }
  });

  const clearBtn = $('#trkClear');
  clearBtn.addEventListener('click', () => {
    if (!clearBtn.classList.contains('confirm')) {
      clearBtn.classList.add('confirm');
      clearBtn.textContent = 'Sure?';
      setTimeout(() => { clearBtn.classList.remove('confirm'); clearBtn.textContent = 'Clear'; }, 2500);
      return;
    }
    stopPlayback(true);
    selectedClip = null;
    clearBtn.classList.remove('confirm');
    clearBtn.textContent = 'Clear';
    clearTrack();
  });

  // Sample palette source tabs + import
  $('#trkSourceTabs').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      palSource = b.dataset.src;
      renderPalette();
    });
  });
  $('#trkImportFile').addEventListener('change', (e) => {
    importAudioFiles(e.target.files);
    e.target.value = '';
  });

  // Drop files or dragged samples onto Stage & Palette
  const stage = $('#trkStage');
  const pal = $('#trkPalette');
  for (const target of [stage, pal]) {
    ['dragenter', 'dragover'].forEach((ev) => target.addEventListener(ev, (e) => {
      if (e.dataTransfer?.types?.includes('Files') || dragSample) {
        e.preventDefault();
        target.classList.add('over');
      }
    }));
    ['dragleave', 'drop'].forEach((ev) => target.addEventListener(ev, (e) => {
      e.preventDefault();
      target.classList.remove('over');
    }));
    target.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) {
        importAudioFiles(e.dataTransfer.files);
      } else if (dragSample && target === stage) {
        const item = resolveDraggedItem();
        if (item) addSampleAsLane(item, 0);
      }
    });
  }

  // Receive newly extracted sounds from Extract tab
  window.addEventListener('kx:extracted', (e) => {
    extractedSounds = e.detail.sounds || [];
    extractedBpm = e.detail.bpm || null;
    renderConsole();
    renderPalette();
  });

  // Mutual transport exclusion
  window.addEventListener('kx:play', (e) => {
    if (e.detail !== 'track' && isPlaying) pausePlayback();
  });

  // Spacebar play/pause when Track tab is active
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#tab-track').hidden || $('#padPicker')?.open) return;
    const tag = document.activeElement?.tagName;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (isPlaying) pausePlayback();
      else startPlayback();
    }
  });

  renderAll();
}
