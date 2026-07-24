// Central-display "skins": alternative visuals shown over the <video>/waveform
// surface when the user would rather not watch the video. All audio-reactive
// skins read from the audio engine's shared AnalyserNode (post-limiter tap);
// the vinyl skin only uses it to detect activity for its spin speed. The module
// owns a single overlay canvas, its own requestAnimationFrame loop, and the
// persisted skin choice. It never touches audio routing or the video element.

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

export function createVisualizerSkins({ container, canvas, getAnalyser, getMediaTitle }) {
  const ctx = canvas.getContext('2d');
  let skin = readStoredSkin();
  let rafId = null;
  let angle = 0; // vinyl rotation, radians
  const particles = []; // bubbles state

  // Reused analysis buffers, sized on first use from the live analyser.
  let freqData = null;
  let timeData = null;

  function accent() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff9f1c';
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
  }

  function ensureBuffers(analyser) {
    if (!freqData || freqData.length !== analyser.frequencyBinCount) {
      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
    }
  }

  // Rough loudness 0..1 from frequency data, used to speed up the vinyl and
  // energize the bubbles. Returns 0 when there's no analyser/signal yet.
  function loudness() {
    const analyser = getAnalyser();
    if (!analyser) return 0;
    ensureBuffers(analyser);
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    for (let i = 0; i < freqData.length; i++) sum += freqData[i];
    return sum / (freqData.length * 255);
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
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 128 - 1; // -1..1
        const y = h / 2 + (v * h) / 2.4;
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
    // Spawn a few bubbles proportional to loudness, capped so it never floods.
    if (level > 0.04 && particles.length < 80) {
      const n = Math.round(level * 4);
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

  function drawVinyl() {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    clear();
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.4;

    // A record always turns; it just turns faster while audio is playing.
    angle += 0.01 + loudness() * 0.12;

    // Disc body
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#15171d';
    ctx.fill();

    // Grooves
    ctx.strokeStyle = 'rgba(139, 149, 168, 0.18)';
    ctx.lineWidth = 1 * dpr;
    for (let r = radius * 0.35; r < radius; r += 6 * dpr) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // A rotating highlight mark so the spin is visible even on a plain disc.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(radius * 0.34, 0);
    ctx.lineTo(radius * 0.98, 0);
    ctx.stroke();
    ctx.restore();

    // Center label
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = accent();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0c10';
    ctx.fill();

    // Track title under the disc
    const title = (getMediaTitle && getMediaTitle()) || '';
    if (title) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${13 * dpr}px ui-monospace, 'SF Mono', Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const maxLen = 42;
      const shown = title.length > maxLen ? `${title.slice(0, maxLen - 1)}…` : title;
      ctx.fillText(shown, cx, cy + radius + 10 * dpr);
    }
  }

  function renderFrame() {
    switch (skin) {
      case 'waveform': drawWaveform(); break;
      case 'bars': drawBars(); break;
      case 'bubbles': drawBubbles(); break;
      case 'vinyl': drawVinyl(); break;
      default: break;
    }
  }

  function tick() {
    renderFrame();
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId !== null) return;
    resize();
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function applySkin() {
    const active = skin !== 'video';
    container.classList.toggle('skin-active', active);
    if (active) startLoop();
    else stopLoop();
  }

  function setSkin(next) {
    skin = SKINS.includes(next) ? next : 'video';
    localStorage.setItem(STORAGE_KEY, skin);
    particles.length = 0;
    applySkin();
  }

  function getSkin() {
    return skin;
  }

  // Pause the loop when the tab is hidden; resume if a skin is active.
  function onVisibility() {
    if (document.hidden) stopLoop();
    else if (skin !== 'video') startLoop();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', () => { if (skin !== 'video') resize(); });

  // Re-measure when the display box changes size without a window resize
  // (header collapse, panel toggles, sidenav swaps) so the canvas never keeps
  // a stale 1x1 / wrong-DPR backing store.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (skin !== 'video') resize(); });
    ro.observe(canvas);
  }

  applySkin();

  return { setSkin, getSkin, resize, getSkins: () => SKINS.slice() };
}
