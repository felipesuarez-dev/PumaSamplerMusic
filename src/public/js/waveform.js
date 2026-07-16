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

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, width, height);

    if (!audioBuffer) return;

    const data = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(data.length / width));
    const amp = height / 2;
    const yOffset = amp;

    // Draw time ruler
    drawTimeRuler();

    // Draw center line
    ctx.strokeStyle = 'rgba(139, 149, 168, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yOffset);
    ctx.lineTo(width, yOffset);
    ctx.stroke();

    // Draw waveform
    ctx.beginPath();
    ctx.strokeStyle = '#8b95a8';
    ctx.lineWidth = 1;

    for (let x = 0; x < width; x += 2) {
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
      ctx.moveTo(x, yMin);
      ctx.lineTo(x, yMax);
    }
    ctx.stroke();

    // Draw selection overlay
    const startX = timeToX(start);
    const endX = timeToX(end);
    ctx.fillStyle = 'rgba(255, 159, 28, 0.2)';
    ctx.fillRect(startX, 0, endX - startX, height);

    // Draw selection borders
    ctx.strokeStyle = getAccentColor();
    ctx.lineWidth = 2;
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
    const playheadX = timeToX(playhead);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }

  function drawHandle(x, height) {
    ctx.fillStyle = getAccentColor();
    ctx.beginPath();
    ctx.arc(x, height - 8, 6, 0, Math.PI * 2);
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
      if (pixelWidth >= measuredWidth * 1.5) {
        interval = candidate;
        break;
      }
    }

    ctx.fillStyle = 'rgba(139, 149, 168, 0.65)';
    ctx.strokeStyle = 'rgba(139, 149, 168, 0.12)';
    ctx.lineWidth = 1;

    for (let t = 0; t <= duration + 0.0001; t += interval) {
      const x = timeToX(Math.min(t, duration));
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(formatTime(t), x, 2);
    }
  }

  function getDragTarget(x) {
    const startX = timeToX(start);
    const endX = timeToX(end);
    const startDist = Math.abs(x - startX);
    const endDist = Math.abs(x - endX);
    const handleRadius = 10 * window.devicePixelRatio;

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
      e.preventDefault();
    }
  });

  canvas.addEventListener('click', (e) => {
    if (isDragging) return;
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

    draw();
    onChange({ start, end });
  });

  window.addEventListener('mouseup', () => {
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
