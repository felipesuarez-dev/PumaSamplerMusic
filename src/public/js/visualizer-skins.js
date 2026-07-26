// Central-display "skins": alternative visuals shown over the <video>/waveform
// surface when the user would rather not watch the video. All audio-reactive
// skins read from the audio engine's shared AnalyserNode (post-limiter tap);
// the vinyl skin only uses it to detect activity for its spin speed. The module
// owns a single overlay canvas, its own requestAnimationFrame loop, and the
// persisted skin choice. It never touches audio routing or the video element.
//
// The vinyl skin also carries the turntable scratch gesture. It still owns no
// audio knowledge: it hands out a normalized playback rate through the optional
// deck callbacks and lets the app do the rest.
import { RPM_33_RAD_PER_SEC, clampRate } from './turntable-core.js';

const STORAGE_KEY = 'puma-visualizer-skin';

// 'video' means "no skin" (show the real video/waveform underneath). Order is
// the cycle order and the menu order.
export const SKINS = ['video', 'waveform', 'bars', 'vinyl', 'bubbles'];

// Material Symbols glyph shown on the toggle button per skin.
export const SKIN_ICONS = {
  video: 'movie',
  waveform: 'graphic_eq',
  bars: 'equalizer',
  vinyl: 'album',
  bubbles: 'bubble_chart',
};

function readStoredSkin() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return SKINS.includes(stored) ? stored : 'video';
}

// Vinyl spin-speed multiplier (persisted). 1 = default speed.
const SPIN_KEY = 'puma-vinyl-spin-speed';
export const SPIN_SPEEDS = [0.5, 1, 1.5, 2];
function readStoredSpinSpeed() {
  const n = parseFloat(localStorage.getItem(SPIN_KEY));
  return SPIN_SPEEDS.includes(n) ? n : 1;
}

// --- Pure helpers for the vinyl skin (stateless; safe at module scope) ---
const TAU = Math.PI * 2;

function hexToRgb(str) {
  if (typeof str === 'string' && str.charCodeAt(0) === 35) { // '#'
    let h = str.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6) {
      const n = parseInt(h, 16);
      if (!Number.isNaN(n)) return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
  }
  return { r: 255, g: 159, b: 28 }; // graceful fallback accent
}
function mixRgb(c, t, a) {
  return {
    r: Math.round(c.r + (t.r - c.r) * a),
    g: Math.round(c.g + (t.g - c.g) * a),
    b: Math.round(c.b + (t.b - c.b) * a),
  };
}
function rgbStr(c, a) {
  return a == null ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${a})`;
}
function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, str, maxW) {
  if (ctx.measureText(str).width <= maxW) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.replace(/\s+$/, '') + '…';
}

// Static turntable tonearm — sells the record player and fills the wide
// canvas's right-side negative space. Not animated (a real arm barely moves).
// Modeled on a classic S-shaped arm: gimbal pivot base, counterweight cylinder
// behind the pivot, an S-bent tube, and an angled headshell with a stylus.
function drawTonearm(ctx, cx, cy, outerR, dpr, ac) {
  const px = cx + outerR * 1.42;            // pivot (top-right)
  const py = cy - outerR * 0.72;
  const restA = -Math.PI * 0.30;            // headshell rests up-right on grooves
  const rx = cx + Math.cos(restA) * outerR * 0.70;
  const ry = cy + Math.sin(restA) * outerR * 0.70;

  // Pivot -> tip axis, and its unit normal (for the S-bend + counterweight).
  const dx = rx - px, dy = ry - py;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;       // unit along the arm
  const nx = -uy, ny = ux;                   // unit perpendicular
  const bend = outerR * 0.13;                // S amplitude

  // S-curve control points: bow one way near the pivot, the other near the tip.
  const c1x = px + dx * 0.33 + nx * bend, c1y = py + dy * 0.33 + ny * bend;
  const c2x = px + dx * 0.68 - nx * bend, c2y = py + dy * 0.68 - ny * bend;

  // Counterweight sits behind the pivot, opposite the arm direction.
  const cwDist = outerR * 0.26;
  const cwx = px - ux * cwDist, cwy = py - uy * cwDist;

  const armW = 3.4 * dpr;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1. Soft drop shadow of the whole arm (offset down-right).
  ctx.save();
  ctx.translate(2 * dpr, 3 * dpr);
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = armW + 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, rx, ry); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cwx, cwy); ctx.stroke();
  ctx.restore();

  // 2. Counterweight stem + cylinder.
  ctx.strokeStyle = 'rgba(120,127,138,0.9)';
  ctx.lineWidth = 3 * dpr;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cwx, cwy); ctx.stroke();
  ctx.save();
  ctx.translate(cwx, cwy);
  ctx.rotate(Math.atan2(uy, ux));
  const cwR = 7 * dpr, cwL = 13 * dpr;
  const cwGrad = ctx.createLinearGradient(0, -cwR, 0, cwR);
  cwGrad.addColorStop(0, 'rgba(196,202,211,0.96)');
  cwGrad.addColorStop(0.5, 'rgba(120,127,138,0.96)');
  cwGrad.addColorStop(1, 'rgba(70,76,85,0.96)');
  ctx.fillStyle = cwGrad;
  roundRectPath(ctx, -cwL * 0.55, -cwR, cwL, cwR * 2, cwR * 0.7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,44,51,0.7)';
  ctx.lineWidth = 1 * dpr;
  ctx.stroke();
  ctx.restore();

  // 3. Arm tube (S-bend), with a metallic top highlight.
  ctx.strokeStyle = 'rgba(150,157,168,0.95)';
  ctx.lineWidth = armW;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, rx, ry); ctx.stroke();
  ctx.strokeStyle = 'rgba(224,229,236,0.85)';
  ctx.lineWidth = armW * 0.42;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, rx, ry); ctx.stroke();

  // 4. Gimbal pivot base: dark mount ring, metallic collar, bright cap.
  const pivotR = 9 * dpr;
  ctx.fillStyle = 'rgba(38,42,49,0.96)';
  ctx.beginPath(); ctx.arc(px, py, pivotR, 0, TAU); ctx.fill();
  const collarGrad = ctx.createLinearGradient(px, py - pivotR, px, py + pivotR);
  collarGrad.addColorStop(0, 'rgba(206,212,221,0.98)');
  collarGrad.addColorStop(1, 'rgba(96,103,114,0.98)');
  ctx.fillStyle = collarGrad;
  ctx.beginPath(); ctx.arc(px, py, pivotR * 0.66, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(60,66,75,0.95)';
  ctx.beginPath(); ctx.arc(px, py, pivotR * 0.30, 0, TAU); ctx.fill();

  // 5. Headshell at the tip, angled along the arm, with a stylus accent dot.
  ctx.save();
  ctx.translate(rx, ry);
  ctx.rotate(Math.atan2(uy, ux));
  const hsGrad = ctx.createLinearGradient(0, -5 * dpr, 0, 5 * dpr);
  hsGrad.addColorStop(0, 'rgba(228,232,238,0.95)');
  hsGrad.addColorStop(1, 'rgba(150,157,168,0.95)');
  ctx.fillStyle = hsGrad;
  roundRectPath(ctx, -4 * dpr, -5 * dpr, 16 * dpr, 10 * dpr, 2.5 * dpr);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,44,51,0.55)';
  ctx.lineWidth = 1 * dpr;
  ctx.stroke();
  // finger lift
  ctx.strokeStyle = 'rgba(120,127,138,0.9)';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.moveTo(-4 * dpr, -3 * dpr); ctx.lineTo(-9 * dpr, -6 * dpr); ctx.stroke();
  // stylus tip (accent) touching the groove
  ctx.fillStyle = rgbStr(ac);
  ctx.beginPath(); ctx.arc(13 * dpr, 0, 1.8 * dpr, 0, TAU); ctx.fill();
  ctx.restore();

  ctx.restore();
}

// mm:ss for the vinyl label (formatTime in state.js includes .mmm, too noisy
// for a static print).
function formatMinSec(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function createVisualizerSkins({
  container, canvas, getAnalyser, getMediaTitle, getMediaDuration, getHasSession,
  // Optional turntable-deck adapter. Flat single-purpose callbacks, matching the
  // getters above rather than introducing a grouped object. All absent (or
  // isDeckAvailable false) => the disc stays decorative, byte-for-byte as before.
  isDeckAvailable, onDeckGrab, onDeckRate, onDeckRelease,
}) {
  const ctx = canvas.getContext('2d');
  // `skin` is the user's persisted preference; `activeSkin` is what actually
  // renders right now. They differ when video media forces the video view even
  // though a skin is stored (video wins on each video load, non-persisted).
  let skin = readStoredSkin();
  let activeSkin = skin;
  let spinSpeed = readStoredSpinSpeed();
  let rafId = null;
  let angle = 0; // vinyl rotation, radians
  let lastFrameMs = 0; // for dt on the deck paths only
  const particles = []; // bubbles state

  // Turntable-deck gesture state. `owns` means the deck (not the free-spin
  // accumulator) is driving `angle`; `grabbed` means the hand is on the record.
  const deckState = { owns: false, grabbed: false, rate: 0, resume: false, pointerId: null, lastAngle: 0, lastMs: 0, omega: 0 };
  let cursorOnDisc = false;

  // Reused analysis buffers, sized on first use from the live analyser.
  let freqData = null;
  let timeData = null;

  // Vinyl gradient cache (closure-scoped so it resets cleanly on teardown and
  // never thrashes across instances). Rebuilt by buildVinylCache() whenever the
  // guard in drawVinyl detects a size/accent/dpr change; resize() forces it via
  // vinyl.w = 0.
  const vinyl = { w: 0, h: 0, accent: '', dpr: 0 };

  function accent() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff9f1c';
  }

  function buildVinylCache(vAccent, dpr) {
    const w = canvas.width, h = canvas.height;
    const cx = Math.round(w * 0.44);          // nudged left → tonearm room right
    const cy = Math.round(h * 0.5);
    const outerR = Math.min(w, h) * 0.44;      // height-constrained on wide canvas
    const labelR = outerR * 0.36;
    const hr = Math.max(2.5 * dpr, labelR * 0.11);
    const ac = hexToRgb(vAccent);
    const black = { r: 0, g: 0, b: 0 }, white = { r: 255, g: 255, b: 255 };

    Object.assign(vinyl, { w, h, accent: vAccent, dpr, cx, cy, outerR, labelR, hr, ac });
    vinyl.textColor = lum(ac) > 0.6 ? 'rgba(22,17,8,0.92)' : 'rgba(255,255,255,0.95)';

    const bg = ctx.createRadialGradient(cx, cy, outerR * 0.15, cx, cy, Math.max(w, h) * 0.78);
    bg.addColorStop(0, rgbStr(mixRgb(black, ac, 0.14), 0.45));
    bg.addColorStop(0.45, 'rgba(12,15,22,0.28)');
    bg.addColorStop(1, 'rgba(6,8,12,0)');
    vinyl.bg = bg;

    const glow = ctx.createRadialGradient(cx, cy, outerR * 0.2, cx, cy, outerR * 1.5);
    glow.addColorStop(0, rgbStr(ac, 0.5));
    glow.addColorStop(1, rgbStr(ac, 0));
    vinyl.glow = glow;

    const ground = ctx.createRadialGradient(cx, cy + outerR * 0.55, outerR * 0.2, cx, cy + outerR * 0.55, outerR * 1.1);
    ground.addColorStop(0, 'rgba(0,0,0,0.5)');
    ground.addColorStop(1, 'rgba(0,0,0,0)');
    vinyl.ground = ground;

    const body = ctx.createRadialGradient(
      cx - outerR * 0.18, cy - outerR * 0.18, outerR * 0.04, cx, cy, outerR);
    body.addColorStop(0.00, '#191d24');
    body.addColorStop(0.30, '#101319');
    body.addColorStop(0.70, '#0b0d12');
    body.addColorStop(0.93, '#0f131a');
    body.addColorStop(0.975, '#20252f');   // rim catch-light
    body.addColorStop(1.00, '#05060a');
    vinyl.body = body;

    const label = ctx.createRadialGradient(
      cx - labelR * 0.25, cy - labelR * 0.28, labelR * 0.04, cx, cy, labelR);
    label.addColorStop(0.00, rgbStr(mixRgb(ac, white, 0.32)));
    label.addColorStop(0.55, rgbStr(ac));
    label.addColorStop(1.00, rgbStr(mixRgb(ac, black, 0.48)));
    vinyl.label = label;

    const hole = ctx.createRadialGradient(cx, cy, 0, cx, cy, hr * 1.7);
    hole.addColorStop(0, '#000');
    hole.addColorStop(0.62, '#04050700');
    hole.addColorStop(0.62, 'rgba(4,5,7,0.9)');
    hole.addColorStop(1, 'rgba(4,5,7,0)');
    vinyl.hole = hole;

    // Sweeping specular sheen, built once at origin and swept by rotating the
    // context each frame (never rebuilt per frame). Radial-blob fallback where
    // conic gradients are unsupported.
    if (typeof ctx.createConicGradient === 'function') {
      const sh = ctx.createConicGradient(0, 0, 0);
      sh.addColorStop(0.00, 'rgba(255,255,255,0)');
      sh.addColorStop(0.05, 'rgba(255,255,255,0.16)');
      sh.addColorStop(0.11, 'rgba(255,255,255,0.02)');
      sh.addColorStop(0.18, 'rgba(255,255,255,0)');
      sh.addColorStop(0.50, 'rgba(255,255,255,0)');
      sh.addColorStop(0.55, 'rgba(255,255,255,0.10)');
      sh.addColorStop(0.62, 'rgba(255,255,255,0.015)');
      sh.addColorStop(0.68, 'rgba(255,255,255,0)');
      sh.addColorStop(1.00, 'rgba(255,255,255,0)');
      vinyl.sheen = sh;
      vinyl.blob = null;
    } else {
      vinyl.sheen = null;
      const blob = ctx.createRadialGradient(0, -outerR * 0.5, 0, 0, -outerR * 0.5, outerR * 0.6);
      blob.addColorStop(0, 'rgba(255,255,255,0.12)');
      blob.addColorStop(1, 'rgba(255,255,255,0)');
      vinyl.blob = blob;
    }

    const vig = ctx.createRadialGradient(cx, cy, outerR * 0.6, cx, cy, Math.max(w, h) * 0.72);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(3,4,6,0.55)');
    vinyl.vignette = vig;

    // --- Turntable (platter + plinth) drawn beneath the disc ---
    const platterR = outerR * 1.14;           // platter peeks out around the record
    vinyl.platterR = platterR;
    const platter = ctx.createRadialGradient(
      cx - platterR * 0.2, cy - platterR * 0.2, platterR * 0.1, cx, cy, platterR);
    platter.addColorStop(0, '#3a4150');
    platter.addColorStop(0.6, '#262b35');
    platter.addColorStop(0.92, '#1a1e26');
    platter.addColorStop(1, '#0c0e13');
    vinyl.platter = platter;

    // Brushed-metal plinth (deck base): a wide rounded slab filling the frame.
    const plinth = ctx.createLinearGradient(0, cy - platterR, 0, cy + platterR * 1.05);
    plinth.addColorStop(0, '#20242c');
    plinth.addColorStop(0.5, '#171a21');
    plinth.addColorStop(1, '#0b0d12');
    vinyl.plinth = plinth;

    // Title glyph-advance cache: recomputed when the title/label size changes,
    // so per-frame curved text needs no measureText calls.
    vinyl.titleCache = null;
  }

  // DPR-aware sizing. Must run whenever the canvas becomes visible: a canvas
  // measured while display:none reads 1x1 and stays that way until resized (the
  // same gotcha media-display.js documents for its waveform).
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    vinyl.w = 0; // force the vinyl gradient cache to rebuild at the new size
  }

  function ensureBuffers(analyser) {
    if (!freqData || freqData.length !== analyser.frequencyBinCount) {
      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
    }
  }

  // Rough loudness 0..1 from frequency data, used to speed up the vinyl and
  // energize the bubbles. Returns 0 when there's no analyser/signal yet.
  // Averages only the lower ~60% of bins: the upper bins sit near zero for
  // most material, and including them (as this used to) diluted the mean so
  // heavily that bubbles never spawned. drawBars restricts bins for the same
  // reason.
  function loudness() {
    const analyser = getAnalyser();
    if (!analyser) return 0;
    ensureBuffers(analyser);
    analyser.getByteFrequencyData(freqData);
    const usable = Math.max(1, Math.floor(freqData.length * 0.6));
    let sum = 0;
    for (let i = 0; i < usable; i++) sum += freqData[i];
    return sum / (usable * 255);
  }

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawWaveform() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    clear();
    const analyser = getAnalyser();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = accent();
    ctx.beginPath();
    if (analyser) {
      ensureBuffers(analyser);
      analyser.getByteTimeDomainData(timeData);
      const slice = w / timeData.length;
      // Amplitude gain: real program material (post compressor+soft-clip) peaks
      // well below full scale, so the raw -1..1 sample drawn at h/2.4 looked
      // tiny/flat. Multiply by GAIN and clamp so loud transients fill the height
      // without spilling off-canvas.
      const GAIN = 2.8;
      const amp = h * 0.45;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 128 - 1; // -1..1
        const scaled = Math.max(-1, Math.min(1, v * GAIN));
        const y = h / 2 + scaled * amp;
        const x = i * slice;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    } else {
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
    }
    ctx.stroke();
  }

  function drawBars() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    clear();
    const analyser = getAnalyser();
    if (!analyser) return;
    ensureBuffers(analyser);
    analyser.getByteFrequencyData(freqData);
    // Use the lower ~75% of bins (upper bins are mostly empty) spread across
    // a fixed number of bars.
    const bars = 48;
    const usable = Math.floor(freqData.length * 0.75);
    const gap = 2 * dpr;
    const barW = (w - gap * (bars - 1)) / bars;
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, accent());
    grad.addColorStop(1, '#ffffff');
    ctx.fillStyle = grad;
    for (let b = 0; b < bars; b++) {
      const idx = Math.floor((b / bars) * usable);
      const mag = freqData[idx] / 255;
      const barH = Math.max(2 * dpr, mag * h);
      const x = b * (barW + gap);
      ctx.fillRect(x, h - barH, barW, barH);
    }
  }

  function drawBubbles() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    clear();
    const level = loudness();
    // Spawn bubbles proportional to loudness, capped so it never floods. Gate
    // low and guarantee at least one bubble once it passes: the old
    // Math.round(level*4) truncated to 0 until level>=0.125, so bubbles almost
    // never appeared.
    if (level > 0.02 && particles.length < 80) {
      const n = Math.max(1, Math.round(level * 8));
      for (let i = 0; i < n; i++) {
        particles.push({
          x: Math.random() * w,
          y: h + 10 * dpr,
          r: (4 + Math.random() * 10 + level * 20) * dpr,
          vy: (0.5 + Math.random() * 1.5 + level * 3) * dpr,
          life: 1,
        });
      }
    }
    const color = accent();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.y -= p.vy;
      p.life -= 0.006;
      if (p.life <= 0 || p.y + p.r < 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, p.life) * 0.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Premium turntable: glossy disc lit top-left, fine grooves, a swept conic
  // specular sheen (the main motion cue), an accent label with the track title
  // and spindle hole, a static tonearm, and an ambient wash + vignette to
  // compose the wide canvas. Subtle level reactivity (bloom + label glow).
  function drawVinyl() {
    const w = canvas.width, h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const ac2 = accent();

    if (vinyl.w !== w || vinyl.h !== h || vinyl.accent !== ac2 || vinyl.dpr !== dpr) {
      buildVinylCache(ac2, dpr);
    }
    const { cx, cy, outerR, labelR, hr, ac } = vinyl;
    const level = loudness();
    const lv = level > 0 ? (level > 1 ? 1 : level) : 0;

    // The record turns only while a session is loaded — at a lively idle speed,
    // faster with audio. With no session it sits still (a stopped turntable).
    //
    // While the deck owns the disc, `angle` is written by the gesture (1:1 with
    // the hand) or integrated from the audio rate, so the visual is not a
    // separate approximation of the sound -- it IS the sound's position. Handing
    // back is a no-op: `angle` is a plain accumulator, so the free spin resumes
    // from wherever the scratch left it with no seam.
    if (!deckState.owns && (!getHasSession || getHasSession())) {
      angle += (0.05 + lv * 0.15) * spinSpeed;
    }

    clear();

    /* 1. ambient accent wash */
    ctx.fillStyle = vinyl.bg;
    ctx.fillRect(0, 0, w, h);

    /* 1b. subtle level bloom */
    if (lv > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = lv * 0.5;
      ctx.fillStyle = vinyl.glow;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    /* 0. turntable: brushed-metal plinth slab + the platter the record sits on,
       with a ring of strobe dots at the platter edge (the classic pitch-strobe
       look). Drawn beneath the disc. */
    const platterR = vinyl.platterR;
    ctx.save();
    if (typeof ctx.roundRect === 'function') {
      const px = Math.max(0, cx - platterR * 1.35);
      const pw = Math.min(w, cx + platterR * 1.9) - px;
      const ph = platterR * 2.1;
      ctx.beginPath();
      ctx.roundRect(px, cy - ph / 2, pw, ph, 14 * dpr);
      ctx.fillStyle = vinyl.plinth;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
    }
    // platter
    ctx.fillStyle = vinyl.platter;
    ctx.beginPath(); ctx.arc(cx, cy, platterR, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, platterR, 0, TAU); ctx.stroke();
    // strobe dots at the platter rim, rotating with the platter
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle * 0.5);
    ctx.fillStyle = rgbStr(ac, 0.75);
    const dots = 40;
    for (let i = 0; i < dots; i++) {
      const a = (i / dots) * TAU;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * platterR * 0.965, Math.sin(a) * platterR * 0.965, 1.1 * dpr, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();

    /* 2. contact shadow */
    ctx.fillStyle = vinyl.ground;
    ctx.beginPath();
    ctx.ellipse(cx, cy + outerR * 0.55, outerR * 1.05, outerR * 0.5, 0, 0, TAU);
    ctx.fill();

    /* 3. disc body */
    ctx.fillStyle = vinyl.body;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, TAU);
    ctx.fill();

    /* 4. grooves */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR * 0.985, 0, TAU);
    ctx.arc(cx, cy, labelR * 1.02, 0, TAU);
    ctx.clip('evenodd');
    const gInner = labelR * 1.05, gOuter = outerR * 0.965;
    const step = Math.max(1.7 * dpr, (gOuter - gInner) / 90);
    ctx.lineWidth = Math.max(0.55 * dpr, step * 0.4);
    for (let r = gInner; r <= gOuter; r += step) {
      const a = 0.05 + 0.028 * Math.sin(r * 0.45);
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 3; i++) {
      const r = gInner + (gOuter - gInner) * (0.42 + i * 0.2);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    /* 5. sweeping sheen (rotate context so the cached gradient sweeps) */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR * 0.985, 0, TAU);
    ctx.arc(cx, cy, labelR * 1.0, 0, TAU);
    ctx.clip('evenodd');
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.6 + lv * 0.3;
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    if (vinyl.sheen) {
      ctx.fillStyle = vinyl.sheen;
      ctx.beginPath(); ctx.arc(0, 0, outerR, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = vinyl.blob;
      ctx.beginPath(); ctx.arc(0, 0, outerR, 0, TAU); ctx.fill();
      ctx.rotate(Math.PI);
      ctx.beginPath(); ctx.arc(0, 0, outerR, 0, TAU); ctx.fill();
    }
    ctx.restore();

    /* 6. rim */
    ctx.save();
    ctx.lineWidth = 1.1 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(cx, cy, outerR * 0.985, 0, TAU); ctx.stroke();
    ctx.lineWidth = 2.4 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, TAU); ctx.stroke();
    ctx.restore();

    /* 7. label + level glow */
    ctx.save();
    if (lv > 0.02) {
      ctx.shadowColor = rgbStr(ac, 0.55);
      ctx.shadowBlur = (6 + lv * 20) * dpr;
    }
    ctx.fillStyle = vinyl.label;
    ctx.beginPath(); ctx.arc(cx, cy, labelR, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = rgbStr(mixRgb(ac, { r: 0, g: 0, b: 0 }, 0.5), 0.55);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, labelR * 0.97, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, labelR * 0.58, 0, TAU); ctx.stroke();
    ctx.restore();

    // rotating tick marks near the label rim
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = rgbStr(mixRgb(ac, { r: 0, g: 0, b: 0 }, 0.45), 0.3);
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(c * labelR * 0.86, s * labelR * 0.86);
      ctx.lineTo(c * labelR * 0.92, s * labelR * 0.92);
      ctx.stroke();
    }
    ctx.restore();

    /* 8. curved title (rotates with the disc) + track-duration readout */
    const title = (getMediaTitle && getMediaTitle()) || '';
    if (title) {
      const fs = Math.max(9 * dpr, labelR * 0.22);
      const titleFont = `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      const tr = labelR * 0.8; // arc radius for the glyphs

      // Rebuild the per-glyph angular layout only when the title/size changes,
      // so no measureText runs per frame.
      if (!vinyl.titleCache || vinyl.titleCache.title !== title || vinyl.titleCache.fs !== fs) {
        ctx.font = titleFont;
        const maxArc = 2.4; // radians (~137°) across the top before truncating
        const glyphs = [];
        let total = 0;
        let truncated = false;
        for (const ch of title) {
          const wd = ctx.measureText(ch).width;
          const aw = wd / tr;
          if (total + aw > maxArc) { truncated = true; break; }
          glyphs.push({ ch, aw });
          total += aw;
        }
        if (truncated) {
          const ell = ctx.measureText('…').width / tr;
          glyphs.push({ ch: '…', aw: ell });
          total += ell;
        }
        // Center the arc over the top of the label (−90°).
        let a = -Math.PI / 2 - total / 2;
        for (const g of glyphs) { g.angle = a + g.aw / 2; a += g.aw; }
        vinyl.titleCache = { title, fs, glyphs };
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle); // spin the title with the disc
      ctx.font = titleFont;
      ctx.fillStyle = vinyl.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const g of vinyl.titleCache.glyphs) {
        ctx.save();
        ctx.rotate(g.angle + Math.PI / 2); // glyph upright relative to its arc point
        ctx.translate(0, -tr);
        ctx.fillText(g.ch, 0, 0);
        ctx.restore();
      }
      ctx.restore();

      // Track length: a monospaced timecode laid out on a bottom arc that
      // ROTATES WITH the disc (mirrors the title's top arc), so it reads like
      // engraving on the label instead of a static overlay.
      const durationLabel = formatMinSec(getMediaDuration && getMediaDuration());
      if (durationLabel) {
        const tcFs = Math.max(7 * dpr, labelR * 0.16);
        const timeFont = `600 ${tcFs}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
        const ttr = labelR * 0.62; // arc radius for the timecode glyphs (inside the title)
        if (!vinyl.timeCache || vinyl.timeCache.label !== durationLabel || vinyl.timeCache.fs !== tcFs) {
          ctx.font = timeFont;
          const glyphs = [];
          let total = 0;
          for (const ch of durationLabel) {
            const aw = ctx.measureText(ch).width / ttr;
            glyphs.push({ ch, aw });
            total += aw;
          }
          // Center the arc at the BOTTOM of the label (+90°).
          let a = Math.PI / 2 - total / 2;
          for (const g of glyphs) { g.angle = a + g.aw / 2; a += g.aw; }
          vinyl.timeCache = { label: durationLabel, fs: tcFs, glyphs };
        }
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle); // spin with the disc
        ctx.font = timeFont;
        ctx.fillStyle = vinyl.textColor;
        ctx.globalAlpha = 0.85;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const g of vinyl.timeCache.glyphs) {
          ctx.save();
          ctx.rotate(g.angle - Math.PI / 2); // glyph upright along the bottom arc
          ctx.translate(0, ttr);
          ctx.fillText(g.ch, 0, 0);
          ctx.restore();
        }
        ctx.restore();
      }
    }

    /* 9. spindle hole */
    ctx.save();
    ctx.fillStyle = vinyl.hole;
    ctx.beginPath(); ctx.arc(cx, cy, hr * 1.7, 0, TAU); ctx.fill();
    ctx.fillStyle = '#020304';
    ctx.beginPath(); ctx.arc(cx, cy, hr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.8 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, hr, Math.PI * 1.15, Math.PI * 1.75); ctx.stroke();
    ctx.restore();

    /* 10. tonearm */
    drawTonearm(ctx, cx, cy, outerR, dpr, ac);

    /* 11. vignette */
    ctx.fillStyle = vinyl.vignette;
    ctx.fillRect(0, 0, w, h);
  }

  function renderFrame() {
    switch (activeSkin) {
      case 'waveform': drawWaveform(); break;
      case 'bars': drawBars(); break;
      case 'bubbles': drawBubbles(); break;
      case 'vinyl': drawVinyl(); break;
      default: break;
    }
  }

  // ---- turntable deck gesture ----------------------------------------------

  const MAX_DECK_RATE = 4;
  // One-pole smoothing of hand speed, ~20ms. Deliberately not the 10-frame
  // boxcar the reference implementations use: a boxcar over irregular pointer
  // timestamps does not conserve area, so the audio ends up ~10 pointer frames
  // behind the disc and the error grows with gesture length instead of
  // cancelling. A one-pole has half the group delay and is timestamp-correct.
  const OMEGA_TAU_SECONDS = 0.02;
  // Decay of rate toward its target after release, and the band within which we
  // declare it settled and snap exactly (see audio-engine's setDeckRate).
  const INERTIA_TAU_SECONDS = 0.18;
  const SETTLE_EPSILON = 0.02;

  function deckEnabled() {
    return activeSkin === 'vinyl' && typeof isDeckAvailable === 'function' && isDeckAvailable();
  }

  // Pointer CSS px -> canvas device px. Do NOT use window.devicePixelRatio:
  // resize() ROUNDS the backing store and the CSS box can be fractional, so the
  // true ratio is canvas.width/rect.width -- which is also immune to a dpr that
  // changed since the last resize (monitor switch, browser zoom). Everything in
  // `vinyl` (cx, cy, outerR) is in device px.
  function toDevicePoint(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // The record only -- not the annulus out to platterR, which is the slipmat and
  // does not turn with the record.
  function isOnDisc(p) {
    if (!p || !vinyl.outerR) return false;
    return Math.hypot(p.x - vinyl.cx, p.y - vinyl.cy) <= vinyl.outerR;
  }

  function pointerAngle(p) {
    return Math.atan2(p.y - vinyl.cy, p.x - vinyl.cx);
  }

  function setCursorState(onDisc, grabbing) {
    container.classList.toggle('skin-scratchable', onDisc && !grabbing);
    container.classList.toggle('skin-scratching', grabbing);
  }

  // Hover-only: gates the hand cursor on the SAME hit test the grab uses, so it
  // appears over the record and not over the platter rim. Only writes when the
  // value actually changes, not on every pointermove.
  function updateDeckCursor(e) {
    if (deckState.grabbed) return;
    if (!deckEnabled()) {
      if (cursorOnDisc) { cursorOnDisc = false; setCursorState(false, false); }
      return;
    }
    const on = isOnDisc(toDevicePoint(e));
    if (on === cursorOnDisc) return;
    cursorOnDisc = on;
    setCursorState(on, false);
  }

  function onDeckPointerDown(e) {
    if (!deckEnabled() || deckState.grabbed) return;
    const p = toDevicePoint(e);
    if (!isOnDisc(p)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    deckState.pointerId = e.pointerId;
    deckState.grabbed = true;
    deckState.owns = true;
    deckState.rate = 0;
    deckState.omega = 0;
    deckState.lastAngle = pointerAngle(p);
    deckState.lastMs = e.timeStamp;
    setCursorState(true, true);
    // The app decides what "grab" means (pause the centre track, arm, seek) and
    // tells us whether releasing should resume playing.
    deckState.resume = Boolean(onDeckGrab && onDeckGrab());
    if (onDeckRate) onDeckRate(0);
  }

  function onDeckPointerMove(e) {
    if (!deckState.grabbed || e.pointerId !== deckState.pointerId) return;
    // Chrome aligns pointermove to rAF and folds the intermediate samples
    // inside, so without this a 120Hz pointer is sampled at 60Hz and the
    // velocity estimate comes out jerky.
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = samples.length ? samples : [e];
    for (const ev of events) {
      const p = toDevicePoint(ev);
      if (!p) continue;
      const a = pointerAngle(p);
      // Unwrap to (-PI, PI] so crossing the seam isn't read as a full turn.
      let d = a - deckState.lastAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const dt = Math.max(0.001, (ev.timeStamp - deckState.lastMs) / 1000);
      deckState.lastAngle = a;
      deckState.lastMs = ev.timeStamp;
      const instantOmega = d / dt;
      const k = 1 - Math.exp(-dt / OMEGA_TAU_SECONDS);
      deckState.omega += (instantOmega - deckState.omega) * k;
      // The visual follows the hand 1:1 -- the disc IS where the finger is.
      angle += d;
    }
    deckState.rate = clampRate(deckState.omega / RPM_33_RAD_PER_SEC, MAX_DECK_RATE);
    if (onDeckRate) onDeckRate(deckState.rate);
  }

  function onDeckPointerUp(e) {
    if (!deckState.grabbed || e.pointerId !== deckState.pointerId) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    deckState.grabbed = false;
    deckState.pointerId = null;
    setCursorState(cursorOnDisc, false);
    // deckState.owns stays true: the inertia integrator in renderFrame keeps
    // driving both the angle and the rate until it settles.
  }

  // Drops any live capture and hands the disc back to the free-spin accumulator.
  // Called when the skin or media changes mid-gesture, so a pointer can never be
  // stranded and the disc can never stay stuck "grabbed".
  function abandonDeckGesture() {
    if (deckState.pointerId !== null && canvas.hasPointerCapture(deckState.pointerId)) {
      canvas.releasePointerCapture(deckState.pointerId);
    }
    const wasActive = deckState.owns || deckState.grabbed;
    deckState.grabbed = false;
    deckState.owns = false;
    deckState.pointerId = null;
    deckState.rate = 0;
    deckState.omega = 0;
    cursorOnDisc = false;
    setCursorState(false, false);
    if (wasActive && onDeckRelease) onDeckRelease({ resume: false, settled: true });
  }

  // Runs inside the rAF loop because the visual angle and the audio rate have to
  // be one number. Decays toward a TARGET rather than to zero: releasing while
  // the track was playing hands the deck back to 1x (a real turntable keeps
  // turning), releasing while it was paused coasts to a stop.
  function advanceDeckInertia(dt) {
    const target = deckState.resume ? 1 : 0;
    const k = 1 - Math.exp(-dt / INERTIA_TAU_SECONDS);
    deckState.rate += (target - deckState.rate) * k;
    const settled = Math.abs(deckState.rate - target) < SETTLE_EPSILON;
    if (settled) deckState.rate = target;
    if (onDeckRate) onDeckRate(deckState.rate, settled);
    angle += deckState.rate * RPM_33_RAD_PER_SEC * dt;
    if (!settled) return;
    // Settled: hand the disc back. When resuming, the deck keeps sounding at 1x
    // but the angle is free-spun from here -- keeping it audio-driven would mean
    // re-deriving it every frame for no visible difference.
    deckState.owns = false;
    if (onDeckRelease) onDeckRelease({ resume: deckState.resume, settled: true });
  }

  // Ends a gesture or coast at once, snapping to whatever it was heading for.
  // Used when the rAF loop is about to stop and can no longer drive the decay.
  function finishDeckCoast() {
    if (!deckState.owns) return;
    if (deckState.pointerId !== null && canvas.hasPointerCapture(deckState.pointerId)) {
      canvas.releasePointerCapture(deckState.pointerId);
    }
    deckState.grabbed = false;
    deckState.pointerId = null;
    deckState.owns = false;
    deckState.rate = deckState.resume ? 1 : 0;
    deckState.omega = 0;
    setCursorState(false, false);
    cursorOnDisc = false;
    if (onDeckRate) onDeckRate(deckState.rate, true);
    if (onDeckRelease) onDeckRelease({ resume: deckState.resume, settled: true });
  }

  canvas.addEventListener('pointerdown', onDeckPointerDown);
  canvas.addEventListener('pointermove', onDeckPointerMove);
  canvas.addEventListener('pointermove', updateDeckCursor);
  canvas.addEventListener('pointerup', onDeckPointerUp);
  canvas.addEventListener('pointercancel', onDeckPointerUp);
  canvas.addEventListener('pointerleave', (e) => { if (!deckState.grabbed) updateDeckCursor(e); });

  function tick(now) {
    // dt is used ONLY on the deck paths, so no existing skin changes behaviour.
    // Clamped so a backgrounded tab returning cannot teleport the disc (or, far
    // worse, the audio position).
    const ms = typeof now === 'number' ? now : lastFrameMs;
    const dt = lastFrameMs ? Math.min(0.05, Math.max(0, (ms - lastFrameMs) / 1000)) : 0;
    lastFrameMs = ms;
    if (deckState.owns && !deckState.grabbed && dt > 0) advanceDeckInertia(dt);
    renderFrame();
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId !== null) return;
    resize();
    // Reset so the first frame after a stop computes dt = 0 instead of the whole
    // gap since the loop was last running.
    lastFrameMs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function applySkin() {
    const active = activeSkin !== 'video';
    container.classList.toggle('skin-active', active);
    if (active) startLoop();
    else stopLoop();
  }

  // User picking a skin from the menu: persist it AND make it active for the
  // current media (overrides the video-wins default until the next media load).
  function setSkin(next) {
    // Release before switching: the canvas is shared by every skin, so a skin
    // change mid-drag would otherwise strand the captured pointer.
    abandonDeckGesture();
    skin = SKINS.includes(next) ? next : 'video';
    activeSkin = skin;
    localStorage.setItem(STORAGE_KEY, skin);
    particles.length = 0;
    applySkin();
  }

  // Called on each central-media load. The skin belongs to the APP, not the
  // media/session: the user's chosen skin always wins. So a stored vinyl/bars
  // keeps rendering even when a video pad is triggered — the video no longer
  // hijacks the display. The default stored skin is 'video' (readStoredSkin),
  // so users who never pick a skin still see the video, unchanged. `kind` is
  // unused now but kept in the signature for the callers.
  function onMediaLoaded() {
    abandonDeckGesture();
    activeSkin = skin;
    particles.length = 0;
    applySkin();
  }

  // What's actually showing (menu reflects this).
  function getSkin() {
    return activeSkin;
  }

  // Pause the loop when the tab is hidden; resume if a skin is active.
  function onVisibility() {
    if (document.hidden) {
      // The AudioContext keeps running when a tab hides but rAF does not, so a
      // gesture or coast interrupted here would leave the rate frozen at
      // whatever it was -- the deck audibly playing at, say, -2x for as long as
      // the tab stays in the background. Land on the target immediately instead.
      finishDeckCoast();
      stopLoop();
    } else if (activeSkin !== 'video') {
      startLoop();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', () => { if (activeSkin !== 'video') resize(); });

  // Re-measure when the display box changes size without a window resize
  // (header collapse, panel toggles, sidenav swaps) so the canvas never keeps
  // a stale 1x1 / wrong-DPR backing store.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (activeSkin !== 'video') resize(); });
    ro.observe(canvas);
  }

  applySkin();

  function setSpinSpeed(mult) {
    spinSpeed = SPIN_SPEEDS.includes(mult) ? mult : 1;
    localStorage.setItem(SPIN_KEY, String(spinSpeed));
  }
  function getSpinSpeed() {
    return spinSpeed;
  }

  return { setSkin, getSkin, onMediaLoaded, resize, getSkins: () => SKINS.slice(), setSpinSpeed, getSpinSpeed };
}
