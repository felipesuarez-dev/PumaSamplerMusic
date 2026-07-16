import { formatTime } from './state.js';

export function createWaveform(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  const rulerCanvas = options.rulerCanvas;
  const rulerCtx = rulerCanvas ? rulerCanvas.getContext('2d') : null;

  let audioBuffer = null;
  let duration = 0;
  let start = 0;
  let end = 0;
  let playhead = 0;
  let isDragging = false;
  let dragTarget = null;
  let wasDragging = false;
  let isLoading = false;
  let emptyMessage = 'Select a video';

  const onChange = options.onChange || (() => {});
  const onSeek = options.onSeek || (() => {});

  function getAccentColor() {
    try {
      const styles = getComputedStyle(document.documentElement);
      return styles.getPropertyValue('--accent').trim() || '#ff9f1c';
    } catch {
      return '#ff9f1c';
    }
  }

  function getMutedColor() {
    return '#a0aab8';
  }

  function getMutedFill() {
    return 'rgba(160, 170, 184, 0.08)';
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));

    if (rulerCanvas) {
      const rulerRect = rulerCanvas.parentElement.getBoundingClientRect();
      rulerCanvas.width = Math.max(1, Math.floor(rulerRect.width * dpr));
      rulerCanvas.height = Math.max(1, Math.floor(rulerCanvas.clientHeight * dpr));
    }
    draw();
  }

  function setAudioBuffer(buffer) {
    audioBuffer = buffer;
    duration = buffer ? buffer.duration : 0;
    isLoading = false;
    draw();
  }

  function setLoading(message = 'Loading waveform...') {
    isLoading = true;
    emptyMessage = message;
    audioBuffer = null;
    duration = 0;
    draw();
  }

  function setEmpty(message = 'Select a video') {
    isLoading = false;
    audioBuffer = null;
    duration = 0;
    emptyMessage = message;
    draw();
  }

  function setSegment(startTime, endTime) {
    start = Math.max(0, startTime || 0);
    end = Math.min(duration, endTime || duration);
    if (start >= end) {
      end = Math.min(duration, start + 0.1);
    }
    draw();
  }

  function setPlayhead(time) {
    playhead = Math.max(0, Math.min(duration, time || 0));
    draw();
  }

  function getSegment() {
    return { start, end };
  }

  function timeToX(time) {
    if (!duration) return 0;
    return (time / duration) * canvas.width;
  }

  function xToTime(x) {
    if (!canvas.width) return 0;
    return (x / canvas.width) * duration;
  }

  function draw() {
    drawRuler();
    drawWaveform();
  }

  function drawWaveform() {
    const width = canvas.width;
    const height = canvas.height;
    const accent = getAccentColor();
    const yOffset = height / 2;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, width, height);

    if (!audioBuffer) {
      drawEmptyState(width, height);
      return;
    }

    const data = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(data.length / width));
    const startX = timeToX(start);
    const endX = timeToX(end);

    // Center line (subtle)
    ctx.strokeStyle = 'rgba(139, 149, 168, 0.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, yOffset);
    ctx.lineTo(width, yOffset);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform regions
    drawWaveformRegion(data, step, 0, startX, yOffset, getMutedColor(), getMutedFill());
    drawWaveformRegion(data, step, startX, endX, yOffset, accent, null);
    drawWaveformRegion(data, step, endX, width, yOffset, getMutedColor(), getMutedFill());

    // Spotlight: dim everything outside selection
    const dimColor = 'rgba(0, 0, 0, 0.45)';
    ctx.fillStyle = dimColor;
    ctx.fillRect(0, 0, startX, height);
    ctx.fillRect(endX, 0, width - endX, height);

    // Selection overlay
    const overlayGrad = ctx.createLinearGradient(0, 0, 0, height);
    overlayGrad.addColorStop(0, 'rgba(255, 159, 28, 0.10)');
    overlayGrad.addColorStop(0.5, 'rgba(255, 159, 28, 0.28)');
    overlayGrad.addColorStop(1, 'rgba(255, 159, 28, 0.10)');
    ctx.fillStyle = overlayGrad;
    ctx.fillRect(startX, 0, endX - startX, height);

    // Selection borders
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(startX, height);
    ctx.moveTo(endX, 0);
    ctx.lineTo(endX, height);
    ctx.stroke();

    // IN / OUT labels
    drawInOutLabels(startX, endX, height, accent);

    // Handles
    drawHandle(startX, height);
    drawHandle(endX, height);

    // Playhead
    drawPlayhead(timeToX(playhead), height);
  }

  function drawEmptyState(width, height) {
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = 'rgba(139, 149, 168, 0.35)';
    ctx.font = `${13 * dpr}px ui-monospace, 'SF Mono', Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (isLoading) {
      // Draw spinner arc
      const cx = width / 2;
      const cy = height / 2;
      const r = 12 * dpr;
      ctx.strokeStyle = 'rgba(255, 159, 28, 0.8)';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy - 16 * dpr, r, 0.6 * Math.PI, 1.9 * Math.PI);
      ctx.stroke();
    }

    ctx.fillText(emptyMessage, width / 2, height / 2 + (isLoading ? 12 * dpr : 0));
  }

  function drawWaveformRegion(data, step, xStart, xEnd, yOffset, color, fillColor) {
    if (xStart >= xEnd) return;

    const amp = yOffset * 0.92;
    const samples = [];
    const xMin = Math.max(0, Math.floor(xStart));
    const xMax = Math.min(canvas.width, Math.ceil(xEnd));

    for (let x = xMin; x < xMax; x += 1) {
      let min = 1;
      let max = -1;
      const offset = Math.floor(x * step);
      for (let i = 0; i < step && offset + i < data.length; i++) {
        const sample = data[offset + i] || 0;
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      const yMin = (1 + min) * amp;
      const yMax = (1 + max) * amp;
      samples.push({ x, yMin, yMax });
    }

    if (samples.length === 0) return;

    // Fill (if provided)
    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.moveTo(samples[0].x, yOffset);
      for (const s of samples) {
        ctx.lineTo(s.x, s.yMin);
      }
      for (let i = samples.length - 1; i >= 0; i--) {
        ctx.lineTo(samples[i].x, samples[i].yMax);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Stroke
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
    for (const s of samples) {
      ctx.moveTo(s.x, s.yMin);
      ctx.lineTo(s.x, s.yMax);
    }
    ctx.stroke();
  }

  function drawHandle(x, height) {
    const accent = getAccentColor();
    const dpr = window.devicePixelRatio || 1;
    const radius = 10 * dpr;
    const cy = height - radius - 8;

    // Connector line to top
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([2 * dpr, 2 * dpr]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cy - radius);
    ctx.stroke();
    ctx.setLineDash([]);

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.arc(x + 1, cy + 1, radius, 0, Math.PI * 2);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(x, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Fill
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayhead(x, height) {
    const dpr = window.devicePixelRatio || 1;
    const headHeight = 12 * dpr;
    const halfWidth = 7 * dpr;
    const lineWidth = 2.5 * dpr;

    // Glow line
    ctx.shadowColor = 'rgba(239, 68, 68, 0.65)';
    ctx.shadowBlur = 8 * dpr;

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, headHeight);
    ctx.lineTo(x, height);
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Triangle at top
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - halfWidth, headHeight);
    ctx.lineTo(x + halfWidth, headHeight);
    ctx.closePath();
    ctx.fill();
  }

  function drawInOutLabels(startX, endX, height, accent) {
    const dpr = window.devicePixelRatio || 1;
    const fontSize = 10 * dpr;
    ctx.font = `700 ${fontSize}px ui-monospace, 'SF Mono', Menlo, monospace`;
    ctx.textBaseline = 'top';

    const pad = 6 * dpr;
    const top = 6 * dpr;
    const labelHeight = fontSize + 4 * dpr;

    function drawLabel(text, time, x, align) {
      const timeText = formatTime(time);
      const w1 = ctx.measureText(text).width;
      const w2 = ctx.measureText(timeText).width;
      const maxW = Math.max(w1, w2);
      const boxW = maxW + pad * 2;
      const boxH = labelHeight * 2 + 2 * dpr;
      let boxX = align === 'left' ? x + pad : x - boxW - pad;
      if (boxX < 0) boxX = 0;
      if (boxX + boxW > canvas.width) boxX = canvas.width - boxW;

      ctx.fillStyle = 'rgba(10, 12, 16, 0.9)';
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.roundRect(boxX, top, boxW, boxH, 4 * dpr);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.fillText(text, boxX + boxW / 2, top + 2 * dpr);
      ctx.fillStyle = 'rgba(232, 236, 241, 0.9)';
      ctx.fillText(timeText, boxX + boxW / 2, top + labelHeight + 1 * dpr);
    }

    drawLabel('IN', start, startX, 'left');
    drawLabel('OUT', end, endX, 'right');
  }

  function drawRuler() {
    if (!rulerCtx || !rulerCanvas) return;

    const width = rulerCanvas.width;
    const height = rulerCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    rulerCtx.clearRect(0, 0, width, height);
    rulerCtx.fillStyle = '#0a0c10';
    rulerCtx.fillRect(0, 0, width, height);

    if (!duration) return;

    const fontSize = 10 * dpr;
    rulerCtx.font = `${fontSize}px ui-monospace, 'SF Mono', Menlo, monospace`;
    rulerCtx.textAlign = 'center';
    rulerCtx.textBaseline = 'top';
    rulerCtx.fillStyle = 'rgba(139, 149, 168, 0.9)';
    rulerCtx.strokeStyle = 'rgba(139, 149, 168, 0.25)';
    rulerCtx.lineWidth = 1;

    const intervals = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    let majorInterval = 1;
    for (const candidate of intervals) {
      const label = formatTime(candidate);
      const measuredWidth = rulerCtx.measureText(label).width;
      const pixelWidth = (candidate / duration) * width;
      if (pixelWidth >= measuredWidth * 1.8) {
        majorInterval = candidate;
        break;
      }
    }

    // Minor ticks = major / 4
    const minorInterval = majorInterval / 4;

    for (let t = 0; t <= duration + 0.0001; t += minorInterval) {
      const clamped = Math.min(t, duration);
      const x = timeToX(clamped);
      const isMajor = Math.abs(clamped % majorInterval) < minorInterval / 2 || clamped === 0;
      const tickTop = isMajor ? 0 : Math.round(height * 0.45);

      rulerCtx.beginPath();
      rulerCtx.moveTo(x, tickTop);
      rulerCtx.lineTo(x, height - 2);
      rulerCtx.stroke();

      if (isMajor) {
        const label = formatTime(clamped);
        const textWidth = rulerCtx.measureText(label).width;
        rulerCtx.fillStyle = 'rgba(10, 12, 16, 0.85)';
        rulerCtx.fillRect(x - textWidth / 2 - 3, 2, textWidth + 6, fontSize + 3);
        rulerCtx.fillStyle = 'rgba(232, 236, 241, 0.9)';
        rulerCtx.fillText(label, x, 3);
      }
    }

    // Bottom border
    rulerCtx.strokeStyle = 'rgba(139, 149, 168, 0.15)';
    rulerCtx.beginPath();
    rulerCtx.moveTo(0, height - 0.5);
    rulerCtx.lineTo(width, height - 0.5);
    rulerCtx.stroke();
  }

  function getDragTarget(x) {
    const startX = timeToX(start);
    const endX = timeToX(end);
    const playheadX = timeToX(playhead);
    const handleRadius = 14 * (window.devicePixelRatio || 1);
    const playheadRadius = 10 * (window.devicePixelRatio || 1);

    const startDist = Math.abs(x - startX);
    const endDist = Math.abs(x - endX);
    const playheadDist = Math.abs(x - playheadX);

    if (playheadDist < playheadRadius && playheadDist < startDist && playheadDist < endDist) return 'playhead';
    if (startDist < handleRadius && startDist < endDist) return 'start';
    if (endDist < handleRadius && endDist < startDist) return 'end';
    if (x > startX && x < endX) return 'segment';
    return null;
  }

  function updateCursor(e) {
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const target = getDragTarget(x);
    if (target === 'start' || target === 'end' || target === 'playhead') {
      canvas.style.cursor = 'ew-resize';
    } else if (target === 'segment') {
      canvas.style.cursor = 'grab';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  canvas.addEventListener('mousemove', updateCursor);

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    dragTarget = getDragTarget(x);
    if (dragTarget) {
      isDragging = true;
      wasDragging = false;
      e.preventDefault();
    }
  });

  canvas.addEventListener('click', (e) => {
    if (wasDragging) {
      wasDragging = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const time = xToTime(x);
    onSeek(time);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const time = Math.max(0, Math.min(duration, xToTime(x)));

    if (dragTarget === 'start') {
      start = Math.min(time, end - 0.05);
    } else if (dragTarget === 'end') {
      end = Math.max(time, start + 0.05);
    } else if (dragTarget === 'segment') {
      const segmentDuration = end - start;
      const newStart = Math.max(0, Math.min(duration - segmentDuration, time - segmentDuration / 2));
      start = newStart;
      end = newStart + segmentDuration;
    } else if (dragTarget === 'playhead') {
      playhead = time;
      onSeek(time);
    }

    wasDragging = true;
    draw();
    if (dragTarget !== 'playhead') {
      onChange({ start, end });
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      wasDragging = true;
    }
    isDragging = false;
    dragTarget = null;
  });

  window.addEventListener('resize', resize);
  resize();

  return {
    setAudioBuffer,
    setLoading,
    setEmpty,
    setSegment,
    setPlayhead,
    getSegment,
    draw,
    resize,
  };
}
