import { api } from './api.js';
import { createStore, buildKeyCombo, formatTime, parseTime } from './state.js';
import { createWebSocketClient } from './ws-client.js';
import { createAudioEngine } from './audio-engine.js';
import { createVideoDisplay } from './video-display.js';
import { createPads } from './pads.js';
import { createWaveform } from './waveform.js';
import { createSessionManager } from './session.js';
import { t, getLocale, setLocale, applyTranslations } from './i18n.js';

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
let isCapturingKey = false;
let masterFxControls = null;

const STOP_KEY_STORAGE = 'puma-stop-key';
const PREVIEW_VOLUME_STORAGE = 'puma-preview-volume';
let stopKey = localStorage.getItem(STOP_KEY_STORAGE) || 'escape';
const savedPreviewVolume = parseFloat(localStorage.getItem(PREVIEW_VOLUME_STORAGE));
let previewVolume = Number.isNaN(savedPreviewVolume) ? 0.30 : savedPreviewVolume;

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
  showToast(t('toast.stopKeySet', { key: formatKeyLabel(key) }), 'success');
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
  showToast(t('toast.allStopped'), 'info');
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
    stopKeyCapture.textContent = t('common.pressKey');
    isCapturingKey = true;
    pads.setKeyCapturing(true);

    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = buildKeyCombo(e);
      saveStopKey(combo);
      stopKeyCapture.classList.remove('listening');
      isCapturingKey = false;
      pads.setKeyCapturing(false);
      window.removeEventListener('keydown', handler);
    };

    window.addEventListener('keydown', handler, { once: true });
  });
}

updateStopKeyLabel();

// Global stop key (capture phase so it fires before pad handlers)
window.addEventListener('keydown', (e) => {
  if (isCapturingKey) return;
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

// Waveform shortcuts (I/O for in/out, Space for preview when editor active)
window.addEventListener('keydown', (e) => {
  if (isCapturingKey) return;
  const active = document.activeElement;
  const isInput = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT' ||
    active.classList.contains('key-capture')
  );
  if (isInput) return;

  const selectedPosition = store.get().selectedPosition;
  if (!selectedPosition) return;

  if (e.key === 'i' || e.key === 'I') {
    e.preventDefault();
    const startInput = document.getElementById('pad-start');
    const endInput = document.getElementById('pad-end');
    if (!editorPreviewVideo || !startInput || !endInput) return;
    const time = editorPreviewVideo.currentTime;
    const end = parseTime(endInput.value);
    startInput.value = formatTime(time);
    endInput.value = formatTime(Math.max(time + 0.1, end));
    if (editorWaveform) editorWaveform.setSegment(parseTime(startInput.value), parseTime(endInput.value));
    autoCommitPad(selectedPosition, { start: parseTime(startInput.value), end: parseTime(endInput.value) });
  } else if (e.key === 'o' || e.key === 'O') {
    e.preventDefault();
    const startInput = document.getElementById('pad-start');
    const endInput = document.getElementById('pad-end');
    if (!editorPreviewVideo || !startInput || !endInput) return;
    const time = editorPreviewVideo.currentTime;
    const start = parseTime(startInput.value);
    endInput.value = formatTime(Math.max(time, start + 0.1));
    if (editorWaveform) editorWaveform.setSegment(parseTime(startInput.value), parseTime(endInput.value));
    autoCommitPad(selectedPosition, { start: parseTime(startInput.value), end: parseTime(endInput.value) });
  } else if (e.code === 'Space') {
    e.preventDefault();
    const playBtn = document.getElementById('btn-preview-play');
    const pauseBtn = document.getElementById('btn-preview-pause');
    if (playBtn && pauseBtn) {
      if (pauseBtn.classList.contains('hidden')) {
        playBtn.click();
      } else {
        pauseBtn.click();
      }
    }
  }
});

function initLibrarySidenav() {
  const sidenav = document.getElementById('library-sidenav');
  const toggle = document.getElementById('library-sidenav-toggle');
  if (!sidenav || !toggle) return;

  toggle.addEventListener('click', () => {
    const expanded = sidenav.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', String(expanded));
  });
}

function initPanelToggle() {
  document.querySelectorAll('.panel').forEach((panel) => {
    const toggle = panel.querySelector('.panel-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '▴' : '▾';
      toggle.title = collapsed ? t('panel.expandTitle') : t('panel.collapseTitle');
      toggle.setAttribute('aria-label', collapsed ? t('panel.expandTitle') : t('panel.collapseTitle'));
      if (!collapsed && editorWaveform) {
        editorWaveform.resize();
        editorWaveform.draw();
      }
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

function autoCommitPad(position, updates) {
  const current = pads.getData(position) || store.get().currentPad;
  if (!current) return;
  const data = { ...current, ...updates };
  pads.update(position, data);
  store.set({ currentPad: data });
}

// Grid size selector
const gridSizeSelect = document.getElementById('grid-size');
if (gridSizeSelect) {
  gridSizeSelect.addEventListener('change', () => {
    const count = parseInt(gridSizeSelect.value, 10);
    if (count >= 1 && count <= MAX_PADS) {
      pads.resize(count);
      showToast(t('toast.padsResized', { n: count }), 'success');
    }
  });
}

// Master controls
const MASTER_FX_STORAGE = 'puma-master-fx';

function percentToFreq(percent) {
  const min = Math.log10(20);
  const max = Math.log10(20000);
  const log = min + (percent / 100) * (max - min);
  return Math.pow(10, log);
}

function freqToPercent(freq) {
  const min = Math.log10(20);
  const max = Math.log10(20000);
  return ((Math.log10(freq) - min) / (max - min)) * 100;
}

function formatHz(freq) {
  if (freq >= 1000) return `${(freq / 1000).toFixed(1)}kHz`;
  return `${Math.round(freq)}Hz`;
}

function loadMasterFxDefaults() {
  try {
    const saved = localStorage.getItem(MASTER_FX_STORAGE);
    if (saved) return JSON.parse(saved);
  } catch {
    // ignore
  }
  return {
    volume: 1,
    cutoff: 100,
    resonance: 0.1,
    reverb: 0,
    delayTime: 250,
    delayFeedback: 0,
  };
}

function saveMasterFx(state) {
  try {
    localStorage.setItem(MASTER_FX_STORAGE, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function initMasterControls() {
  const state = loadMasterFxDefaults();

  const controls = [
    {
      id: 'master-volume',
      displayId: 'master-volume-value',
      toValue: (v) => parseFloat(v),
      toDisplay: (v) => `${Math.round(v * 100)}%`,
      apply: (v) => audio.setMasterVolume(v),
      key: 'volume',
    },
    {
      id: 'master-cutoff',
      displayId: 'master-cutoff-value',
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => formatHz(percentToFreq(v)),
      apply: (v) => audio.setMasterFilter({ cutoff: percentToFreq(v) }),
      key: 'cutoff',
    },
    {
      id: 'master-resonance',
      displayId: 'master-resonance-value',
      toValue: (v) => parseFloat(v),
      toDisplay: (v) => v.toFixed(1),
      apply: (v) => audio.setMasterFilter({ resonance: v }),
      key: 'resonance',
    },
    {
      id: 'master-reverb',
      displayId: 'master-reverb-value',
      toValue: (v) => parseFloat(v),
      toDisplay: (v) => `${Math.round(v * 100)}%`,
      apply: (v) => audio.setMasterReverb(v),
      key: 'reverb',
    },
    {
      id: 'master-delay-time',
      displayId: 'master-delay-time-value',
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => `${v}ms`,
      apply: (v) => audio.setMasterDelay({ time: v / 1000 }),
      key: 'delayTime',
    },
    {
      id: 'master-delay-feedback',
      displayId: 'master-delay-feedback-value',
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => `${v}%`,
      apply: (v) => audio.setMasterDelay({ feedback: v / 100 }),
      key: 'delayFeedback',
    },
  ];

  for (const ctrl of controls) {
    const input = document.getElementById(ctrl.id);
    const display = document.getElementById(ctrl.displayId);
    if (!input) continue;

    input.value = state[ctrl.key] ?? input.value;
    const value = ctrl.toValue(input.value);
    if (display) display.textContent = ctrl.toDisplay(value);
    ctrl.apply(value);

    input.addEventListener('input', () => {
      const v = ctrl.toValue(input.value);
      if (display) display.textContent = ctrl.toDisplay(v);
      ctrl.apply(v);
      state[ctrl.key] = v;
      saveMasterFx(state);
    });
  }

  function getState() {
    return { ...state };
  }

  function applyState(fx) {
    for (const ctrl of controls) {
      const input = document.getElementById(ctrl.id);
      const display = document.getElementById(ctrl.displayId);
      if (!input) continue;

      const v = fx[ctrl.key] ?? state[ctrl.key];
      input.value = v;
      const value = ctrl.toValue(input.value);
      if (display) display.textContent = ctrl.toDisplay(value);
      ctrl.apply(value);
      state[ctrl.key] = value;
    }
    saveMasterFx(state);
  }

  return { getState, applyState };
}

async function triggerPad(position, data) {
  if (!data || !data.videoId) return;

  const video = store.get().videos.find((v) => v.videoId === data.videoId);
  if (!video) {
    showToast(t('toast.videoNotLoaded'), 'error');
    return;
  }

  const audioUrl = api.getAudioUrl(data.videoId);
  const videoUrl = api.getVideoUrl(data.videoId);

  try {
    await audio.loadAudio(data.videoId, audioUrl);
  } catch (err) {
    showToast(t('toast.audioLoadFailed', { message: err.message }), 'error');
    return;
  }

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
  if (editorWaveform) {
    editorWaveform.destroy();
    editorWaveform = null;
  }

  if (!position) {
    editorEl.innerHTML = `<p class="hint">${t('editor.clickPadToEdit')}</p>`;
    return;
  }

  const videos = store.get().videos;
  const videoOptions =
    `<option value="" disabled ${!data?.videoId ? 'selected' : ''}>${t('editor.selectVideo')}</option>` +
    videos
      .map((v) => `<option value="${v.videoId}" ${data?.videoId === v.videoId ? 'selected' : ''}>${escapeHtml(v.title || v.videoId)}</option>`)
      .join('');

  editorEl.innerHTML = `
    <h3>PAD ${position}</h3>
    <div class="form-row">
      <label>${t('editor.labelField')}</label>
      <input type="text" id="pad-label" value="${escapeHtml(data?.label || '')}" placeholder="${t('editor.labelPlaceholder')}">
    </div>
    <div class="form-row">
      <label>${t('editor.keyField')}</label>
      <div class="key-capture" id="pad-key-capture" data-key="${escapeHtml(data?.key || '')}">
        ${data?.key ? t('editor.keyValue', { key: escapeHtml(data.key) }) : t('editor.clickPressKey')}
      </div>
    </div>
    <div class="form-row">
      <label>${t('editor.videoField')}</label>
      <select id="pad-video">${videoOptions}</select>
    </div>
    <div class="form-row">
      <label>${t('editor.previewField')}</label>
      <video id="editor-preview-video" class="editor-preview-video" controls playsinline></video>
    </div>
    <div class="form-row">
      <label>${t('editor.transportField')}</label>
      <div class="transport-bar">
        <button id="btn-preview-play" class="btn btn-transport" title="${t('editor.playTitle')}"><span class="material-symbols-outlined">play_arrow</span></button>
        <button id="btn-preview-pause" class="btn btn-transport hidden" title="${t('editor.pauseTitle')}"><span class="material-symbols-outlined">pause</span></button>
        <button id="btn-preview-stop" class="btn btn-transport btn-transport-stop" title="${t('editor.stopTitle')}"><span class="material-symbols-outlined">stop</span></button>
        <div class="transport-divider"></div>
        <button id="btn-set-in" class="btn btn-mark" title="${t('editor.setInTitle')}">${t('editor.setIn')}</button>
        <button id="btn-set-out" class="btn btn-mark" title="${t('editor.setOutTitle')}">${t('editor.setOut')}</button>
        <div class="transport-time" id="preview-time">00:00.000</div>
      </div>
    </div>
    <div class="form-row waveform-section">
      <label class="waveform-label-row">
        <span>${t('waveform.label')}</span>
        <span class="help-icon" data-tooltip="${t('tip.waveformHelp')}">?</span>
        <span class="waveform-zoom-controls">
          <button type="button" class="btn-zoom" id="btn-waveform-zoom-out" title="${t('waveform.zoomOutTitle')}">-</button>
          <span class="zoom-level" id="waveform-zoom-level">1x</span>
          <button type="button" class="btn-zoom" id="btn-waveform-zoom-in" title="${t('waveform.zoomInTitle')}">+</button>
          <button type="button" class="btn-zoom" id="btn-waveform-zoom-reset" title="${t('waveform.zoomResetTitle')}">⟲</button>
        </span>
      </label>
      <div class="waveform-container">
        <canvas id="waveform-ruler" class="waveform-ruler"></canvas>
        <canvas id="waveform-canvas"></canvas>
      </div>
      <div class="waveform-status" id="waveform-status">${t('waveform.status', { in: '00:00.000', out: '00:00.000', dur: '00:00.000' })}</div>
    </div>
    <div class="time-row">
      <div class="form-row">
        <label>${t('editor.startField')}</label>
        <input type="text" id="pad-start" value="${formatTime(data?.start ?? 0)}">
      </div>
      <div class="form-row">
        <label>${t('editor.endField')}</label>
        <input type="text" id="pad-end" value="${formatTime(data?.end ?? 0)}">
      </div>
    </div>
    <div class="form-row">
      <label>${t('editor.previewVolumeField')} <span class="vol-value" id="pad-preview-volume-value">${Math.round(previewVolume * 100)}%</span></label>
      <input type="range" id="pad-preview-volume" min="0" max="1" step="0.05" value="${previewVolume}">
    </div>
    <div class="form-row">
      <label>${t('editor.padVolumeField')} <span class="vol-value" id="pad-volume-value">${Math.round((data?.volume ?? 0.2) / 2 * 100)}%</span></label>
      <input type="range" id="pad-volume" min="0" max="2" step="0.05" value="${data?.volume ?? 0.2}">
    </div>
    <div class="form-row">
      <label>${t('editor.triggerModeField')} <span class="help-icon" data-tooltip="${t('tip.triggerMode')}">?</span></label>
      <select id="pad-trigger-mode">
        <option value="oneshot" ${data?.triggerMode === 'oneshot' ? 'selected' : ''}>${t('editor.oneshotOption')}</option>
        <option value="gate" ${data?.triggerMode === 'gate' ? 'selected' : ''}>${t('editor.gateOption')}</option>
      </select>
    </div>
    <div class="form-row">
      <label>${t('editor.colorField')}</label>
      <input type="color" id="pad-color" value="${data?.color || '#ff9f1c'}">
    </div>
    <div class="form-row">
      <label>
        <input type="checkbox" id="pad-loop" ${data?.loop ? 'checked' : ''}> ${t('editor.loopField')}
      </label>
    </div>
    <button id="pad-save" class="btn">${t('editor.applyButton')}</button>
  `;

  const canvas = document.getElementById('waveform-canvas');
  const rulerCanvas = document.getElementById('waveform-ruler');
  if (editorWaveform) editorWaveform.destroy();
  editorWaveform = createWaveform(canvas, {
    rulerCanvas,
    onChange: (segment) => {
      const startInput = document.getElementById('pad-start');
      const endInput = document.getElementById('pad-end');
      if (startInput) startInput.value = formatTime(segment.start);
      if (endInput) endInput.value = formatTime(segment.end);
      updateWaveformStatus(segment.start, segment.end);
      autoCommitPad(position, { start: segment.start, end: segment.end });
    },
    onSeek: (time) => {
      if (editorPreviewVideo) {
        editorPreviewVideo.currentTime = time;
      }
    },
    onZoom: () => {
      updateZoomDisplay();
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
  newVideo.volume = previewVolume;
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
    showToast(t('toast.previewLoadFailed'), 'error');
  });

  editorPreviewVideo.addEventListener('seeked', () => {
    if (editorWaveform) editorWaveform.setPlayhead(editorPreviewVideo.currentTime);
    updatePreviewTime();
  });

  editorPreviewVideo.addEventListener('timeupdate', () => {
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };
    if (editorPreviewVideo.currentTime >= segment.end && !editorPreviewVideo.paused) {
      editorPreviewVideo.pause();
      editorPreviewVideo.currentTime = segment.start;
    }
    if (editorWaveform) {
      editorWaveform.setPlayhead(editorPreviewVideo.currentTime);
    }
    updatePreviewTime();
  });

  editorPreviewVideo.addEventListener('pause', () => {
    const playBtn = document.getElementById('btn-preview-play');
    const pauseBtn = document.getElementById('btn-preview-pause');
    if (playBtn && pauseBtn) {
      playBtn.classList.remove('hidden');
      pauseBtn.classList.add('hidden');
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
  if (editorWaveform) editorWaveform.setLoading(t('waveform.loading'));
  const audioUrl = api.getAudioUrl(videoId);
  try {
    const buffer = await audio.loadAudio(videoId, audioUrl);
    editorWaveform.setAudioBuffer(buffer);
    editorWaveform.setSegment(start, end);
  } catch (err) {
    console.error('Failed to load waveform:', err);
    if (editorWaveform) editorWaveform.setEmpty(t('waveform.noAudioTrack'));
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
  statusEl.textContent = t('waveform.status', { in: formatTime(start), out: formatTime(end), dur: formatTime(duration) });
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
  const previewVolumeInput = document.getElementById('pad-preview-volume');
  const labelInput = document.getElementById('pad-label');
  const triggerModeInput = document.getElementById('pad-trigger-mode');
  const loopInput = document.getElementById('pad-loop');
  const saveBtn = document.getElementById('pad-save');
  const playBtn = document.getElementById('btn-preview-play');
  const pauseBtn = document.getElementById('btn-preview-pause');
  const stopBtn = document.getElementById('btn-preview-stop');
  const setInBtn = document.getElementById('btn-set-in');
  const setOutBtn = document.getElementById('btn-set-out');
  const zoomInBtn = document.getElementById('btn-waveform-zoom-in');
  const zoomOutBtn = document.getElementById('btn-waveform-zoom-out');
  const zoomResetBtn = document.getElementById('btn-waveform-zoom-reset');
  const zoomLevelEl = document.getElementById('waveform-zoom-level');

  keyCapture.addEventListener('click', () => {
    keyCapture.classList.add('listening');
    keyCapture.textContent = t('common.pressKey');
    isCapturingKey = true;
    pads.setKeyCapturing(true);

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

      keyCapture.textContent = t('editor.keyValue', { key: combo });
      keyCapture.dataset.key = combo;
      keyCapture.classList.remove('listening');
      isCapturingKey = false;
      pads.setKeyCapturing(false);
      window.removeEventListener('keydown', handler);
      autoCommitPad(position, { key: combo });
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
        autoCommitPad(position, { videoId, start: 0, end: segment.end });
      }
    }
  });

  function updateSegmentFromInputs() {
    let start = parseTime(startInput.value);
    let end = parseTime(endInput.value);
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    if (editorWaveform) {
      editorWaveform.setSegment(start, end);
      const segment = editorWaveform.getSegment();
      start = segment.start;
      end = segment.end;
      startInput.value = formatTime(start);
      endInput.value = formatTime(end);
    }
    autoCommitPad(position, { start, end });
  }

  function updateZoomDisplay() {
    if (!zoomLevelEl || !editorWaveform) return;
    const level = editorWaveform.getZoomLevel();
    zoomLevelEl.textContent = `${Math.round(level * 10) / 10}x`;
  }

  if (zoomInBtn && editorWaveform) {
    zoomInBtn.addEventListener('click', () => {
      editorWaveform.zoomIn();
      updateZoomDisplay();
    });
  }
  if (zoomOutBtn && editorWaveform) {
    zoomOutBtn.addEventListener('click', () => {
      editorWaveform.zoomOut();
      updateZoomDisplay();
    });
  }
  if (zoomResetBtn && editorWaveform) {
    zoomResetBtn.addEventListener('click', () => {
      editorWaveform.zoomReset();
      updateZoomDisplay();
    });
  }
  updateZoomDisplay();

  startInput.addEventListener('input', updateSegmentFromInputs);
  endInput.addEventListener('input', updateSegmentFromInputs);

  if (previewVolumeInput) {
    previewVolumeInput.addEventListener('input', () => {
      previewVolume = parseFloat(previewVolumeInput.value);
      localStorage.setItem(PREVIEW_VOLUME_STORAGE, String(previewVolume));
      const pct = Math.round(previewVolume * 100);
      const previewVolumeValue = document.getElementById('pad-preview-volume-value');
      if (previewVolumeValue) previewVolumeValue.textContent = `${pct}%`;
      if (editorPreviewVideo) editorPreviewVideo.volume = previewVolume;
    });
  }

  volumeInput.addEventListener('input', () => {
    const pct = Math.round(volumeInput.value / 2 * 100);
    const volumeValue = document.getElementById('pad-volume-value');
    if (volumeValue) volumeValue.textContent = `${pct}%`;
    autoCommitPad(position, { volume: parseFloat(volumeInput.value) });
  });

  const colorInput = document.getElementById('pad-color');
  if (colorInput) {
    colorInput.addEventListener('input', () => {
      autoCommitPad(position, { color: colorInput.value });
    });
  }

  if (labelInput) {
    labelInput.addEventListener('change', () => {
      autoCommitPad(position, { label: labelInput.value || `PAD ${position}` });
    });
  }

  if (triggerModeInput) {
    triggerModeInput.addEventListener('change', () => {
      autoCommitPad(position, { triggerMode: triggerModeInput.value });
    });
  }

  if (loopInput) {
    loopInput.addEventListener('change', () => {
      autoCommitPad(position, { loop: loopInput.checked });
    });
  }

  function setTransportState(isPlaying) {
    if (isPlaying) {
      playBtn.classList.add('hidden');
      pauseBtn.classList.remove('hidden');
    } else {
      playBtn.classList.remove('hidden');
      pauseBtn.classList.add('hidden');
    }
  }

  // Preview transport
  async function playPreview() {
    if (!editorPreviewVideo) return;
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };
    if (!editorPreviewVideo.paused) return;

    playBtn.disabled = true;
    pauseBtn.disabled = true;
    try {
      if (editorPreviewVideo.__readyPromise) {
        await editorPreviewVideo.__readyPromise;
      }
      editorPreviewVideo.currentTime = segment.start;
      await editorPreviewVideo.play();
      setTransportState(true);
      syncPlayhead();
    } catch (err) {
      console.warn('Preview play failed:', err);
      showToast(t('toast.previewPlayFailed'), 'error');
    } finally {
      playBtn.disabled = false;
      pauseBtn.disabled = false;
    }
  }

  function pausePreview() {
    if (!editorPreviewVideo) return;
    editorPreviewVideo.pause();
    setTransportState(false);
  }

  function stopPreview() {
    if (!editorPreviewVideo) return;
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };
    editorPreviewVideo.pause();
    editorPreviewVideo.currentTime = segment.start;
    setTransportState(false);
    if (editorWaveform) editorWaveform.setPlayhead(segment.start);
    updatePreviewTime();
  }

  playBtn.addEventListener('click', playPreview);
  pauseBtn.addEventListener('click', pausePreview);
  stopBtn.addEventListener('click', stopPreview);

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
      label: document.getElementById('pad-label').value || `PAD ${position}`,
      videoId: videoSelect.value,
      start: segment.start,
      end: segment.end,
      volume: parseFloat(document.getElementById('pad-volume').value),
      triggerMode: document.getElementById('pad-trigger-mode').value,
      color: document.getElementById('pad-color').value,
      loop: document.getElementById('pad-loop').checked,
    };

    if (!data.key) {
      showToast(t('toast.assignKeyFirst'), 'warning');
      return;
    }
    if (!data.videoId) {
      showToast(t('toast.selectVideoFirst'), 'warning');
      return;
    }
    if (data.start >= data.end) {
      showToast(t('toast.endAfterStart'), 'warning');
      return;
    }

    pads.update(position, data);
    showToast(t('toast.padUpdated', { position }), 'success');
  });
}

// Video Library
async function refreshVideos() {
  try {
    const { videos, active } = await api.listVideos();
    store.set({ videos, activeDownloads: active });
    renderVideoList();
  } catch (err) {
    showToast(t('toast.videosLoadFailed', { message: err.message }), 'error');
  }
}

function statusLabel(status) {
  return t(`video.status.${status}`) || status;
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
      : statusLabel(video.status);

    li.innerHTML = `
      <div class="video-item-info">
        <span class="video-item-title">${escapeHtml(video.title || video.videoId)}</span>
        <span class="video-item-meta">${formatTime(video.duration || 0)} · ${video.videoId}</span>
      </div>
      <span class="status ${video.status}">${statusText}</span>
      <button data-id="${video.videoId}" title="${t('common.remove')}">×</button>
    `;

    li.querySelector('button').addEventListener('click', async () => {
      try {
        await api.deleteVideo(video.videoId);
        audio.unload(video.videoId);
        showToast(t('toast.videoRemoved', { name: video.title || video.videoId }), 'success');
        await refreshVideos();
      } catch (err) {
        showToast(t('toast.removeFailed', { message: err.message }), 'error');
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
      showToast(t('toast.videoAlreadyAvailable'), 'success');
    } else {
      showToast(t('toast.videoQueued'), 'info');
    }
    await refreshVideos();
  } catch (err) {
    showToast(t('toast.addFailed', { message: err.message }), 'error');
  }
});

// Import session from ZIP
const importInput = document.getElementById('import-session-file');
const importBtn = document.getElementById('btn-import-session');
if (importBtn && importInput) {
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    await sessionManager.importFromZip(file);
  });
}

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
      masterFx: masterFxControls ? masterFxControls.getState() : undefined,
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
    if (masterFxControls) {
      masterFxControls.applyState(session.masterFx || loadMasterFxDefaults());
    }
  },
});

// Export session
const exportBtn = document.getElementById('btn-export-session');
if (exportBtn) {
  exportBtn.addEventListener('click', async () => {
    const name = document.getElementById('session-name').value.trim();
    if (!name) {
      showToast(t('toast.saveOrLoadBeforeExport'), 'error');
      return;
    }
    // Save first so the export reflects live/auto-committed pad edits, not
    // whatever was last written to disk.
    try {
      const saved = await sessionManager.save({
        pads: pads.getAll(),
        masterFx: masterFxControls ? masterFxControls.getState() : undefined,
      });
      if (!saved) return;
      window.open(api.exportSession(saved.name), '_blank');
    } catch {
      // sessionManager.save() already showed an error toast.
    }
  });
}

// Locale switcher
function initLocaleSwitcher() {
  const localeSelect = document.getElementById('locale-select');
  if (!localeSelect) return;

  localeSelect.value = getLocale();

  localeSelect.addEventListener('change', () => {
    setLocale(localeSelect.value);
    applyTranslations(document);

    // Re-render already-painted dynamic content that depends on text.
    const selectedPosition = store.get().selectedPosition;
    const currentPad = store.get().currentPad;
    if (selectedPosition) {
      renderPadEditor(selectedPosition, currentPad);
    }
    renderVideoList();
    sessionManager.refreshList();
  });
}

// Initial load
initPanelToggle();
initLibrarySidenav();
initLocaleSwitcher();
applyTranslations(document);
masterFxControls = initMasterControls();
refreshVideos();
setInterval(refreshVideos, 2000);
setInterval(() => sessionManager.refreshList(), 10000);

showToast(t('toast.appReady'), 'success');

// Cleanup on page unload
window.addEventListener('beforeunload', cleanupPreviewVideo);
