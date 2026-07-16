import { api } from './api.js';
import { createStore, buildKeyCombo, formatTime, parseTime } from './state.js';
import { createWebSocketClient } from './ws-client.js';
import { createAudioEngine } from './audio-engine.js';
import { createVideoDisplay } from './video-display.js';
import { createPads } from './pads.js';
import { createWaveform } from './waveform.js';
import { createSessionManager } from './session.js';

const store = createStore({
  videos: [],
  activeDownloads: [],
  selectedPosition: null,
  currentPad: null,
});

const ws = createWebSocketClient();
const audio = createAudioEngine();
const videoDisplay = createVideoDisplay(document.getElementById('video-player'));
const toastEl = document.getElementById('toast');
let editorWaveform = null;
let editorPreviewVideo = null;

const STOP_KEY_STORAGE = 'puma-stop-key';
let stopKey = localStorage.getItem(STOP_KEY_STORAGE) || 'escape';

function formatKeyLabel(key) {
  if (!key) return '?';
  if (key.length === 1) return key.toUpperCase();
  if (key === 'escape') return 'ESC';
  if (key === ' ') return 'SPACE';
  return key.toUpperCase();
}

function updateStopKeyLabel() {
  const label = document.getElementById('stop-key-label');
  if (label) label.textContent = `[${formatKeyLabel(stopKey)}]`;
  const capture = document.getElementById('stop-key-capture');
  if (capture) {
    capture.textContent = formatKeyLabel(stopKey);
    capture.dataset.key = stopKey;
  }
}

function saveStopKey(key) {
  stopKey = key;
  localStorage.setItem(STOP_KEY_STORAGE, key);
  updateStopKeyLabel();
  showToast(`Stop key set to ${formatKeyLabel(key)}`, 'success');
}

function showToast(message, type = 'info') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${type}`;
  setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// Global stop
function stopAll() {
  audio.stopAll();
  videoDisplay.stop();
  if (editorPreviewVideo) {
    editorPreviewVideo.pause();
  }
  showToast('All stopped', 'info');
}

// Stop button
const stopBtn = document.getElementById('btn-stop-all');
if (stopBtn) {
  stopBtn.addEventListener('click', stopAll);
}

// Configurable stop key
const stopKeyCapture = document.getElementById('stop-key-capture');
if (stopKeyCapture) {
  stopKeyCapture.addEventListener('click', () => {
    stopKeyCapture.classList.add('listening');
    stopKeyCapture.textContent = 'Press a key...';
    window.__pumaKeyCapturing = true;
    window.__pumaStopCapturing = true;

    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = buildKeyCombo(e);
      saveStopKey(combo);
      stopKeyCapture.classList.remove('listening');
      window.__pumaKeyCapturing = false;
      window.__pumaStopCapturing = false;
      window.removeEventListener('keydown', handler);
    };

    window.addEventListener('keydown', handler, { once: true });
  });
}

updateStopKeyLabel();

// Global stop key (capture phase so it fires before pad handlers)
window.addEventListener('keydown', (e) => {
  if (window.__pumaStopCapturing) return;
  const combo = buildKeyCombo(e).toLowerCase();
  if (combo !== stopKey.toLowerCase()) return;

  const active = document.activeElement;
  const isInput = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT' ||
    active.classList.contains('key-capture')
  );
  if (isInput) return;

  e.preventDefault();
  e.stopImmediatePropagation();
  stopAll();
}, true);

// Tabs
function initTabs() {
  const buttons = document.querySelectorAll('.tab-button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

const MAX_PADS = 27;

// Pads
const pads = createPads(document.getElementById('pad-grid'), {
  onSelect(position, data) {
    store.set({ selectedPosition: position, currentPad: data });
    renderPadEditor(position, data);
  },
  async onTrigger(position, data) {
    if (!data || !data.videoId) return;
    await triggerPad(position, data);
    ws.send('pad:trigger', { position, videoId: data.videoId });
  },
  onRelease(position, data) {
    if (data?.triggerMode === 'gate') {
      audio.stop(position);
      // Only stop the main video if no other pad is still playing.
      if (audio.getActivePositions().length === 0) {
        videoDisplay.stop();
      }
    }
    ws.send('pad:release', { position, videoId: data?.videoId });
  },
}, 9);

// Grid size selector
const gridSizeSelect = document.getElementById('grid-size');
if (gridSizeSelect) {
  gridSizeSelect.addEventListener('change', () => {
    const count = parseInt(gridSizeSelect.value, 10);
    if (count >= 1 && count <= MAX_PADS) {
      pads.resize(count);
      showToast(`Grid resized to ${count} pads`, 'success');
    }
  });
}

async function triggerPad(position, data) {
  if (!data || !data.videoId) return;

  const video = store.get().videos.find((v) => v.videoId === data.videoId);
  if (!video) {
    showToast('Video not loaded', 'error');
    return;
  }

  const audioUrl = api.getAudioUrl(data.videoId);
  const videoUrl = api.getVideoUrl(data.videoId);

  try {
    await audio.loadAudio(data.videoId, audioUrl);
  } catch (err) {
    showToast(`Audio load failed: ${err.message}`, 'error');
    return;
  }

  // Exclusive playback: only one pad at a time.
  audio.stopAll();

  await audio.play(position, {
    videoId: data.videoId,
    start: data.start,
    end: data.end,
    volume: data.volume ?? 0.2,
    loop: data.loop ?? false,
    triggerMode: data.triggerMode ?? 'oneshot',
  });

  videoDisplay.playSegment({
    videoId: data.videoId,
    url: videoUrl,
    start: data.start,
    end: data.end,
  });
}

// Pad Editor
const editorEl = document.getElementById('pad-editor');

function renderPadEditor(position, data) {
  cleanupPreviewVideo();

  if (!position) {
    editorEl.innerHTML = '<p class="hint">Click a pad to edit</p>';
    return;
  }

  const videos = store.get().videos;
  const videoOptions = videos
    .map((v) => `<option value="${v.videoId}" ${data?.videoId === v.videoId ? 'selected' : ''}>${escapeHtml(v.title || v.videoId)}</option>`)
    .join('');

  editorEl.innerHTML = `
    <h3>Pad ${position}</h3>
    <div class="form-row">
      <label>Label</label>
      <input type="text" id="pad-label" value="${escapeHtml(data?.label || '')}" placeholder="Kick, Bass, etc.">
    </div>
    <div class="form-row">
      <label>Key</label>
      <div class="key-capture" id="pad-key-capture" data-key="${escapeHtml(data?.key || '')}">
        ${data?.key ? `Key: ${escapeHtml(data.key)}` : 'Click and press a key'}
      </div>
    </div>
    <div class="form-row">
      <label>Video</label>
      <select id="pad-video">${videoOptions}</select>
    </div>
    <div class="form-row">
      <label>Preview</label>
      <video id="editor-preview-video" class="editor-preview-video" controls playsinline></video>
    </div>
    <div class="form-row">
      <label>Transport</label>
      <div class="transport-bar">
        <button id="btn-preview-play" class="btn btn-transport" title="Play preview">▶</button>
        <button id="btn-preview-stop" class="btn btn-transport" title="Stop preview">■</button>
        <div class="transport-divider"></div>
        <button id="btn-set-in" class="btn btn-mark">Set In</button>
        <button id="btn-set-out" class="btn btn-mark">Set Out</button>
        <div class="transport-time" id="preview-time">00:00.000</div>
      </div>
    </div>
    <div class="form-row waveform-section">
      <label>Waveform (drag handles, click to seek)</label>
      <div class="waveform-container">
        <canvas id="waveform-canvas"></canvas>
      </div>
      <div class="waveform-status" id="waveform-status">In: 00:00.000 | Out: 00:00.000 | Dur: 00:00.000</div>
    </div>
    <div class="time-row">
      <div class="form-row">
        <label>Start</label>
        <input type="text" id="pad-start" value="${formatTime(data?.start ?? 0)}">
      </div>
      <div class="form-row">
        <label>End</label>
        <input type="text" id="pad-end" value="${formatTime(data?.end ?? 0)}">
      </div>
    </div>
    <div class="form-row">
      <label>Volume <span class="vol-value" id="pad-volume-value">${Math.round((data?.volume ?? 0.2) / 2 * 100)}%</span></label>
      <input type="range" id="pad-volume" min="0" max="2" step="0.05" value="${data?.volume ?? 0.2}">
    </div>
    <div class="form-row">
      <label>Trigger Mode</label>
      <select id="pad-trigger-mode">
        <option value="oneshot" ${data?.triggerMode === 'oneshot' ? 'selected' : ''}>One-shot (press once)</option>
        <option value="gate" ${data?.triggerMode === 'gate' ? 'selected' : ''}>Gate (while held)</option>
      </select>
    </div>
    <div class="form-row">
      <label>Color</label>
      <input type="color" id="pad-color" value="${data?.color || '#ff9f1c'}">
    </div>
    <div class="form-row">
      <label>
        <input type="checkbox" id="pad-loop" ${data?.loop ? 'checked' : ''}> Loop
      </label>
    </div>
    <button id="pad-save" class="btn">Apply to Pad</button>
  `;

  const canvas = document.getElementById('waveform-canvas');
  editorWaveform = createWaveform(canvas, {
    onChange: (segment) => {
      const startInput = document.getElementById('pad-start');
      const endInput = document.getElementById('pad-end');
      if (startInput) startInput.value = formatTime(segment.start);
      if (endInput) endInput.value = formatTime(segment.end);
      updateWaveformStatus(segment.start, segment.end);
    },
    onSeek: (time) => {
      if (editorPreviewVideo) {
        editorPreviewVideo.currentTime = time;
      }
    },
  });

  if (data?.videoId) {
    loadEditorWaveform(data.videoId, data.start ?? 0, data.end ?? 0);
    setupPreviewVideo(data.videoId);
  }

  updateWaveformStatus(data?.start ?? 0, data?.end ?? 0);

  initEditorListeners(position);
}

function setupPreviewVideo(videoId) {
  cleanupPreviewVideo();

  const oldVideo = document.getElementById('editor-preview-video');
  if (!oldVideo) return;

  // Replace the element to guarantee a clean slate and fresh listeners.
  const newVideo = oldVideo.cloneNode(false);
  newVideo.removeAttribute('src');
  newVideo.src = api.getVideoUrl(videoId);
  newVideo.volume = 0.30;
  oldVideo.parentNode.replaceChild(newVideo, oldVideo);
  editorPreviewVideo = newVideo;

  editorPreviewVideo.__readyPromise = new Promise((resolve, reject) => {
    const onLoaded = () => {
      resolve();
      editorPreviewVideo.removeEventListener('error', onError);
    };
    const onError = () => {
      reject(new Error('Preview video failed to load'));
      editorPreviewVideo.removeEventListener('loadedmetadata', onLoaded);
    };
    editorPreviewVideo.addEventListener('loadedmetadata', onLoaded, { once: true });
    editorPreviewVideo.addEventListener('error', onError, { once: true });
  });

  editorPreviewVideo.addEventListener('error', () => {
    showToast('Preview video failed to load', 'error');
  });

  editorPreviewVideo.addEventListener('seeked', () => {
    if (editorWaveform) editorWaveform.setPlayhead(editorPreviewVideo.currentTime);
    updatePreviewTime();
  });

  editorPreviewVideo.addEventListener('timeupdate', () => {
    if (editorPreviewVideo.paused && editorWaveform) {
      editorWaveform.setPlayhead(editorPreviewVideo.currentTime);
    }
    updatePreviewTime();
  });

  editorPreviewVideo.addEventListener('pause', () => {
    const playBtn = document.getElementById('btn-preview-play');
    if (playBtn) {
      playBtn.classList.remove('active');
      playBtn.textContent = '▶';
    }
  });

  editorPreviewVideo.load();
}

function cleanupPreviewVideo() {
  if (editorPreviewVideo) {
    editorPreviewVideo.pause();
    editorPreviewVideo.removeAttribute('src');
    editorPreviewVideo.load();
    editorPreviewVideo = null;
  }
}

async function loadEditorWaveform(videoId, start, end) {
  const audioUrl = api.getAudioUrl(videoId);
  try {
    const buffer = await audio.loadAudio(videoId, audioUrl);
    editorWaveform.setAudioBuffer(buffer);
    editorWaveform.setSegment(start, end);
  } catch (err) {
    console.error('Failed to load waveform:', err);
  }
}

function updatePreviewTime() {
  const timeEl = document.getElementById('preview-time');
  if (timeEl && editorPreviewVideo) {
    timeEl.textContent = formatTime(editorPreviewVideo.currentTime);
  }
}

function updateWaveformStatus(start, end) {
  const statusEl = document.getElementById('waveform-status');
  if (!statusEl) return;
  const duration = Math.max(0, end - start);
  statusEl.textContent = `In: ${formatTime(start)} | Out: ${formatTime(end)} | Dur: ${formatTime(duration)}`;
}

function syncPlayhead() {
  if (editorPreviewVideo && editorWaveform) {
    editorWaveform.setPlayhead(editorPreviewVideo.currentTime);
    updatePreviewTime();
  }
  if (editorPreviewVideo && !editorPreviewVideo.paused) {
    requestAnimationFrame(syncPlayhead);
  }
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function initEditorListeners(position) {
  const keyCapture = document.getElementById('pad-key-capture');
  const videoSelect = document.getElementById('pad-video');
  const startInput = document.getElementById('pad-start');
  const endInput = document.getElementById('pad-end');
  const volumeInput = document.getElementById('pad-volume');
  const volumeValue = document.getElementById('pad-volume-value');
  const saveBtn = document.getElementById('pad-save');
  const playBtn = document.getElementById('btn-preview-play');
  const stopBtn = document.getElementById('btn-preview-stop');
  const setInBtn = document.getElementById('btn-set-in');
  const setOutBtn = document.getElementById('btn-set-out');

  keyCapture.addEventListener('click', () => {
    keyCapture.classList.add('listening');
    keyCapture.textContent = 'Press a key...';
    window.__pumaKeyCapturing = true;

    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const modifiers = [];
      if (e.ctrlKey) modifiers.push('ctrl');
      if (e.altKey) modifiers.push('alt');
      if (e.metaKey) modifiers.push('meta');
      if (e.shiftKey && e.key.length > 1) modifiers.push('shift');

      const key = e.key.toLowerCase();
      const combo = modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key;

      keyCapture.textContent = `Key: ${combo}`;
      keyCapture.dataset.key = combo;
      keyCapture.classList.remove('listening');
      window.__pumaKeyCapturing = false;
      window.removeEventListener('keydown', handler);
    };

    window.addEventListener('keydown', handler, { once: true });
  });

  videoSelect.addEventListener('change', async () => {
    const videoId = videoSelect.value;
    if (videoId) {
      setupPreviewVideo(videoId);
      await loadEditorWaveform(videoId, 0, 0);
      if (editorWaveform) {
        const segment = editorWaveform.getSegment();
        startInput.value = formatTime(0);
        endInput.value = formatTime(segment.end);
      }
    }
  });

  function updateSegmentFromInputs() {
    const start = parseTime(startInput.value);
    const end = parseTime(endInput.value);
    if (editorWaveform) editorWaveform.setSegment(start, end);
  }

  startInput.addEventListener('change', updateSegmentFromInputs);
  endInput.addEventListener('change', updateSegmentFromInputs);

  volumeInput.addEventListener('input', () => {
    const pct = Math.round(volumeInput.value / 2 * 100);
    volumeValue.textContent = `${pct}%`;
  });

  // Preview transport
  playBtn.addEventListener('click', async () => {
    if (!editorPreviewVideo) return;
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };

    if (editorPreviewVideo.paused) {
      try {
        if (editorPreviewVideo.__readyPromise) {
          await editorPreviewVideo.__readyPromise;
        }
        editorPreviewVideo.currentTime = segment.start;
        await editorPreviewVideo.play();
        playBtn.classList.add('active');
        playBtn.textContent = '⏸';
        syncPlayhead();
      } catch (err) {
        console.warn('Preview play failed:', err);
        showToast('Preview play failed', 'error');
      }
    } else {
      editorPreviewVideo.pause();
      playBtn.classList.remove('active');
      playBtn.textContent = '▶';
    }
  });

  stopBtn.addEventListener('click', () => {
    if (editorPreviewVideo) {
      editorPreviewVideo.pause();
      editorPreviewVideo.currentTime = 0;
    }
    if (playBtn) {
      playBtn.classList.remove('active');
      playBtn.textContent = '▶';
    }
    if (editorWaveform) editorWaveform.setPlayhead(0);
    updatePreviewTime();
  });

  // Mark in/out
  setInBtn.addEventListener('click', () => {
    if (!editorPreviewVideo) return;
    const time = editorPreviewVideo.currentTime;
    const end = parseTime(endInput.value);
    startInput.value = formatTime(time);
    endInput.value = formatTime(Math.max(time + 0.1, end));
    updateSegmentFromInputs();
  });

  setOutBtn.addEventListener('click', () => {
    if (!editorPreviewVideo) return;
    const time = editorPreviewVideo.currentTime;
    const start = parseTime(startInput.value);
    endInput.value = formatTime(Math.max(time, start + 0.1));
    updateSegmentFromInputs();
  });

  saveBtn.addEventListener('click', () => {
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };
    const key = keyCapture.dataset.key || '';
    const data = {
      position,
      key,
      label: document.getElementById('pad-label').value || `Pad ${position}`,
      videoId: videoSelect.value,
      start: segment.start,
      end: segment.end,
      volume: parseFloat(document.getElementById('pad-volume').value),
      triggerMode: document.getElementById('pad-trigger-mode').value,
      color: document.getElementById('pad-color').value,
      loop: document.getElementById('pad-loop').checked,
    };

    if (!data.key) {
      showToast('Assign a key first', 'warning');
      return;
    }
    if (!data.videoId) {
      showToast('Select a video first', 'warning');
      return;
    }
    if (data.start >= data.end) {
      showToast('End must be after start', 'warning');
      return;
    }

    pads.update(position, data);
    showToast(`Pad ${position} updated`, 'success');
  });
}

// Video Library
async function refreshVideos() {
  try {
    const { videos, active } = await api.listVideos();
    store.set({ videos, activeDownloads: active });
    renderVideoList();
  } catch (err) {
    showToast(`Failed to load videos: ${err.message}`, 'error');
  }
}

function renderVideoList() {
  const list = document.getElementById('video-list');
  const { videos, activeDownloads } = store.get();
  list.innerHTML = '';

  const all = [
    ...videos.map((v) => ({ ...v, status: 'ready' })),
    ...activeDownloads.map((a) => ({ videoId: a.videoId, title: a.videoId, duration: 0, status: a.status, progress: a.progress })),
  ];

  for (const video of all) {
    const li = document.createElement('li');
    li.className = 'video-item';

    const statusText = video.status === 'downloading'
      ? `<span class="loading-spinner"></span>${Math.round(video.progress || 0)}%`
      : video.status;

    li.innerHTML = `
      <div class="video-item-info">
        <span class="video-item-title">${escapeHtml(video.title || video.videoId)}</span>
        <span class="video-item-meta">${formatTime(video.duration || 0)} · ${video.videoId}</span>
      </div>
      <span class="status ${video.status}">${statusText}</span>
      <button data-id="${video.videoId}" title="Remove">×</button>
    `;

    li.querySelector('button').addEventListener('click', async () => {
      try {
        await api.deleteVideo(video.videoId);
        audio.unload(video.videoId);
        showToast(`Removed ${video.title || video.videoId}`, 'success');
        await refreshVideos();
      } catch (err) {
        showToast(`Remove failed: ${err.message}`, 'error');
      }
    });

    list.appendChild(li);
  }
}

// Add video form
document.getElementById('add-video-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('video-url');
  const url = input.value.trim();
  if (!url) return;

  try {
    const result = await api.addVideo(url);
    input.value = '';
    if (result.status === 'ready') {
      showToast('Video already available', 'success');
    } else {
      showToast('Video queued for download', 'info');
    }
    await refreshVideos();
  } catch (err) {
    showToast(`Add failed: ${err.message}`, 'error');
  }
});

// WebSocket events
ws.on('download:progress', refreshVideos);
ws.on('download:ready', refreshVideos);
ws.on('download:error', refreshVideos);
ws.on('video:removed', refreshVideos);

// Session Manager
const sessionManager = createSessionManager({
  showToast,
  onSaveRequest() {
    const sessionData = {
      name: document.getElementById('session-name').value.trim(),
      pads: pads.getAll(),
    };
    sessionManager.save(sessionData);
  },
  onSessionLoad(session) {
    document.getElementById('session-name').value = session.name || '';
    const padsArray = session.pads || [];
    const maxPosition = padsArray.reduce((max, p) => Math.max(max, p.position || 0), 0);
    const newCount = Math.max(9, Math.min(MAX_PADS, maxPosition));
    if (newCount !== pads.getCount()) {
      pads.resize(newCount);
      const gridSize = document.getElementById('grid-size');
      if (gridSize) gridSize.value = String(newCount);
    }
    pads.setAll(padsArray);
    store.set({ selectedPosition: null, currentPad: null });
    renderPadEditor(null, null);
  },
});

// Initial load
initTabs();
refreshVideos();
setInterval(refreshVideos, 2000);
setInterval(() => sessionManager.refreshList(), 10000);

showToast('PumaSamplerMusic ready', 'success');

// Cleanup on page unload
window.addEventListener('beforeunload', cleanupPreviewVideo);
