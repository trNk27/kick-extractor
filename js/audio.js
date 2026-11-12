// Shared audio helpers: one AudioContext, preview playback, WAV/MP3 export.
// A "sound" is { channels: Float32Array[], sr } (mono kicks have one channel, song snippets two).

let actx = null;
export function audioCtx() {
  actx ??= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

export const asChannels = (sig) => (Array.isArray(sig) ? sig : [sig]);

export function makeBuffer(channels, sr) {
  const ctx = audioCtx();
  const b = ctx.createBuffer(channels.length, channels[0].length, sr);
  channels.forEach((ch, i) => b.copyToChannel(ch, i));
  return b;
}

// ---------------------------------------------------------------- preview (the round ▶ buttons)

let current = null;
export function stopPreview() {
  if (!current) return;
  try { current.src.stop(); } catch { /* already stopped */ }
  if (current.btn) { current.btn.classList.remove('playing'); current.btn.textContent = '▶'; }
  current = null;
}

export function preview(sig, sr, btn) {
  const same = current && current.btn === btn;
  stopPreview();
  if (same) return; // second tap = stop
  const ctx = audioCtx();
  const src = ctx.createBufferSource();
  src.buffer = makeBuffer(asChannels(sig), sr);
  src.connect(ctx.destination);
  src.start();
  current = { src, btn };
  btn.classList.add('playing');
  btn.textContent = '■';
  src.onended = () => { if (current?.src === src) stopPreview(); };
}

// ---------------------------------------------------------------- export

export function encodeWav(channels, sr) {
  const nCh = channels.length, n = channels[0].length, bps = 3;
  const dataLen = n * nCh * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nCh * bps, true);
  v.setUint16(32, nCh * bps, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, q & 0xff); v.setUint8(o + 1, (q >> 8) & 0xff); v.setUint8(o + 2, (q >> 16) & 0xff);
      o += 3;
    }
  }
  return buf;
}

// MP3 encoder (lamejs, a JS port of LAME) is loaded the first time someone wants an MP3.
let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  lameLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/lame.min.js', import.meta.url).href;
    s.onload = () => resolve(window.lamejs);
    s.onerror = () => { lameLoading = null; reject(new Error('Could not load the MP3 encoder.')); };
    document.head.appendChild(s);
  });
  return lameLoading;
}

const toInt16 = (f) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
};

export async function encodeMp3(channels, sr) {
  const lame = await loadLame();
  const stereo = channels.length > 1;
  const enc = new lame.Mp3Encoder(stereo ? 2 : 1, sr, 320);
  const L = toInt16(channels[0]), R = stereo ? toInt16(channels[1]) : null;
  const chunks = [];
  for (let i = 0; i < L.length; i += 1152) {
    const b = stereo ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152));
    if (b.length) chunks.push(b);
  }
  const end = enc.flush();
  if (end.length) chunks.push(end);
  return new Blob(chunks, { type: 'audio/mpeg' });
}

export async function download(sig, sr, filenameBase, format) {
  const channels = asChannels(sig);
  const blob = format === 'mp3'
    ? await encodeMp3(channels, sr)
    : new Blob([encodeWav(channels, sr)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filenameBase}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
