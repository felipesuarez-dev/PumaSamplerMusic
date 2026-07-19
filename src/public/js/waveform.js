import { formatTime } from './state.js';
import { t } from './i18n.js';
import { buildPeakCache as buildPeakCacheFromSamples, selectLevel as selectPeakLevel } from './waveform-peaks.js';
import { MIN_SLICE_SECONDS } from './slicer-core.js';

// Deferral window between a single click's audition and it being cancelled
// by a following dblclick (see onClick/onDblClick).
const CLICK_DEFER_MS = 250;

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
  let emptyMessage = t('waveform.selectVideo');

  // Per-instance multi-level cache of precomputed min/max peaks for the
  // currently loaded audio buffer: { levels: [{bucketSize, mins, maxs}] },
  // coarsest level first. Avoids rescanning the raw Float32Array on every
  // draw() call (e.g. on every mousemove while dragging a handle), and
  // avoids the coarsest-only cache dragging draw work down to a fixed
  // resolution regardless of zoom. Scoped to this closure so multiple
  // concurrent waveform instances (e.g. pad editor + slicer) each own their
  // cache instead of clobbering a shared one. Built once per buffer, no
  // invalidation (memory stays bounded regardless of source duration).
  let peakCache = null;

  function buildPeakCache(buffer) {
    const data = buffer.getChannelData(0);
    peakCache = buildPeakCacheFromSamples(data);
  }

  // Slice markers (times in seconds) drawn on top of the waveform, e.g. for
  // the auto-slicer view. Stored as a private copy so external mutation of
  // the array passed to setMarkers() can't desync the drawn state.
  let markers = Array.isArray(options.markers) ? options.markers.slice() : [];

  // When false, the start/end selection UI (dim overlay, gradient, borders,
  // IN/OUT labels, handles) and its hit-testing are disabled entirely. Used
  // by views that only need waveform + markers, no start/end selection.
  const selectionEnabled = options.selectionEnabled !== false;

  // Opt-in marker drag/add/delete interactivity, off by default so every
  // existing consumer (the pad editor's Trim tab) is completely unaffected.
  // The auto-slicer is the only caller that turns this on.
  const markersEditable = options.markersEditable === true;
  const markerMinGapSeconds = options.markerMinGapSeconds != null ? options.markerMinGapSeconds : MIN_SLICE_SECONDS;
  let markerDragIndex = null;
  let markerDidMove = false;
  let clickTimer = null;

  let zoomLevel = 1;
  let zoomCenter = 0;
  let panPrevX = 0;
  let panStartX = 0;
  const PAN_THRESHOLD = 3 * (window.devicePixelRatio || 1);

  const onChange = options.onChange || (() => {});
  const onSeek = options.onSeek || (() => {});
  const onZoom = options.onZoom || (() => {});
  const onMarkerChange = options.onMarkerChange || (() => {});
  const onMarkerAdd = options.onMarkerAdd || (() => {});
  const onMarkerDelete = options.onMarkerDelete || (() => {});
  const onWaveformClick = options.onWaveformClick || null;

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

  function getMarkerColor() {
    try {
      const styles = getComputedStyle(document.documentElement);
      return styles.getPropertyValue('--success').trim() || '#4ade80';
    } catch {
      return '#4ade80';
    }
  }

  function getVisibleRange() {
    const visibleDuration = duration / zoomLevel;
    let visibleStart = zoomCenter - visibleDuration / 2;
    let visibleEnd = visibleStart + visibleDuration;
    if (visibleStart < 0) {
      visibleStart = 0;
      visibleEnd = visibleDuration;
    }
    if (visibleEnd > duration) {
      visibleEnd = duration;
      visibleStart = Math.max(0, duration - visibleDuration);
    }
    return { visibleStart, visibleEnd, visibleDuration };
  }

  function clampZoom() {
    if (!duration) {
      zoomLevel = 1;
      zoomCenter = 0;
      return;
    }
    const minVisible = 0.05;
    const maxZoom = Math.max(1, duration / minVisible);
    zoomLevel = Math.max(1, Math.min(zoomLevel, maxZoom));
    const { visibleDuration, visibleStart } = getVisibleRange();
    zoomCenter = visibleStart + visibleDuration / 2;
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
    zoomLevel = 1;
    zoomCenter = duration / 2;
    clampZoom();
    isLoading = false;
    peakCache = null;
    if (buffer) buildPeakCache(buffer);
    draw();
  }

  function setLoading(message = t('waveform.loading')) {
    isLoading = true;
    emptyMessage = message;
    audioBuffer = null;
    duration = 0;
    zoomLevel = 1;
    zoomCenter = 0;
    peakCache = null;
    draw();
  }

  function setEmpty(message = t('waveform.selectVideo')) {
    isLoading = false;
    audioBuffer = null;
    duration = 0;
    zoomLevel = 1;
    zoomCenter = 0;
    emptyMessage = message;
    peakCache = null;
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

  function setMarkers(times) {
    markers = Array.isArray(times) ? times.slice() : [];
    draw();
  }

  function getSegment() {
    return { start, end };
  }

  function getZoomLevel() {
    return zoomLevel;
  }

  function timeToX(time) {
    if (!duration) return 0;
    const { visibleStart, visibleDuration } = getVisibleRange();
    return ((time - visibleStart) / visibleDuration) * canvas.width;
  }

  function xToTime(x) {
    if (!canvas.width) return 0;
    const { visibleStart, visibleDuration } = getVisibleRange();
    return visibleStart + (x / canvas.width) * visibleDuration;
  }

  function zoomAt(x, factor) {
    if (!duration) return;
    const time = xToTime(x);
    let newZoom = zoomLevel * factor;
    if (newZoom < 1) newZoom = 1;
    zoomLevel = newZoom;
    clampZoom();

    // Keep the time under the cursor at the same x position.
    const { visibleDuration } = getVisibleRange();
    const visibleStart = time - (x / canvas.width) * visibleDuration;
    zoomCenter = Math.max(visibleDuration / 2, Math.min(duration - visibleDuration / 2, visibleStart + visibleDuration / 2));
    clampZoom();
    draw();
    onZoom(zoomLevel);
  }

  function zoomInAt(x) {
    zoomAt(x, 1.25);
  }

  function zoomOutAt(x) {
    zoomAt(x, 0.8);
  }

  function zoomReset() {
    zoomLevel = 1;
    zoomCenter = duration / 2;
    clampZoom();
    draw();
    onZoom(zoomLevel);
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

    const { visibleDuration } = getVisibleRange();
    const data = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.ceil((data.length * visibleDuration) / (duration * width)));
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
    if (selectionEnabled) {
      drawWaveformRegion(data, step, 0, startX, yOffset, getMutedColor(), getMutedFill());
      drawWaveformRegion(data, step, startX, endX, yOffset, accent, null);
      drawWaveformRegion(data, step, endX, width, yOffset, getMutedColor(), getMutedFill());
    } else {
      drawWaveformRegion(data, step, 0, width, yOffset, accent, null);
    }

    if (selectionEnabled) {
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
    }

    // Slice markers (drawn after the waveform/selection layers so they stay visible)
    drawMarkers(height);

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

    const { visibleStart } = getVisibleRange();
    const sampleOffset = Math.floor((visibleStart / duration) * data.length);
    // Coarsest level that still resolves at/finer than `step` (samples per
    // pixel) maximizes work saved without under-resolving the draw.
    const level = selectPeakLevel(peakCache, step);
    const useCache = !!level;
    const numBuckets = useCache ? level.mins.length : 0;

    for (let x = xMin; x < xMax; x += 1) {
      let min = 1;
      let max = -1;
      const offset = sampleOffset + Math.floor(x * step);

      if (useCache) {
        let bucketStart = Math.floor(offset / level.bucketSize);
        let bucketEnd = Math.ceil((offset + step) / level.bucketSize);
        bucketStart = Math.max(0, Math.min(bucketStart, numBuckets - 1));
        bucketEnd = Math.max(bucketStart + 1, Math.min(bucketEnd, numBuckets));
        for (let b = bucketStart; b < bucketEnd; b++) {
          if (level.mins[b] < min) min = level.mins[b];
          if (level.maxs[b] > max) max = level.maxs[b];
        }
      } else {
        for (let i = 0; i < step && offset + i < data.length; i++) {
          const sample = data[offset + i] || 0;
          if (sample < min) min = sample;
          if (sample > max) max = sample;
        }
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

    if (x < -radius || x > canvas.width + radius) return;

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
    if (x < -20 || x > canvas.width + 20) {
      drawOffscreenIndicator(x < 0 ? 'left' : 'right', height);
      return;
    }

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

  function drawOffscreenIndicator(side, height) {
    const dpr = window.devicePixelRatio || 1;
    const cy = height / 2;
    const size = 8 * dpr;
    const pad = 4 * dpr;
    const xTip = side === 'left' ? pad : canvas.width - pad;
    const dir = side === 'left' ? 1 : -1;

    ctx.fillStyle = '#ef4444';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(xTip, cy);
    ctx.lineTo(xTip + dir * size, cy - size);
    ctx.lineTo(xTip + dir * size, cy + size);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
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

  function drawMarkers(height) {
    if (!markers.length) return;

    const { visibleStart, visibleEnd } = getVisibleRange();
    const dpr = window.devicePixelRatio || 1;
    const color = getMarkerColor();
    const capHalfWidth = 4 * dpr;
    const capHeight = 6 * dpr;

    for (const time of markers) {
      if (time < visibleStart || time > visibleEnd) continue;
      const x = timeToX(time);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Small triangular cap at the top, in the same restrained style as the playhead.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - capHalfWidth, capHeight);
      ctx.lineTo(x + capHalfWidth, capHeight);
      ctx.closePath();
      ctx.fill();
    }
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

    const { visibleStart, visibleEnd, visibleDuration } = getVisibleRange();

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
      const pixelWidth = (candidate / visibleDuration) * width;
      if (pixelWidth >= measuredWidth * 1.8) {
        majorInterval = candidate;
        break;
      }
    }

    // Minor ticks = major / 4
    const minorInterval = majorInterval / 4;
    const startTick = Math.floor(visibleStart / minorInterval) * minorInterval;

    for (let t = startTick; t <= visibleEnd + minorInterval / 2; t += minorInterval) {
      const clamped = Math.max(0, Math.min(t, duration));
      if (clamped < visibleStart - minorInterval / 2 || clamped > visibleEnd + minorInterval / 2) continue;
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

  // Nearest interior marker (skips the fixed 0/duration ends, which aren't
  // draggable/deletable) within an ~8px CSS-pixel hit radius, DPR-aware like
  // the other hit-test radii in this file. Nearest-wins so dense marker
  // grids resolve deterministically. Returns null when markers aren't
  // editable or none qualify.
  function findMarkerHit(x) {
    if (!markersEditable) return null;
    const dpr = window.devicePixelRatio || 1;
    const hitRadius = 8 * dpr;
    let bestIndex = null;
    let bestDist = Infinity;
    for (let i = 1; i < markers.length - 1; i++) {
      const dist = Math.abs(x - timeToX(markers[i]));
      if (dist < hitRadius && dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    return bestIndex === null ? null : { index: bestIndex, dist: bestDist };
  }

  function getDragTarget(x) {
    markerDragIndex = null;
    const playheadX = timeToX(playhead);
    const playheadRadius = 10 * (window.devicePixelRatio || 1);
    const playheadDist = Math.abs(x - playheadX);
    const playheadHit = playheadDist < playheadRadius;

    // Markers win over the playhead only when strictly closer — this must
    // run before the `!selectionEnabled` early return below (the slicer,
    // the only markersEditable consumer, always sets selectionEnabled:
    // false) and before pan-candidate promotion in onMouseDown.
    const markerHit = findMarkerHit(x);
    if (markerHit && (!playheadHit || markerHit.dist < playheadDist)) {
      markerDragIndex = markerHit.index;
      return 'marker';
    }

    if (!selectionEnabled) {
      // No start/end selection to hit-test — only the playhead handle is
      // draggable; everything else (pan, seek) is handled by the caller.
      return playheadHit ? 'playhead' : null;
    }

    const startX = timeToX(start);
    const endX = timeToX(end);
    const handleRadius = 14 * (window.devicePixelRatio || 1);

    const startDist = Math.abs(x - startX);
    const endDist = Math.abs(x - endX);

    if (playheadDist < playheadRadius && playheadDist < startDist && playheadDist < endDist) return 'playhead';
    if (startDist < handleRadius && startDist < endDist) return 'start';
    if (endDist < handleRadius && endDist < startDist) return 'end';

    // Solo tratar el clic como "mover selección completa" cuando AMBOS
    // bordes están visibles en el canvas — si el zoom actual no alcanza a
    // mostrar dónde empieza o termina la selección (el caso típico apenas
    // se hace zoom, ya que la selección por defecto es el clip entero), el
    // clic debe pasar a pan en vez de intentar mover una selección que no
    // se puede ver ni mover de forma coherente.
    const bothEdgesVisible = startX >= 0 && startX <= canvas.width && endX >= 0 && endX <= canvas.width;
    if (bothEdgesVisible && x > startX && x < endX) return 'segment';
    return null;
  }

  function updateCursor(e) {
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const target = getDragTarget(x);
    if (target === 'start' || target === 'end' || target === 'playhead' || target === 'marker') {
      canvas.style.cursor = 'ew-resize';
    } else if (target === 'segment') {
      canvas.style.cursor = 'grab';
    } else if (zoomLevel > 1) {
      canvas.style.cursor = 'grab';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  function destroy() {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('mousemove', updateCursor);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('contextmenu', onContextMenu);
    clearTimeout(clickTimer);
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);

    if (dragTarget === 'pan-candidate') {
      if (Math.abs(x - panStartX) > PAN_THRESHOLD) {
        dragTarget = 'pan';
      } else {
        return;
      }
    }

    if (dragTarget === 'pan') {
      const { visibleDuration } = getVisibleRange();
      const dx = panPrevX - x;
      const dTime = (dx / canvas.width) * visibleDuration;
      zoomCenter = Math.max(0, Math.min(duration, zoomCenter + dTime));
      clampZoom();
      panPrevX = x;
      wasDragging = true;
      draw();
      return;
    }

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
    } else if (dragTarget === 'marker') {
      const idx = markerDragIndex;
      if (idx !== null) {
        const left = markers[idx - 1];
        const right = markers[idx + 1];
        // Mirror moveBoundary's no-op guard: if the neighbors are already
        // closer together than 2*minGap, the clamp range would be inverted
        // -- leave the marker where it is instead of teleporting it past a
        // neighbor.
        if (right - left >= 2 * markerMinGapSeconds) {
          markers[idx] = Math.min(right - markerMinGapSeconds, Math.max(left + markerMinGapSeconds, time));
        }
        markerDidMove = true;
      }
    }

    wasDragging = true;
    draw();
    if (dragTarget !== 'playhead' && dragTarget !== 'marker') {
      onChange({ start, end });
    }
  }

  function onMouseUp() {
    if (isDragging && dragTarget !== 'pan-candidate') {
      wasDragging = true;
    }
    // Commit once, only if the marker actually moved during this drag (a
    // plain click-without-movement on a marker must not re-trigger the
    // snap/clamp/re-render pipeline in the caller).
    if (isDragging && dragTarget === 'marker' && markerDragIndex !== null && markerDidMove) {
      onMarkerChange(markerDragIndex, markers[markerDragIndex]);
    }
    isDragging = false;
    dragTarget = null;
    markerDragIndex = null;
    markerDidMove = false;
    panPrevX = 0;
    panStartX = 0;
  }

  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    if (e.deltaY < 0) {
      zoomInAt(x);
    } else {
      zoomOutAt(x);
    }
  }

  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    dragTarget = getDragTarget(x);
    if (!dragTarget && zoomLevel > 1) {
      dragTarget = 'pan-candidate';
      panStartX = x;
      panPrevX = x;
      isDragging = true;
      wasDragging = false;
      e.preventDefault();
      return;
    }
    if (dragTarget) {
      isDragging = true;
      wasDragging = false;
      e.preventDefault();
    }
  }

  function onClick(e) {
    if (wasDragging) {
      wasDragging = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const time = xToTime(x);

    if (markersEditable && onWaveformClick) {
      // The second click of a dblclick sequence has e.detail === 2 --
      // ignore it so onDblClick below is the sole owner of that gesture.
      if (e.detail > 1) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => onWaveformClick(time), CLICK_DEFER_MS);
      return;
    }

    // Not markersEditable (e.g. the pad editor's Trim tab): identical to
    // the original, non-deferred click-to-seek behavior.
    onSeek(time);
  }

  function onDblClick(e) {
    if (!markersEditable) return;
    e.preventDefault();
    clearTimeout(clickTimer);
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    onMarkerAdd(xToTime(x));
  }

  function onContextMenu(e) {
    if (!markersEditable) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    const hit = findMarkerHit(x);
    if (!hit) return;
    // Only preventDefault (suppress the native menu) when an interior
    // marker was actually hit -- elsewhere, and always when not editable,
    // the native context menu stays untouched.
    e.preventDefault();
    onMarkerDelete(hit.index);
  }

  canvas.addEventListener('mousemove', updateCursor);
  canvas.addEventListener('wheel', onWheel);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('resize', resize);
  resize();

  return {
    setAudioBuffer,
    setLoading,
    setEmpty,
    setSegment,
    setPlayhead,
    setMarkers,
    getSegment,
    getZoomLevel,
    zoomIn: () => zoomInAt(canvas.width / 2),
    zoomOut: () => zoomOutAt(canvas.width / 2),
    zoomReset,
    draw,
    resize,
    destroy,
  };
}
