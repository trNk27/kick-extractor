// Header scene: a tiny synthwave landscape rendered at low resolution and scaled up with hard pixels,
// ordered dithering instead of smooth gradients (the PS2/PS1-era look). The floor grid scrolls one line
// per beat while launchpad loops run, and pad hits flash the grid in the pad's colour.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const SKY = ['#060915', '#0a1029', '#121a42', '#2a1946', '#4f1a43', '#7a2141'].map(hex);
const SUN = ['#fff0a0', '#ffd23a', '#ffa21f', '#ff6a2a', '#ff3d6e', '#d62a72'].map(hex);
const FLOOR = hex('#04050b');
const MOUNTAIN = hex('#0b1131'), RIDGE = hex('#34407c');
const GRID = hex('#ff3d6e');
const GRID_RAMP = ['#24102c', '#4a1536', '#7d1d45', '#c22a5a', '#ff3d6e'].map(hex);

let cv, g, W = 0, H = 72, img, px, horizon, ridge, stars;
let flash = 0, flashColor = GRID, phase = 0, last = 0;
let transport = null;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function rgba([r, gg, b], a = 255) { return (a << 24) | (b << 16) | (gg << 8) | r; }

// pick between neighbouring palette steps with a 4x4 Bayer threshold
function ramp(pal, v, x, y) {
  const f = Math.max(0, Math.min(0.9999, v)) * (pal.length - 1);
  const i = Math.floor(f);
  return pal[Math.min(pal.length - 1, f - i > BAYER[(y & 3) * 4 + (x & 3)] ? i + 1 : i)];
}

function resize() {
  const r = cv.getBoundingClientRect();
  H = r.width < 600 ? 60 : 72;
  W = Math.max(64, Math.round(H * r.width / Math.max(1, r.height)));
  cv.width = W; cv.height = H;
  img = g.createImageData(W, H);
  px = new Uint32Array(img.data.buffer);
  horizon = Math.round(H * 0.56);
  // low-poly ridge: straight segments between a few random peaks, kept low near the sun
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts = [];
  for (let x = -8; x <= W + 16; x += 7 + Math.floor(rnd() * 9)) {
    const nearSun = Math.abs(x - W * 0.7) < H * 0.45;
    pts.push([x, horizon - (nearSun ? 1 + rnd() * 3 : 3 + rnd() * H * 0.2)]);
  }
  ridge = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const k = pts.findIndex((p) => p[0] > x);
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
    ridge[x] = y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  stars = [];
  for (let n = 0; n < W / 6; n++) stars.push([Math.floor(rnd() * W), Math.floor(rnd() * horizon * 0.7), rnd()]);
}

function draw(t) {
  const sunX = W * 0.7, sunR = H * 0.34 * (1 + flash * 0.06), sunY = horizon - sunR * 0.42;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c;
      if (y < horizon) {
        c = ramp(SKY, y / horizon, x, y);
        const dx = x - sunX, dy = y - sunY;
        if (dx * dx + dy * dy < sunR * sunR) {
          // classic sliced sun: gaps grow towards the bottom and drift down slowly
          const v = (y - (sunY - sunR)) / (2 * sunR);
          const band = (v * 9 + t * 0.35) % 1;
          if (!(v > 0.45 && band < (v - 0.45) * 1.1)) c = ramp(SUN, v - flash * 0.25, x, y);
        }
        if (y >= ridge[x]) c = y < ridge[x] + 1 ? RIDGE : MOUNTAIN;
      } else {
        c = FLOOR;
      }
      px[y * W + x] = rgba(c);
    }
  }
  for (const [sx, sy, tw] of stars) {
    if (sy < ridge[sx] && (Math.sin(t * 1.3 + tw * 40) > -0.6)) px[sy * W + sx] = rgba([200, 210, 255]);
  }
  // floor grid: solid lines whose colour steps down with distance (no stipple)
  const depth = H - horizon;
  const lineCol = (d) => {
    const v = Math.min(1, d * 1.15 + flash * 0.5);
    if (flash > 0.25 && d > 0.25) return flashColor;
    return GRID_RAMP[Math.min(GRID_RAMP.length - 1, Math.floor(v * GRID_RAMP.length))];
  };
  for (let k = 0; k < 8; k++) {
    const z = k + 1 - (phase % 1);
    const y = horizon + Math.round(depth * 1.15 / (z * 0.85 + 0.15)) - 1;
    if (y <= horizon || y >= H) continue;
    const c = rgba(lineCol((y - horizon) / depth));
    for (let x = 0; x < W; x++) px[y * W + x] = c;
  }
  // rays from the vanishing point, drawn as continuous lines (DDA) so steep ones don't break up
  const cx = W * 0.5, spread = W / 6;
  for (let i = -14; i <= 14; i++) {
    const x1 = cx + i * spread, y1 = H - 1;
    const steps = Math.max(Math.abs(x1 - cx), y1 - horizon);
    for (let s2 = 1; s2 <= steps; s2++) {
      const t = s2 / steps;
      const x = Math.round(cx + (x1 - cx) * t), y = Math.round(horizon + (y1 - horizon) * t);
      if (x < 0 || x >= W) continue;
      px[y * W + x] = rgba(lineCol((y - horizon) / depth));
    }
  }
  // horizon line
  const hc = rgba(GRID_RAMP[2]);
  for (let x = 0; x < W; x++) px[horizon * W + x] = hc;
  g.putImageData(img, 0, 0);
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000 || 0);
  last = now;
  if (transport) {
    // one grid line per beat, locked to the audio clock
    phase = (transport.ctx.currentTime - transport.start) / transport.beat;
  } else {
    phase += dt * 0.35;
  }
  flash *= Math.exp(-dt / 0.12);
  if (!document.hidden) draw(now / 1000);
  requestAnimationFrame(frame);
}

export const scene = {
  init() {
    cv = document.getElementById('scene');
    if (!cv) return;
    g = cv.getContext('2d');
    resize();
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); if (reduced) draw(0); }, 100); });
    if (reduced) draw(0);
    else requestAnimationFrame(frame);
  },
  hit(color, strength = 1) {
    if (reduced || !cv) return;
    flash = Math.max(flash, strength);
    flashColor = hex(color);
  },
  setTransport(t) { transport = t; },
};
