import { formatTime } from './state.js';

export function createWaveform(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  let audioBuffer = null;
  let duration = 0;
  let start = 0;
  let end = 0;
  let playhead = 0;
  let isDragging = false;
  let dragTarget = null;
  let wasDragging = false;

  const onChange = options.onChange || (() => {});
  const onSeek = options.onSeek || (() => {});

  function getAccentColor() {
    try {
      const styles = getComputedStyle(document.documentElement);
      const value = styles.getPropertyValue('--accent').trim();
      return value || '#ff9f1c';
    } catch {
      return '#ff9f1c';
    }
  }

  function getMutedColor() {
    return '#4a5568';
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    draw();
  }

  function setAudioBuffer(buffer) {
    audioBuffer = buffer;
    duration = buffer ? buffer.duration : 0;
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
    const width = canvas.width;
    const height = canvas.height;
    const accent = getAccentColor();
    const yOffset = height / 2;

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

    // Draw time ruler
    drawTimeRuler();

    // Draw center line (dashed)
    ctx.strokeStyle = 'rgba(139, 149, 168, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2 * window.devicePixelRatio, 4 * window.devicePixelRatio]);
    ctx.beginPath();
    ctx.moveTo(0, yOffset);
    ctx.lineTo(width, yOffset);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw waveform
    drawWaveformRegion(data, step, 0, startX, yOffset, getMutedColor(), false);
    drawWaveformRegion(data, step, startX, endX, yOffset, accent, true);
    drawWaveformRegion(data, step, endX, width, yOffset, getMutedColor(), false);

    // Selection overlay
    const overlayGrad = ctx.createLinearGradient(0, 0, 0, height);
    overlayGrad.addColorStop(0, 'rgba(255, 159, 28, 0.04)');
    overlayGrad.addColorStop(0.5, 'rgba(255, 159, 28, 0.18)');
    overlayGrad.addColorStop(1, 'rgba(255, 159, 28, 0.04)');
    ctx.fillStyle = overlayGrad;
    ctx.fillRect(startX, 0, endX - startX, height);

    // Selection borders
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * window.devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(startX, height);
    ctx.moveTo(endX, 0);
    ctx.lineTo(endX, height);
    ctx.stroke();

    // Draw handles
    drawHandle(startX, height);
    drawHandle(endX, height);

    // Draw playhead
    drawPlayhead(timeToX(playhead), height);
  }

  function drawEmptyState(width, height) {
    ctx.fillStyle = 'rgba(139, 149, 168, 0.3)';
    ctx.font = `${12 * window.devicePixelRatio}px ui-monospace, 'SF Mono', Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No audio loaded', width / 2, height / 2);
  }

  function drawWaveformRegion(data, step, xStart, xEnd, yOffset, color, isSelected) {
    if (xStart >= xEnd) return;

    const amp = yOffset;
    const samples = [];
    const xMin = Math.max(0, Math.floor(xStart));
    const xMax = Math.min(canvas.width, Math.ceil(xEnd));

    for (let x = xMin; x < xMax; x += 2) {
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

    // Stroke
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * window.devicePixelRatio;
    for (const s of samples) {
      ctx.moveTo(s.x, s.yMin);
      ctx.lineTo(s.x, s.yMax);
    }
    ctx.stroke();

    // Gradient fill
    if (isSelected) {
      const fillGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      fillGrad.addColorStop(0, `${color}33`);
      fillGrad.addColorStop(0.5, `${color}66`);
      fillGrad.addColorStop(1, `${color}33`);
      ctx.fillStyle = fillGrad;
      ctx.beginPath();
      if (samples.length > 0) {
        ctx.moveTo(samples[0].x, yOffset);
        for (const s of samples) {
          ctx.lineTo(s.x, s.yMin);
        }
        for (let i = samples.length - 1; i >= 0; i--) {
          ctx.lineTo(samples[i].x, samples[i].yMax);
        }
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  function drawHandle(x, height) {
    const accent = getAccentColor();
    const radius = 7 * window.devicePixelRatio;
    const cy = height - radius - 4;

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.arc(x + 1, cy + 1, radius, 0, Math.PI * 2);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2 * window.devicePixelRatio;
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
    const headHeight = 8 * window.devicePixelRatio;
    const halfWidth = 5 * window.devicePixelRatio;

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2 * window.devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(x, headHeight);
    ctx.lineTo(x, height);
    ctx.stroke();

    // Triangle at top
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - halfWidth, headHeight);
    ctx.lineTo(x + halfWidth, headHeight);
    ctx.closePath();
    ctx.fill();
  }

  function drawTimeRuler() {
    if (!duration) return;

    const width = canvas.width;
    const height = canvas.height;
    const fontSize = 10 * window.devicePixelRatio;
    const intervals = [0.1, 0.5, 1, 5, 10, 30, 60, 300, 600, 1800, 3600];

    ctx.font = `${fontSize}px ui-monospace, 'SF Mono', Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let interval = 1;
    for (const candidate of intervals) {
      const label = formatTime(candidate);
      const measuredWidth = ctx.measureText(label).width;
      const x1 = timeToX(0);
      const x2 = timeToX(candidate);
      const pixelWidth = Math.abs(x2 - x1);
      if (pixelWidth >= measuredWidth * 1.6) {
        interval = candidate;
        break;
      }
    }

    ctx.strokeStyle = 'rgba(139, 149, 168, 0.12)';
    ctx.lineWidth = 1;

    for (let t = 0; t <= duration + 0.0001; t += interval) {
      const x = timeToX(Math.min(t, duration));
      const major = Math.abs(t % 60) < 0.01 || t === 0;
      const tickTop = major ? 0 : Math.round(height * 0.05);

      ctx.beginPath();
      ctx.moveTo(x, tickTop);
      ctx.lineTo(x, height);
      ctx.stroke();

      const label = formatTime(t);
      const textWidth = ctx.measureText(label).width;

      // Label background
      ctx.fillStyle = 'rgba(10, 12, 16, 0.85)';
      ctx.fillRect(x - textWidth / 2 - 3, 2, textWidth + 6, fontSize + 3);

      ctx.fillStyle = 'rgba(139, 149, 168, 0.85)';
      ctx.fillText(label, x, 3);
    }
  }

  function getDragTarget(x) {
    const startX = timeToX(start);
    const endX = timeToX(end);
    const startDist = Math.abs(x - startX);
    const endDist = Math.abs(x - endX);
    const handleRadius = 12 * window.devicePixelRatio;

    if (startDist < handleRadius && startDist < endDist) return 'start';
    if (endDist < handleRadius && endDist < startDist) return 'end';
    if (x > startX && x < endX) return 'segment';
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * window.devicePixelRatio;
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
    const x = (e.clientX - rect.left) * window.devicePixelRatio;
    const time = xToTime(x);
    onSeek(time);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * window.devicePixelRatio;
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
    }

    wasDragging = true;
    draw();
    onChange({ start, end });
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
    setSegment,
    setPlayhead,
    getSegment,
    draw,
  };
}
