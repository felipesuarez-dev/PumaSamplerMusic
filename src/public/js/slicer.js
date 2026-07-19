import { createWaveform } from './waveform.js';
import { formatTime } from './state.js';

const CLOSE_SKIP_CONFIRM_KEY = 'puma-slicer-skip-close-confirm';
const LONG_AUDIO_THRESHOLD_SEC = 10 * 60;
const DEFAULT_SENSITIVITY = 0.5;

// Full per-pad shape used whenever the slicer creates a pad from scratch
// (single assignment or "new session with selected"). Mirrors PAD_FX_DEFAULTS
// in src/services/session-store.js field-for-field, plus the base pad fields
// app.js's editor writes (label/videoId/start/end/volume/triggerMode/color/
// loop) — never spread from an existing pad, since there may not be one.
function buildSlicePadObject(position, videoId, slice, sliceIndex) {
  return {
    position,
    key: '',
    label: `Slice ${sliceIndex + 1}`,
    videoId,
    start: slice.start,
    end: slice.end,
    volume: 0.2,
    triggerMode: 'oneshot',
    color: '#ff9f1c',
    loop: false,
    pitch: 0,
    cutoff: 100,
    resonance: 0.1,
    reverbSend: 0,
    delaySend: 0,
    pitchShiftOn: true,
    stretchOn: false,
    speed: 100,
    pan: 0,
    drive: 0,
    attack: 0,
    release: 0,
    reverse: false,
  };
}

export function createSlicer({ api, audio, pads, store, sessionManager, showToast, openConfirmModal, t }) {
  const sidenav = document.getElementById('library-sidenav');
  const videoTitleEl = document.getElementById('slicer-video-title');
  const closeBtn = document.getElementById('slicer-close-btn');
  const canvas = document.getElementById('slicer-waveform-canvas');
  const rulerCanvas = document.getElementById('slicer-waveform-ruler');
  const sensitivityInput = document.getElementById('slicer-sensitivity');
  const sensitivityValueEl = document.getElementById('slicer-sensitivity-value');
  const generateBtn = document.getElementById('slicer-generate-btn');
  const overlayEl = document.getElementById('slicer-overlay');
  const progressEl = document.getElementById('slicer-progress');
  const progressValueEl = document.getElementById('slicer-progress-value');
  const cancelBtn = document.getElementById('slicer-cancel-btn');
  const resultsHintEl = document.getElementById('slicer-results-hint');
  const listEl = document.getElementById('slicer-slice-list');
  const newSessionBtn = document.getElementById('slicer-new-session-btn');

  // Bail out gracefully if the shell markup isn't present (e.g. a stale
  // index.html during incremental rollout) instead of throwing on every
  // getElementById().addEventListener() below.
  if (!sidenav || !canvas || !overlayEl || !listEl) {
    return {
      openForVideo() {},
      isOpen: () => false,
      close() {},
    };
  }

  let open = false;
  let currentVideoId = null;
  let waveform = null;
  let worker = null;
  let gen = 0;
  let analyzing = false;
  let closeModalOpen = false;

  // One analysis per video, cached in memory only (never per-pad) — reopening
  // a video restores its last generated slices without re-running the worker.
  const cache = new Map(); // videoId -> { sensitivity, slices }
  let currentSlices = [];
  const assignedMap = new Map(); // sliceIndex -> pad position, for the currently open video
  const selected = new Set(); // sliceIndex, for "new session with selected"

  let previewingIndex = null;
  let previewBtnEl = null;
  let previewTimer = null;

  function isOpen() {
    return open;
  }

  function ensureWaveform() {
    if (waveform) return waveform;
    waveform = createWaveform(canvas, { selectionEnabled: false, rulerCanvas });
    return waveform;
  }

  function slicesToMarkerTimes(slices) {
    if (!slices.length) return [];
    const times = slices.map((s) => s.start);
    times.push(slices[slices.length - 1].end);
    return times;
  }

  function updateSensitivityLabel() {
    sensitivityValueEl.textContent = parseFloat(sensitivityInput.value).toFixed(2);
  }

  function showOverlay() {
    overlayEl.classList.add('visible');
  }

  function hideOverlay() {
    overlayEl.classList.remove('visible');
  }

  function setProgress(fraction) {
    const clamped = Math.max(0, Math.min(1, fraction || 0));
    progressEl.value = clamped;
    progressValueEl.textContent = `${Math.round(clamped * 100)}%`;
  }

  function terminateWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  // Stops any running analysis so a stale progress/done message can never
  // land after cancellation — bumping gen makes onmessage's gen check reject
  // it even in the (unlikely) case terminate() doesn't win the race.
  function cancelWorker() {
    if (!analyzing && !worker) return;
    gen += 1;
    terminateWorker();
    analyzing = false;
    hideOverlay();
  }

  function stopPreview() {
    if (previewingIndex === null) return;
    clearTimeout(previewTimer);
    audio.stop(0);
    if (previewBtnEl) previewBtnEl.innerHTML = '<span class="material-symbols-outlined">play_arrow</span>';
    previewingIndex = null;
    previewBtnEl = null;
  }

  function togglePreview(index, slice, btnEl) {
    if (previewingIndex === index) {
      stopPreview();
      return;
    }
    stopPreview();
    previewingIndex = index;
    previewBtnEl = btnEl;
    btnEl.innerHTML = '<span class="material-symbols-outlined">stop</span>';
    // Position 0 is never a real pad (pads are 1..N) — a dedicated scratch
    // voice slot for slice preview, stopped the same way any pad is (stop(0)).
    audio.play(0, { videoId: currentVideoId, start: slice.start, end: slice.end, volume: 1 }).catch(() => {});
    const durationMs = Math.max(0, slice.end - slice.start) * 1000;
    previewTimer = setTimeout(() => {
      if (previewingIndex === index) stopPreview();
    }, durationMs + 60);
  }

  function buildAssignOptions(select) {
    const currentValue = select.value;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('slicer.assign');
    select.appendChild(placeholder);
    const count = pads.getCount();
    for (let p = 1; p <= count; p++) {
      const data = pads.getData(p);
      const opt = document.createElement('option');
      opt.value = String(p);
      opt.textContent = data
        ? t('slicer.assignTargetOccupied', { position: p, label: data.label || `PAD ${p}` })
        : t('slicer.assignTargetEmpty', { position: p });
      select.appendChild(opt);
    }
    select.value = currentValue;
  }

  function doAssign(sliceIndex, slice, position) {
    const padObject = buildSlicePadObject(position, currentVideoId, slice, sliceIndex);
    pads.update(position, padObject);
    assignedMap.set(sliceIndex, position);
    showToast(t('slicer.assigned', { position }), 'success');
    renderResultsList();
  }

  function requestAssign(sliceIndex, slice, position) {
    const existing = pads.getData(position);
    if (existing) {
      openConfirmModal({
        title: t('slicer.overwriteTitle', { position }),
        body: t('slicer.overwriteBody', { position }),
        confirmLabel: t('organize.overwriteConfirmButton'),
        onConfirm: () => doAssign(sliceIndex, slice, position),
      });
    } else {
      doAssign(sliceIndex, slice, position);
    }
  }

  function renderResultsList() {
    if (!currentSlices.length) {
      resultsHintEl.textContent = t('slicer.noSlices');
      resultsHintEl.hidden = false;
    } else if (assignedMap.size > 0) {
      resultsHintEl.textContent = t('slicer.needsKeyHint');
      resultsHintEl.hidden = false;
    } else {
      resultsHintEl.hidden = true;
    }

    listEl.innerHTML = '';
    newSessionBtn.disabled = selected.size === 0;
    if (!currentSlices.length) return;

    const limit = pads.getCount();
    const atLimit = selected.size >= limit;

    currentSlices.forEach((slice, index) => {
      const li = document.createElement('li');
      li.className = 'slice-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'slice-row-checkbox';
      checkbox.checked = selected.has(index);
      checkbox.disabled = atLimit && !checkbox.checked;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (selected.size >= pads.getCount()) {
            checkbox.checked = false;
            showToast(t('slicer.selectionLimit', { count: pads.getCount() }), 'warning');
            return;
          }
          selected.add(index);
        } else {
          selected.delete(index);
        }
        renderResultsList();
      });

      const indexEl = document.createElement('span');
      indexEl.className = 'slice-row-index';
      indexEl.textContent = `#${index + 1}`;

      const timeEl = document.createElement('span');
      timeEl.className = 'slice-row-time';
      timeEl.textContent = `${formatTime(slice.start)} – ${formatTime(slice.end)}`;

      const durEl = document.createElement('span');
      durEl.className = 'slice-row-duration';
      durEl.textContent = `${(slice.end - slice.start).toFixed(2)}s`;

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn btn-transport slice-preview-btn';
      previewBtn.title = t('slicer.preview');
      previewBtn.innerHTML = previewingIndex === index
        ? '<span class="material-symbols-outlined">stop</span>'
        : '<span class="material-symbols-outlined">play_arrow</span>';
      previewBtn.addEventListener('click', () => togglePreview(index, slice, previewBtn));

      const assignSelect = document.createElement('select');
      assignSelect.className = 'slicer-assign-select session-modal-select';
      buildAssignOptions(assignSelect);
      assignSelect.addEventListener('change', () => {
        const position = parseInt(assignSelect.value, 10);
        assignSelect.value = '';
        if (!position) return;
        requestAssign(index, slice, position);
      });

      li.append(checkbox, indexEl, timeEl, durEl, previewBtn, assignSelect);

      if (assignedMap.has(index)) {
        const badge = document.createElement('span');
        badge.className = 'slice-row-badge';
        badge.textContent = t('slicer.assigned', { position: assignedMap.get(index) });
        li.appendChild(badge);
      }

      listEl.appendChild(li);
    });
  }

  function finishAnalysis(sensitivity, slices) {
    analyzing = false;
    hideOverlay();
    terminateWorker();
    cache.set(currentVideoId, { sensitivity, slices });
    currentSlices = slices;
    assignedMap.clear();
    selected.clear();
    if (waveform) waveform.setMarkers(slicesToMarkerTimes(slices));
    renderResultsList();
  }

  function failAnalysis(message) {
    analyzing = false;
    hideOverlay();
    terminateWorker();
    showToast(message || t('slicer.workerUnavailable'), 'error');
  }

  function startAnalysis(buffer) {
    if (typeof Worker === 'undefined') {
      showToast(t('slicer.workerUnavailable'), 'error');
      return;
    }

    terminateWorker();
    gen += 1;
    const myGen = gen;
    analyzing = true;
    setProgress(0);
    showOverlay();

    const sensitivity = parseFloat(sensitivityInput.value);
    const channelDataCopy = buffer.getChannelData(0).slice();

    let w;
    try {
      w = new Worker('/js/slicer-worker.js', { type: 'module' });
    } catch {
      analyzing = false;
      hideOverlay();
      showToast(t('slicer.workerUnavailable'), 'error');
      return;
    }
    worker = w;

    w.onmessage = (event) => {
      const data = event.data || {};
      if (data.gen !== myGen) return; // stale message from a canceled/replaced run
      if (data.type === 'progress') {
        setProgress(data.value);
      } else if (data.type === 'done') {
        finishAnalysis(sensitivity, data.slices);
      } else if (data.type === 'error') {
        failAnalysis(data.message);
      }
    };
    w.onerror = () => {
      if (worker !== w) return;
      failAnalysis();
    };

    w.postMessage(
      { channelData: channelDataCopy, sampleRate: buffer.sampleRate, sensitivity, gen: myGen },
      [channelDataCopy.buffer],
    );
  }

  async function loadWaveformAudio(videoId, cachedSlices) {
    const wf = ensureWaveform();
    wf.setLoading();
    try {
      const buffer = await audio.loadAudio(videoId, api.getAudioUrl(videoId));
      if (currentVideoId !== videoId || !waveform) return; // switched away mid-load
      waveform.setAudioBuffer(buffer);
      if (cachedSlices.length) waveform.setMarkers(slicesToMarkerTimes(cachedSlices));
    } catch (err) {
      if (currentVideoId !== videoId || !waveform) return;
      waveform.setEmpty(t('waveform.noAudioTrack'));
      showToast(t('toast.audioLoadFailed', { message: err.message }), 'error');
    }
  }

  function openForVideo(videoId) {
    if (open && currentVideoId === videoId) return;

    if (open) {
      // Switching videos mid-session: whatever was running belongs to the
      // previous video and must not bleed into the new one.
      cancelWorker();
      stopPreview();
    } else {
      sidenav.classList.add('slicer-takeover');
      open = true;
    }

    currentVideoId = videoId;
    const video = (store.get().videos || []).find((v) => v.videoId === videoId);
    videoTitleEl.textContent = video?.title || videoId;

    assignedMap.clear();
    selected.clear();
    currentSlices = [];
    hideOverlay();

    // Canvas gotcha: the takeover class was just added, making the panel
    // visible for the first time (or after being hidden) — resize()+draw()
    // must run now that layout is real, mirroring the Trim-tab pattern in
    // app.js's activateTab().
    const wf = ensureWaveform();
    wf.resize();
    wf.draw();
    wf.setMarkers([]);

    const cached = cache.get(videoId);
    if (cached) {
      sensitivityInput.value = String(cached.sensitivity);
      currentSlices = cached.slices;
    } else {
      sensitivityInput.value = String(DEFAULT_SENSITIVITY);
    }
    updateSensitivityLabel();
    renderResultsList();

    loadWaveformAudio(videoId, cached ? cached.slices : []);
  }

  function performClose() {
    cancelWorker();
    stopPreview();
    sidenav.classList.remove('slicer-takeover');
    if (waveform) {
      waveform.destroy();
      waveform = null;
    }
    open = false;
    currentVideoId = null;
    currentSlices = [];
    assignedMap.clear();
    selected.clear();
  }

  function openCloseConfirmModal() {
    if (closeModalOpen) return;
    closeModalOpen = true;

    let body;
    if (analyzing) {
      body = t('slicer.closeBodyBusy');
    } else if (assignedMap.size > 0) {
      body = t('slicer.closeBodyAssigned', { count: assignedMap.size });
    } else if (currentSlices.length > 0) {
      body = t('slicer.closeBodyUnassigned');
    } else {
      body = t('slicer.closeBodyIdle');
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'session-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'session-modal';
    modal.innerHTML = `
      <h3>${t('slicer.closeTitle')}</h3>
      <p class="session-modal-hint">${body}</p>
      <label class="settings-toggle-row">
        <input type="checkbox" id="slicer-close-dont-show">
        <span class="settings-label">${t('slicer.dontShowAgain')}</span>
      </label>
      <div class="session-modal-actions">
        <button class="btn btn-danger" id="slicer-close-confirm">${t('slicer.closeConfirmButton')}</button>
        <button class="btn btn-secondary" id="slicer-close-cancel">${t('common.cancel')}</button>
      </div>
      <button class="session-modal-close" id="slicer-close-modal-x" title="${t('common.cancel')}">&times;</button>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function cleanup() {
      if (modal.parentNode) modal.parentNode.removeChild(modal);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      window.removeEventListener('keydown', onKeydown);
      closeModalOpen = false;
    }
    function onKeydown(e) {
      if (e.key === 'Escape') cleanup();
    }

    modal.querySelector('#slicer-close-confirm').addEventListener('click', () => {
      if (modal.querySelector('#slicer-close-dont-show').checked) {
        localStorage.setItem(CLOSE_SKIP_CONFIRM_KEY, '1');
      }
      cleanup();
      performClose();
    });
    modal.querySelector('#slicer-close-cancel').addEventListener('click', cleanup);
    modal.querySelector('#slicer-close-modal-x').addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });
    window.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (!open) return;
    if (localStorage.getItem(CLOSE_SKIP_CONFIRM_KEY) === '1') {
      performClose();
      return;
    }
    openCloseConfirmModal();
  }

  closeBtn.addEventListener('click', close);

  sensitivityInput.addEventListener('input', updateSensitivityLabel);

  generateBtn.addEventListener('click', async () => {
    if (!currentVideoId || analyzing) return;
    let buffer;
    try {
      buffer = await audio.loadAudio(currentVideoId, api.getAudioUrl(currentVideoId));
    } catch (err) {
      showToast(t('toast.audioLoadFailed', { message: err.message }), 'error');
      return;
    }
    if (buffer.duration > LONG_AUDIO_THRESHOLD_SEC) {
      openConfirmModal({
        title: t('slicer.longAudioTitle'),
        body: t('slicer.longAudioBody'),
        confirmLabel: t('slicer.generate'),
        onConfirm: () => startAnalysis(buffer),
      });
    } else {
      startAnalysis(buffer);
    }
  });

  cancelBtn.addEventListener('click', () => cancelWorker());

  newSessionBtn.addEventListener('click', () => {
    if (selected.size === 0 || !currentVideoId) return;
    const indices = Array.from(selected).sort((a, b) => a - b);
    const count = indices.length;

    openConfirmModal({
      title: t('slicer.newSessionSelected'),
      body: t('slicer.newSessionConfirmBody', { count }),
      confirmLabel: t('slicer.newSessionSelected'),
      onConfirm: () => {
        const videoId = currentVideoId;
        sessionManager.clearWorkspace();
        // clearWorkspace() resets the grid to its default size (9) — grow it
        // back if more slices were selected than that, so pads.update() below
        // never writes to a position outside the live grid.
        if (pads.getCount() < count) {
          pads.resize(count);
          const gridSizeSelect = document.getElementById('grid-size');
          if (gridSizeSelect) gridSizeSelect.value = String(pads.getCount());
        }
        assignedMap.clear();
        indices.forEach((sliceIndex, i) => {
          const position = i + 1;
          const slice = currentSlices[sliceIndex];
          const padObject = buildSlicePadObject(position, videoId, slice, sliceIndex);
          pads.update(position, padObject);
          assignedMap.set(sliceIndex, position);
        });
        selected.clear();
        showToast(t('slicer.newSessionCreated', { count }), 'success');
        performClose();
      },
    });
  });

  return { openForVideo, isOpen, close };
}
