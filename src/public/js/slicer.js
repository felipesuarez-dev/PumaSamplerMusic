import { createWaveform } from './waveform.js';
import { formatTime, buildKeyCombo } from './state.js';
import {
  boundariesToSlices,
  slicesToBoundaries,
  moveBoundary,
  insertBoundary,
  removeBoundary,
  computeGridBoundaries,
  bpmFromLength,
} from './slicer-slices.js';
import { MIN_SLICE_SECONDS, snapToZeroCrossing } from './slicer-core.js';

const CLOSE_SKIP_CONFIRM_KEY = 'puma-slicer-skip-close-confirm';
const CHOP_KEY_STORAGE = 'puma-slicer-chop-key';
const DEFAULT_CHOP_KEY = ' '; // Space
const PLAY_KEY_STORAGE = 'puma-slicer-play-key';
const DEFAULT_PLAY_KEY = 'p';
const STOP_KEY_STORAGE = 'puma-slicer-stop-key';
const DEFAULT_STOP_KEY = 's';
const LONG_AUDIO_THRESHOLD_SEC = 10 * 60;
const DEFAULT_SENSITIVITY = 0.5;
const DEFAULT_PREVIEW_VOLUME_PCT = 50;
const DEFAULT_MODE = 'onsets';
const DEFAULT_METHOD = 'specflux';
const DEFAULT_GRID_BEATS = 16;
const DEFAULT_GRID_DIVISIONS = 4;
// Shuriken-derived cap: keeps a runaway beats*divisions config (e.g. 256*32)
// from generating tens of thousands of sub-minGap slices synchronously.
const GRID_SLICE_LIMIT = 512;
const UNDO_STACK_LIMIT = 30;
// Bounded zero-crossing scan radius applied when a dragged marker is
// committed (mouseup). Deliberately smaller than MIN_SLICE_SECONDS so the
// snap alone can never violate the min-gap invariant on its own -- the
// re-clamp inside moveBoundary (see handleMarkerMoved) is what catches the
// edge case where the snap lands a boundary exactly at/past a neighbor.
const MARKER_SNAP_RADIUS_SECONDS = 0.01;

// Full per-pad shape used whenever the slicer creates a pad from scratch
// (single assignment or "new session with selected"). Mirrors PAD_FX_DEFAULTS
// in src/services/session-store.js field-for-field, plus the base pad fields
// app.js's editor writes (label/videoId/start/end/volume/triggerMode/color/
// loop) — never spread from an existing pad, since there may not be one.
function buildSlicePadObject(position, videoId, slice, sliceIndex, bpm = 0) {
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
    // Source tempo of this slice (from Grid mode's BPM readout; 0 when unknown,
    // e.g. onset/manual chops). The global BPM knob stretches pads by this.
    bpm,
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
  const methodSelect = document.getElementById('slicer-method');
  const modeOnsetsBtn = document.getElementById('slicer-mode-onsets');
  const modeGridBtn = document.getElementById('slicer-mode-grid');
  const onsetControlsEl = document.getElementById('slicer-onset-controls');
  const gridControlsEl = document.getElementById('slicer-grid-controls');
  const gridBeatsInput = document.getElementById('slicer-grid-beats');
  const gridDivisionsInput = document.getElementById('slicer-grid-divisions');
  const gridBpmEl = document.getElementById('slicer-grid-bpm');
  const previewVolumeInput = document.getElementById('slicer-preview-volume');
  const previewVolumeValueEl = document.getElementById('slicer-preview-volume-value');
  const generateBtn = document.getElementById('slicer-generate-btn');
  const overlayEl = document.getElementById('slicer-overlay');
  const progressEl = document.getElementById('slicer-progress');
  const progressValueEl = document.getElementById('slicer-progress-value');
  const cancelBtn = document.getElementById('slicer-cancel-btn');
  const resultsHintEl = document.getElementById('slicer-results-hint');
  const listEl = document.getElementById('slicer-slice-list');
  const newSessionBtn = document.getElementById('slicer-new-session-btn');
  // Manual-chops entry: the same panel opened without the auto controls. These
  // are toggled as a group by applyEntryMode() so nothing auto-related shows.
  const panelTitleEl = document.getElementById('slicer-panel-title');
  const helpIconEl = document.getElementById('slicer-help-icon');
  const modeToggleEl = document.getElementById('slicer-mode-toggle');
  const generateRowEl = document.getElementById('slicer-generate-row');
  const manualControlsEl = document.getElementById('slicer-manual-controls');
  const manualClearBtn = document.getElementById('slicer-manual-clear');
  const manualPlayBtn = document.getElementById('slicer-manual-play');
  const manualPauseBtn = document.getElementById('slicer-manual-pause');
  const manualStopBtn = document.getElementById('slicer-manual-stop');
  const timeOverlayEl = document.getElementById('slicer-time-overlay');
  const overlayCaptionEl = document.getElementById('slicer-overlay-caption');
  // Configurable-key widgets (cut/play/stop) — manual-only, hidden in auto.
  const keyGroupEls = Array.from(document.querySelectorAll('.slicer-chop-key-group'));

  // Bail out gracefully if the shell markup isn't present (e.g. a stale
  // index.html during incremental rollout) instead of throwing on every
  // getElementById().addEventListener() below.
  if (!sidenav || !canvas || !overlayEl || !listEl) {
    return {
      openForVideo() {},
      openForVideoManual() {},
      isOpen: () => false,
      close() {},
      handleVideoRemoved() {},
    };
  }

  let open = false;
  let closing = false;
  let closeTimer = null;
  let currentVideoId = null;
  let waveform = null;
  let worker = null;
  let gen = 0;
  let analyzing = false;
  let closeModalOpen = false;
  // Load-phase state: `loading` while a track is downloading/decoding/rendering
  // (the overlay is reused, blocking the panel); `loadAbort` lets the overlay's
  // Cancel button abort an in-flight download.
  let loading = false;
  let loadAbort = null;

  // The decoded buffer backing the waveform, retained here because
  // startAnalysis only ever transfers a disposable copy of the channel data
  // to the worker -- nothing else keeps the original around. Needed for the
  // zero-crossing snap at marker-drag commit time (handleMarkerMoved).
  // Cleared on close and whenever the open video changes (see openForVideo).
  let currentAudioBuffer = null;

  // 'onsets' or 'grid' -- which controls row is visible and which path
  // Generate takes. Persisted per video in the cache entry (merged, never
  // replacing sensitivity/slices/method/gridBeats/gridDivisions).
  let mode = DEFAULT_MODE;

  // 'auto' or 'manual' -- how the panel was opened. Orthogonal to `mode`:
  // 'auto' is the Auto-Slicer (Onsets/Grid controls + Generate); 'manual' is
  // the Manual Chops entry, which hides all the auto controls and lets the
  // user place cuts on the waveform by hand. applyEntryMode() owns visibility.
  let entryMode = 'auto';

  // Bounded undo history of currentSlices snapshots, pushed right before a
  // mutation is known to happen (marker drag/add/delete, grid generate,
  // onset analysis result). Cleared on video switch and on close teardown.
  let undoStack = [];

  // One analysis per video PER ENTRY MODE, cached in memory only (never
  // per-pad) — reopening restores that mode's last state without re-running the
  // worker. Keyed by videoId + entryMode so Auto-Slicer and Manual Chops keep
  // fully independent state (cuts made in one never leak into the other).
  const cache = new Map(); // `${videoId}::${entryMode}` -> { sensitivity, slices, mode, gridBeats, gridDivisions, method }
  function cacheKey(videoId = currentVideoId, mode = entryMode) {
    return `${videoId}::${mode}`;
  }
  let currentSlices = [];
  const assignedMap = new Map(); // sliceIndex -> pad position, for the currently open video
  const selected = new Set(); // sliceIndex, for "new session with selected"

  let previewingIndex = null;
  let previewTimer = null;
  let previewAnimId = null;

  // Whole-track playback state (Manual Chops "Play" button). Independent of the
  // per-slice preview above: it plays start→duration and drives a continuous
  // playhead used both for the time overlay and for the keyboard "cut at
  // playhead" action.
  let fullPlaying = false;
  let paused = false;
  let fullAnimId = null;
  let fullTimer = null;
  // Live playhead time (seconds) shared by both playback paths, so the cut key
  // can drop a boundary exactly where the track is sounding.
  let currentPlayheadTime = 0;
  // Session-scoped only (resets to the default on reload) -- gain applied to
  // the preview voice (position 0), slider percent / 100 so 0..200% maps to
  // gain 0..2.
  let previewVolume = DEFAULT_PREVIEW_VOLUME_PCT / 100;

  function isOpen() {
    return open;
  }

  function ensureWaveform() {
    if (waveform) return waveform;
    waveform = createWaveform(canvas, {
      selectionEnabled: false,
      // Always bars here (locked against the global Settings preference): the
      // blocky envelope makes it easier to see where the peaks are when placing
      // cuts, in both Auto-Slicer and Manual Chops.
      style: 'bars',
      lockStyle: true,
      rulerCanvas,
      markersEditable: true,
      markerMinGapSeconds: MIN_SLICE_SECONDS,
      onMarkerChange: handleMarkerMoved,
      onMarkerAdd: handleMarkerAdded,
      onMarkerDelete: handleMarkerDeleted,
      onWaveformClick: auditionAtTime,
    });
    // The canvas title attribute is a simple, always-visible-on-hover way to
    // surface the drag/dblclick/right-click hint. Set it directly here so
    // it's visible immediately, and also mark it with data-i18n-title so
    // applyTranslations() (called on locale switch) re-queries the DOM and
    // refreshes it -- otherwise the hint would stay in the stale locale
    // after a language change since this canvas is created once and never
    // re-rendered.
    canvas.title = t('slicer.markerHint');
    canvas.setAttribute('data-i18n-title', 'slicer.markerHint');
    return waveform;
  }

  // Single commit funnel for every marker edit (drag/add/delete) and the
  // initial onset-analysis result: rebuilds currentSlices from the
  // boundaries, pushes them to the waveform, merges (never replaces) the
  // slices field into the per-video cache entry so other cached fields
  // (sensitivity, and future mode/method fields) survive, and re-renders the
  // results list.
  function applyBoundaries(boundaries) {
    currentSlices = boundariesToSlices(boundaries);
    if (waveform) waveform.setMarkers(boundaries);
    cache.set(cacheKey(), { ...(cache.get(cacheKey()) || {}), slices: currentSlices });
    renderResultsList();
  }

  // A marker index on the waveform maps 1:1 to a boundary index -- the
  // markers array IS the boundary array (see applyBoundaries).
  function handleMarkerMoved(index, time) {
    const boundaries = slicesToBoundaries(currentSlices);
    let snapped = time;
    if (currentAudioBuffer) {
      const data = currentAudioBuffer.getChannelData(0);
      const sampleRate = currentAudioBuffer.sampleRate;
      const sampleIndex = Math.round(time * sampleRate);
      const radiusSamples = Math.round(MARKER_SNAP_RADIUS_SECONDS * sampleRate);
      snapped = snapToZeroCrossing(data, sampleIndex, radiusSamples) / sampleRate;
    }
    // moveBoundary re-clamps to [left+minGap, right-minGap] (or no-ops if
    // the neighbors are too close together) -- this is what catches the
    // edge case where the (smaller-radius) zero-crossing snap lands the
    // boundary exactly at or past minGap from a neighbor.
    const moved = moveBoundary(boundaries, index, snapped, MIN_SLICE_SECONDS);
    if (moved === boundaries) return; // no-op guard: neighbors too close together
    pushUndoSnapshot(false);
    applyBoundaries(moved);
  }

  function handleMarkerAdded(time) {
    // previewingIndex is index-keyed into currentSlices, which is about to
    // be rebuilt with a different count/order -- stop first so a stale
    // index can never linger.
    stopPreview();
    const boundaries = slicesToBoundaries(currentSlices);
    const next = insertBoundary(boundaries, time, MIN_SLICE_SECONDS);
    if (!next) return; // rejected: too close to an existing boundary or the ends
    pushUndoSnapshot(true);
    assignedMap.clear();
    selected.clear();
    applyBoundaries(next);
  }

  function handleMarkerDeleted(index) {
    stopPreview();
    const boundaries = slicesToBoundaries(currentSlices);
    const next = removeBoundary(boundaries, index);
    if (next === boundaries) return; // no-op guard (index 0 / last)
    pushUndoSnapshot(true);
    assignedMap.clear();
    selected.clear();
    applyBoundaries(next);
  }

  // Bounded snapshot stack for Ctrl+Z -- pushed right before a mutation is
  // known to happen (after all reject/no-op guards have already passed), so
  // a no-op edit never pollutes the undo history with a duplicate state.
  // Each entry also carries `indexShifting` (whether the edit that's about to
  // happen changes slice indices/count) and the mode context active at push
  // time, so undo() can decide precisely what else needs to be restored.
  function pushUndoSnapshot(indexShifting) {
    // Sourced from the pre-mutation cache entry (not the live inputs): at
    // push time the cache still holds the config that produced the CURRENT
    // (pre-mutation) currentSlices, since every push site's cache.set(...)
    // with the NEW config runs AFTER this call (generateGrid, finishAnalysis).
    const prev = cache.get(cacheKey()) || {};
    undoStack.push({
      slices: currentSlices.map((s) => ({ ...s })),
      indexShifting,
      mode,
      gridBeats: mode === 'grid' ? prev.gridBeats : undefined,
      gridDivisions: mode === 'grid' ? prev.gridDivisions : undefined,
      sensitivity: mode === 'onsets' ? prev.sensitivity : undefined,
      method: mode === 'onsets' ? prev.method : undefined,
    });
    if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();
  }

  function undo() {
    if (analyzing) return;
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    stopPreview();
    // Index-shifting edits (add/delete/generate/analysis) can leave badges
    // pointing at the wrong slice, so they're cleared wholesale. A marker
    // drag never shifts indices -- pruneStaleAssignments() (called from
    // renderResultsList() inside applyBoundaries()) already surgically drops
    // only the badges that actually went stale.
    if (entry.indexShifting) {
      assignedMap.clear();
      selected.clear();
    }
    // Manual entry hides every auto control, so restoring the auto-config
    // inputs (and calling setMode, which un-hides an onset/grid row) would
    // resurrect chrome that should stay hidden. In manual, only the slices
    // themselves are undone.
    if (entryMode !== 'manual') {
      if (entry.mode !== mode) {
        setMode(entry.mode);
      }
      if (entry.mode === 'grid') {
        if (entry.gridBeats !== undefined) gridBeatsInput.value = entry.gridBeats;
        if (entry.gridDivisions !== undefined) gridDivisionsInput.value = entry.gridDivisions;
        updateGridBpmLabel();
      } else if (entry.mode === 'onsets') {
        if (entry.sensitivity !== undefined) {
          sensitivityInput.value = entry.sensitivity;
          updateSensitivityLabel();
        }
        if (entry.method !== undefined) methodSelect.value = entry.method;
      }
    }
    applyBoundaries(slicesToBoundaries(entry.slices));
    // Persist the restored config back into the cache -- applyBoundaries
    // already synced `slices` and setMode (when it ran) already synced
    // `mode`, but the gridBeats/gridDivisions/sensitivity/method fields
    // otherwise stay stale in the cache until the next Generate, so a video
    // switch away and back wouldn't reflect the undone state.
    if (currentVideoId) {
      const merged = { ...(cache.get(cacheKey()) || {}), mode: entry.mode };
      if (entry.gridBeats !== undefined) merged.gridBeats = entry.gridBeats;
      if (entry.gridDivisions !== undefined) merged.gridDivisions = entry.gridDivisions;
      if (entry.sensitivity !== undefined) merged.sensitivity = entry.sensitivity;
      if (entry.method !== undefined) merged.method = entry.method;
      cache.set(cacheKey(), merged);
    }
  }

  // Same input-focus convention as pads.js isInputFocused(): while a text
  // field/select is focused (e.g. the grid beats input), native browser
  // undo must keep working instead of being hijacked by our Ctrl+Z.
  function isInputFocused() {
    const active = document.activeElement;
    return Boolean(active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.classList.contains('key-capture')
    ));
  }

  // Registered in the CAPTURE phase (see openForVideo) so the cut key can
  // preventDefault + stopImmediatePropagation BEFORE the app-wide Space handler
  // (which toggles the pad-editor preview) and before the page scrolls.
  function handleSlicerKeydown(e) {
    if (isInputFocused()) return;
    // While a key-capture widget is listening, let it (and only it) receive the
    // press — otherwise pressing the key you're rebinding would also fire the
    // transport/cut here. The app-level isCapturingKey isn't visible from this
    // module, so detect the listening widget in the DOM.
    if (document.querySelector('.key-capture.listening')) return;

    const key = e.key ? e.key.toLowerCase() : '';
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    const combo = buildKeyCombo(e).toLowerCase();

    // Play/Stop keys (manual-only transport). Configurable; defaults P and S.
    if (entryMode === 'manual') {
      const playKey = (localStorage.getItem(PLAY_KEY_STORAGE) || DEFAULT_PLAY_KEY).toLowerCase();
      const stopKey = (localStorage.getItem(STOP_KEY_STORAGE) || DEFAULT_STOP_KEY).toLowerCase();
      if (combo === playKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (fullPlaying) pauseFullTrack(); else playFullTrack();
        return;
      }
      if (combo === stopKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stopFullTrack();
        return;
      }
    }

    // Cut-at-playhead key (configurable, Space by default). Only while the
    // track is actually playing/paused, so there is a real playhead to cut at.
    const chopKey = (localStorage.getItem(CHOP_KEY_STORAGE) || DEFAULT_CHOP_KEY).toLowerCase();
    if (combo === chopKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (fullPlaying || paused || previewingIndex !== null) {
        // Verbatim insert (no zero-crossing snap) so the cut lands exactly at
        // the playhead. insertBoundary no-ops if it's within MIN_SLICE_SECONDS
        // of an existing boundary. Also works while paused (playhead frozen).
        handleMarkerAdded(currentPlayheadTime);
      }
    }
  }

  // Click-to-audition: finds the slice containing `time` and toggles its
  // preview, reusing togglePreview's start/stop logic so the results-list
  // row button and the waveform playhead animation stay in sync regardless
  // of whether playback was triggered from the list or the waveform.
  function auditionAtTime(time) {
    if (!currentSlices.length) return;
    const index = currentSlices.findIndex((slice) => time >= slice.start && time < slice.end);
    if (index === -1) return;
    togglePreview(index, currentSlices[index]);
  }

  // Reflects the slider into the editable number input. Setting .value
  // programmatically does not fire 'input', so this never loops with
  // onSensitivityNumberInput below.
  function updateSensitivityLabel() {
    sensitivityValueEl.value = parseFloat(sensitivityInput.value).toFixed(2);
  }

  // The reverse direction: typing an exact value drives the slider (the range
  // stays the source of truth read by startAnalysis). Clamped to [0, 1].
  function onSensitivityNumberInput() {
    const v = parseFloat(sensitivityValueEl.value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(1, v));
    sensitivityInput.value = String(clamped);
  }

  // Updates the module-scoped gain from the slider, refreshes the value
  // label, and -- when a preview is currently playing -- pushes the change
  // live to the engine so dragging the slider is audible immediately instead
  // of only taking effect on the next preview.
  function updatePreviewVolume() {
    const pct = parseInt(previewVolumeInput.value, 10);
    previewVolumeValueEl.textContent = `${pct}%`;
    previewVolume = pct / 100;
    if (previewingIndex !== null) {
      audio.setVoiceVolume(0, previewVolume);
    }
  }

  // Toggles between the Onsets and Grid controls rows, mirrors the active
  // state onto both segmented buttons, and merges the new mode into the
  // per-video cache entry (never replaces sensitivity/slices/method/grid*).
  function setMode(next) {
    mode = next === 'grid' ? 'grid' : 'onsets';
    const isGrid = mode === 'grid';
    onsetControlsEl.hidden = isGrid;
    gridControlsEl.hidden = !isGrid;
    modeOnsetsBtn.classList.toggle('active', !isGrid);
    modeOnsetsBtn.setAttribute('aria-pressed', String(!isGrid));
    modeGridBtn.classList.toggle('active', isGrid);
    modeGridBtn.setAttribute('aria-pressed', String(isGrid));
    if (currentVideoId) {
      cache.set(cacheKey(), { ...(cache.get(cacheKey()) || {}), mode });
    }
  }

  // Shows/hides the auto-only chrome (mode toggle, onset/grid rows, Generate)
  // vs the manual toolbar, and swaps the panel title + help tooltip. Called on
  // every open so switching between the Auto and Manual scissors on the same
  // video re-dresses the shared panel. In auto it defers row visibility to
  // setMode(mode); in manual it force-hides both auto rows.
  function applyEntryMode() {
    const isManual = entryMode === 'manual';
    if (modeToggleEl) modeToggleEl.hidden = isManual;
    if (generateRowEl) generateRowEl.hidden = isManual;
    if (manualControlsEl) manualControlsEl.hidden = !isManual;
    // Cut/play/stop key widgets are Manual-Chops-only (the Auto-Slicer generates
    // cuts automatically and has no full-track transport).
    keyGroupEls.forEach((g) => { g.hidden = !isManual; });
    if (isManual) {
      onsetControlsEl.hidden = true;
      gridControlsEl.hidden = true;
    } else {
      setMode(mode);
    }
    const titleKey = isManual ? 'chops.title' : 'slicer.title';
    const helpKey = isManual ? 'tip.chopsHelp' : 'tip.slicerHelp';
    if (panelTitleEl) {
      panelTitleEl.dataset.i18n = titleKey;
      panelTitleEl.textContent = t(titleKey);
    }
    if (helpIconEl) {
      helpIconEl.dataset.i18nTooltip = helpKey;
      helpIconEl.dataset.tooltip = t(helpKey);
    }
  }

  // Manual toolbar action: collapse every cut back to a single whole-track
  // slice so the user can start chopping again from scratch. Same undo/preview
  // hygiene as generateGrid().
  function clearManualCuts() {
    if (!currentVideoId || !currentAudioBuffer) return;
    stopPreview();
    pushUndoSnapshot(true);
    assignedMap.clear();
    selected.clear();
    applyBoundaries([0, currentAudioBuffer.duration]);
  }

  // Single place that flips the analyzing flag, so the mode toggle is always
  // disabled in lockstep with it -- prevents a late worker `done` message
  // from landing after the user switched to Grid mid-analysis (the toggle
  // being unclickable means the mode literally cannot change mid-flight).
  function setAnalyzing(value) {
    analyzing = value;
    modeOnsetsBtn.disabled = value;
    modeGridBtn.disabled = value;
  }

  // Live BPM readout for Grid mode (beats / minutes over the loaded track).
  // Shows a placeholder until the buffer is decoded or the beats field holds
  // an invalid value.
  function updateGridBpmLabel() {
    const beats = parseInt(gridBeatsInput.value, 10);
    if (!currentAudioBuffer || !Number.isFinite(beats) || beats < 1 || currentAudioBuffer.duration <= 0) {
      gridBpmEl.textContent = '— BPM';
      return;
    }
    gridBpmEl.textContent = `${bpmFromLength(beats, currentAudioBuffer.duration).toFixed(1)} BPM`;
  }

  // Source BPM stamped onto pads when slices are assigned. Only Grid mode knows
  // a tempo (beats over the track length); Onsets/manual leave it 0 (unknown),
  // which the global BPM knob treats as "don't stretch".
  function currentSliceBpm() {
    if (mode !== 'grid') return 0;
    const beats = parseInt(gridBeatsInput.value, 10);
    if (!currentAudioBuffer || !Number.isFinite(beats) || beats < 1 || currentAudioBuffer.duration <= 0) return 0;
    return Math.round(bpmFromLength(beats, currentAudioBuffer.duration) * 10) / 10;
  }

  // Grid mode's Generate path: synchronous (no worker/overlay/long-audio
  // confirm) since computeGridBoundaries is O(n) pure arithmetic. Guards
  // mirror the ones baked into the editing layer (minGap) plus a hard cap on
  // total slice count so a runaway beats*divisions config can't hang the
  // main thread building thousands of DOM rows.
  function generateGrid() {
    if (!currentVideoId) return;
    const beats = parseInt(gridBeatsInput.value, 10);
    const divisions = parseInt(gridDivisionsInput.value, 10);
    if (!Number.isFinite(beats) || !Number.isFinite(divisions) || beats < 1 || divisions < 1) return;
    if (beats * divisions > GRID_SLICE_LIMIT) {
      showToast(t('slicer.gridSliceLimit'), 'warning');
      return;
    }
    if (!currentAudioBuffer) {
      showToast(t('slicer.audioNotReady'), 'warning');
      return;
    }
    const duration = currentAudioBuffer.duration;
    if (duration / (beats * divisions) < MIN_SLICE_SECONDS) {
      showToast(t('slicer.gridTooDense'), 'warning');
      return;
    }
    pushUndoSnapshot(true);
    stopPreview();
    assignedMap.clear();
    selected.clear();
    applyBoundaries(computeGridBoundaries(duration, beats, divisions));
    cache.set(cacheKey(), {
      ...(cache.get(cacheKey()) || {}),
      mode: 'grid',
      gridBeats: beats,
      gridDivisions: divisions,
    });
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
    setAnalyzing(false);
    hideOverlay();
  }

  // The results-list preview button is looked up by data-index at call time
  // instead of caching a DOM reference -- renderResultsList() rebuilds the
  // whole list (e.g. on any marker edit) which would otherwise leave a
  // cached button element stale/detached.
  function getPreviewButtonEl(index) {
    return listEl.querySelector(`.slice-preview-btn[data-index="${index}"]`);
  }

  function setPreviewButtonIcon(index, playing) {
    const btnEl = getPreviewButtonEl(index);
    if (!btnEl) return;
    btnEl.innerHTML = playing
      ? '<span class="material-symbols-outlined">stop</span>'
      : '<span class="material-symbols-outlined">play_arrow</span>';
  }

  function cancelPreviewAnimation() {
    if (previewAnimId !== null) {
      cancelAnimationFrame(previewAnimId);
      previewAnimId = null;
    }
  }

  // Single funnel for the live playhead: updates the shared time (read by the
  // cut key), moves the waveform playhead, and refreshes the time overlay
  // (same MM:SS.mmm format as the video display).
  function setPlayheadTime(time) {
    // A playhead is always within the track; clamp defensively so a stray
    // negative/overflow can never reach formatTime (which renders negatives as
    // garbage) or land a cut at a rejected position.
    const dur = currentAudioBuffer ? currentAudioBuffer.duration : 0;
    const clamped = Math.max(0, Math.min(dur || time, time));
    currentPlayheadTime = clamped;
    if (waveform) waveform.setPlayhead(clamped);
    if (timeOverlayEl) timeOverlayEl.textContent = formatTime(clamped);
  }

  // Animates the waveform playhead across the previewing slice for the
  // duration of playback, using wall-clock deltas (performance.now()) rather
  // than an audio-clock query -- good enough for a purely visual cue.
  function startPreviewAnimation(slice) {
    cancelPreviewAnimation();
    const startedAt = performance.now();
    const durationMs = Math.max(0, slice.end - slice.start) * 1000;
    const step = (now) => {
      const elapsedMs = now - startedAt;
      // Prefer the real audio-clock position (voice 0 = scratch); fall back to
      // the wall-clock estimate if the voice isn't reporting yet. This keeps
      // the playhead aligned with the audible sound instead of drifting.
      const wall = Math.min(slice.end, slice.start + elapsedMs / 1000);
      const time = audio.getVoiceTime(0) ?? wall;
      setPlayheadTime(time);
      if (elapsedMs < durationMs) {
        previewAnimId = requestAnimationFrame(step);
      } else {
        previewAnimId = null;
      }
    };
    previewAnimId = requestAnimationFrame(step);
  }

  function stopPreview() {
    if (previewingIndex === null) return;
    clearTimeout(previewTimer);
    cancelPreviewAnimation();
    audio.stop(0);
    setPreviewButtonIcon(previewingIndex, false);
    previewingIndex = null;
  }

  // Transport button visibility (play/pause swap + separate stop), mirroring the
  // pad-editor transport (app.js setTransportState). `state`: 'playing' shows
  // pause; 'idle'/'paused' show play.
  function setTransportState(state) {
    const playing = state === 'playing';
    if (manualPlayBtn) manualPlayBtn.classList.toggle('hidden', playing);
    if (manualPauseBtn) manualPauseBtn.classList.toggle('hidden', !playing);
  }

  // Whole-track playback for Manual Chops: plays through the scratch voice
  // (position 0), driving a continuous playhead so the user can drop cuts with
  // the cut key while listening. Web Audio can't resume a stopped BufferSource,
  // so pause = stop + remember offset, resume = a fresh play() from that offset.
  function startFullPlayback(fromOffset) {
    const duration = currentAudioBuffer.duration;
    const resumeFrom = Math.max(0, Math.min(duration, fromOffset || 0));
    fullPlaying = true;
    paused = false;
    setTransportState('playing');
    audio.play(0, { videoId: currentVideoId, start: resumeFrom, end: duration, volume: previewVolume }).catch(() => {});
    const startedAt = performance.now();
    const step = (now) => {
      if (!fullPlaying) return;
      // Real audio-clock position (voice 0), wall-clock as fallback, so the
      // playhead tracks the audible sound rather than drifting from it.
      const wall = Math.min(duration, resumeFrom + (now - startedAt) / 1000);
      const time = audio.getVoiceTime(0) ?? wall;
      setPlayheadTime(time);
      // End on the WALL-CLOCK only: the latency-compensated getVoiceTime now
      // sits slightly BEHIND the wall-clock, so gating on `time` would let the
      // loop overrun; gating on `wall` stops exactly when the track's duration
      // has elapsed without clipping the tail.
      if (wall < duration) {
        fullAnimId = requestAnimationFrame(step);
      } else {
        stopFullTrack();
      }
    };
    fullAnimId = requestAnimationFrame(step);
    // Safety timer over the REMAINING duration (not the full track).
    fullTimer = setTimeout(() => stopFullTrack(), (duration - resumeFrom) * 1000 + 80);
  }

  // Play button: start from 0, or resume from the frozen playhead if paused.
  function playFullTrack() {
    if (!currentVideoId || !currentAudioBuffer || fullPlaying) return;
    stopPreview();
    startFullPlayback(paused ? currentPlayheadTime : 0);
  }

  // Pause: stop the voice + freeze the playhead where it is (currentPlayheadTime
  // is already up to date via setPlayheadTime). Keep `paused` so Play resumes.
  function pauseFullTrack() {
    if (!fullPlaying) return;
    fullPlaying = false;
    paused = true;
    if (fullAnimId !== null) { cancelAnimationFrame(fullAnimId); fullAnimId = null; }
    clearTimeout(fullTimer);
    audio.stop(0);
    setTransportState('paused');
  }

  // Stop: halt AND rewind to 0. The guard also covers the paused state (and all
  // teardown call sites) — without `!paused`, Stop-while-paused would no-op and
  // leak a stale `paused` into the next play.
  function stopFullTrack() {
    if (!fullPlaying && !paused) return;
    fullPlaying = false;
    paused = false;
    if (fullAnimId !== null) { cancelAnimationFrame(fullAnimId); fullAnimId = null; }
    clearTimeout(fullTimer);
    audio.stop(0);
    setPlayheadTime(0);
    setTransportState('idle');
  }

  function togglePreview(index, slice) {
    stopFullTrack(); // per-slice preview and full-track share voice 0
    if (previewingIndex === index) {
      stopPreview();
      return;
    }
    stopPreview();
    previewingIndex = index;
    setPreviewButtonIcon(index, true);
    // Position 0 is never a real pad (pads are 1..N) — a dedicated scratch
    // voice slot for slice preview, stopped the same way any pad is (stop(0)).
    audio.play(0, { videoId: currentVideoId, start: slice.start, end: slice.end, volume: previewVolume }).catch(() => {});
    const durationMs = Math.max(0, slice.end - slice.start) * 1000;
    previewTimer = setTimeout(() => {
      if (previewingIndex === index) stopPreview();
    }, durationMs + 60);
    startPreviewAnimation(slice);
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
    const padObject = buildSlicePadObject(position, currentVideoId, slice, sliceIndex, currentSliceBpm());
    pads.update(position, padObject);
    // A PAD position can only carry one slice's badge at a time. If another
    // slice row was previously assigned to this same position, that PAD was
    // just overwritten out from under it -- drop its now-stale entry so it
    // loses its badge instead of falsely claiming the assignment.
    for (const [otherIndex, otherPosition] of assignedMap) {
      if (otherPosition === position && otherIndex !== sliceIndex) {
        assignedMap.delete(otherIndex);
      }
    }
    assignedMap.set(sliceIndex, position);
    showToast(t('slicer.assigned', { position }), 'success');
    renderResultsList();
  }

  // A slice's assignedMap entry can go stale without going through
  // doAssign -- e.g. the pad editor reassigns/clears that PAD directly, a
  // session load replaces it, or the grid was resized smaller. Drop any
  // entry whose PAD no longer actually holds that exact slice (matched by
  // video + start/end) so the results list never shows a badge for an
  // assignment that isn't really there anymore.
  function pruneStaleAssignments() {
    const count = pads.getCount();
    for (const [sliceIndex, position] of [...assignedMap]) {
      const slice = currentSlices[sliceIndex];
      const data = position > count ? null : pads.getData(position);
      const stillValid = Boolean(
        slice && data
        && data.videoId === currentVideoId
        && data.start === slice.start
        && data.end === slice.end,
      );
      if (!stillValid) {
        assignedMap.delete(sliceIndex);
      }
    }
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
    pruneStaleAssignments();

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
      previewBtn.dataset.index = String(index);
      previewBtn.innerHTML = previewingIndex === index
        ? '<span class="material-symbols-outlined">stop</span>'
        : '<span class="material-symbols-outlined">play_arrow</span>';
      previewBtn.addEventListener('click', () => togglePreview(index, slice));

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

  function finishAnalysis(sensitivity, method, slices) {
    setAnalyzing(false);
    hideOverlay();
    terminateWorker();
    // Pushed before currentSlices is overwritten below, so Ctrl+Z after a
    // fresh Generate restores whatever slices (possibly none) existed prior
    // to this analysis.
    pushUndoSnapshot(true);
    cache.set(cacheKey(), { ...(cache.get(cacheKey()) || {}), sensitivity, method, slices });
    currentSlices = slices;
    assignedMap.clear();
    selected.clear();
    if (waveform) waveform.setMarkers(slicesToBoundaries(slices));
    renderResultsList();
  }

  function failAnalysis(message) {
    setAnalyzing(false);
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
    setAnalyzing(true);
    setProgress(0);
    setOverlayCaption('slicer.analyzing');
    showOverlay();

    const sensitivity = parseFloat(sensitivityInput.value);
    const method = methodSelect.value;
    const channelDataCopy = buffer.getChannelData(0).slice();

    let w;
    try {
      w = new Worker('/js/slicer-worker.js', { type: 'module' });
    } catch {
      setAnalyzing(false);
      hideOverlay();
      showToast(t('slicer.workerUnavailable'), 'error');
      return;
    }
    worker = w;

    w.onmessage = (event) => {
      // Both `worker` and `myGen` are fixed per this call, so `data.gen !==
      // myGen` can never be true for messages from this same worker `w` --
      // it was a dead check. The live-identity guard below (mirroring
      // onerror) is what actually rejects a zombie message from a
      // terminate()d worker that could otherwise corrupt the cache for a
      // newly opened video.
      if (worker !== w) return;
      const data = event.data || {};
      if (data.type === 'progress') {
        setProgress(data.value);
      } else if (data.type === 'done') {
        finishAnalysis(sensitivity, method, data.slices);
      } else if (data.type === 'error') {
        failAnalysis(data.message);
      }
    };
    w.onerror = () => {
      if (worker !== w) return;
      failAnalysis();
    };

    w.postMessage(
      { channelData: channelDataCopy, sampleRate: buffer.sampleRate, sensitivity, method, gen: myGen },
      [channelDataCopy.buffer],
    );
  }

  // Sets the shared overlay caption (also used by onset analysis). Keeps the
  // data-i18n attr in sync so a locale switch re-translates it.
  function setOverlayCaption(key) {
    if (!overlayCaptionEl) return;
    overlayCaptionEl.dataset.i18n = key;
    overlayCaptionEl.textContent = t(key);
  }

  // Resolves after the browser has painted: a single rAF fires BEFORE the
  // repaint, so a lone rAF wouldn't let the "Rendering…" caption show before
  // the synchronous peak build blocks the main thread. Double-rAF does.
  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function loadWaveformAudio(videoId, cachedSlices) {
    const wf = ensureWaveform();
    wf.setLoading();
    loading = true;
    loadAbort = new AbortController();
    setProgress(0);
    setOverlayCaption('slicer.loadingDownload');
    // Show the overlay + spinner IMMEDIATELY (no delay-gate) so loading a big
    // track gives instant feedback. A cached re-open flashes it for a frame —
    // acceptable per the immediacy the user asked for.
    showOverlay();
    let completed = false;
    try {
      // Phase weighting (determinate, no flicker): download fills 0→60% (real
      // fraction), decode holds at 60% (atomic, unmeasurable), and the chunked
      // peak build fills 60→100% (real) — render gets a wide-enough band to
      // visibly animate instead of snapping from 70% to gone.
      const buffer = await audio.loadAudio(
        videoId,
        api.getAudioUrl(videoId),
        (f) => { if (currentVideoId === videoId) setProgress(f * 0.60); },
        loadAbort.signal,
      );
      if (currentVideoId !== videoId || !waveform) return; // switched away mid-load
      // Download resolved; decodeAudioData already ran inside loadAudio. Move to
      // the render phase and build the peak cache in chunks so the bar keeps
      // advancing instead of freezing.
      setOverlayCaption('slicer.loadingRender');
      setProgress(0.60);
      await nextPaint();
      if (currentVideoId !== videoId || !waveform) return;
      await waveform.setAudioBufferAsync(buffer, {
        onProgress: (f) => { if (currentVideoId === videoId) setProgress(0.60 + f * 0.40); },
        signal: loadAbort ? loadAbort.signal : undefined,
      });
      if (currentVideoId !== videoId || !waveform) return;
      currentAudioBuffer = buffer;
      updateGridBpmLabel();
      if (cachedSlices.length) {
        waveform.setMarkers(slicesToBoundaries(cachedSlices));
      } else if (entryMode === 'manual') {
        // Seed a single whole-track slice so the [0, duration] anchors exist
        // for double-click insertBoundary() to work. Not written to the cache,
        // so reopening in Auto still starts empty. Once the user places cuts,
        // applyBoundaries() takes over caching.
        currentSlices = [{ start: 0, end: buffer.duration }];
        waveform.setMarkers([0, buffer.duration]);
        renderResultsList();
      }
      completed = true;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        wf.setEmpty(t('waveform.selectVideo')); // user cancelled the load
      } else if (currentVideoId === videoId && waveform) {
        waveform.setEmpty(t('waveform.noAudioTrack'));
        showToast(t('toast.audioLoadFailed', { message: err.message }), 'error');
      }
    } finally {
      loading = false;
      loadAbort = null;
      // On a clean completion, snap to 100% and hold briefly so the bar is
      // visibly seen filling before the overlay closes (the render phase can
      // finish in a few chunks on short tracks). On abort/error, hide at once.
      if (completed) {
        setProgress(1);
        await new Promise((r) => setTimeout(r, 140));
      }
      hideOverlay();
      setOverlayCaption('slicer.analyzing'); // restore default for onset analysis
    }
  }

  function openForVideo(videoId, requestedEntry = 'auto') {
    // Re-opening while the exit animation is still playing: finish the
    // pending teardown synchronously so the two states can't overlap.
    if (closing) finishClose();

    // The guard now also compares entryMode: clicking the Manual scissors on a
    // video already open in Auto (or vice versa) must re-dress the panel, not
    // early-return.
    if (open && currentVideoId === videoId && entryMode === requestedEntry) return;
    entryMode = requestedEntry === 'manual' ? 'manual' : 'auto';

    if (open) {
      // Switching videos mid-session: whatever was running belongs to the
      // previous video and must not bleed into the new one.
      cancelWorker();
      stopPreview();
      stopFullTrack();
    } else {
      sidenav.classList.add('slicer-takeover');
      open = true;
      // Capture phase so the cut key preempts the app-wide Space handler.
      // Symmetric with the removeEventListener in finishClose() -- added
      // once per open takeover, not per video switch within it.
      window.addEventListener('keydown', handleSlicerKeydown, true);
    }
    paused = false;
    setTransportState('idle');
    if (timeOverlayEl) timeOverlayEl.textContent = formatTime(0);
    currentPlayheadTime = 0;

    currentVideoId = videoId;
    // Invalidate the retained buffer immediately -- it belongs to whatever
    // video was open before (or is stale on a fresh open); loadWaveformAudio
    // repopulates it once the new video's audio is actually decoded.
    currentAudioBuffer = null;
    const video = (store.get().videos || []).find((v) => v.videoId === videoId);
    videoTitleEl.textContent = video?.title || videoId;

    assignedMap.clear();
    selected.clear();
    currentSlices = [];
    undoStack.length = 0;
    hideOverlay();

    // Canvas gotcha: the takeover class was just added, making the panel
    // visible for the first time (or after being hidden) — resize()+draw()
    // must run now that layout is real, mirroring the Trim-tab pattern in
    // app.js's activateTab().
    const wf = ensureWaveform();
    wf.resize();
    wf.draw();
    wf.setMarkers([]);

    // Every field below is independently optional in a cache entry -- e.g.
    // a video whose only history is a grid generate has gridBeats/gridDivisions
    // but no sensitivity/method, and vice versa -- so each is only applied to
    // its input when actually defined, instead of stamping "undefined" in.
    const cached = cache.get(cacheKey(videoId));
    sensitivityInput.value = String(cached && cached.sensitivity !== undefined ? cached.sensitivity : DEFAULT_SENSITIVITY);
    methodSelect.value = cached && cached.method !== undefined ? cached.method : DEFAULT_METHOD;
    gridBeatsInput.value = String(cached && cached.gridBeats !== undefined ? cached.gridBeats : DEFAULT_GRID_BEATS);
    gridDivisionsInput.value = String(cached && cached.gridDivisions !== undefined ? cached.gridDivisions : DEFAULT_GRID_DIVISIONS);
    // A cache entry can exist with a mode but no slices (e.g. the user opened
    // the video, switched Onsets/Grid tabs -- which caches the mode -- then
    // closed without generating). Guard so renderResultsList's currentSlices
    // .length never dereferences undefined on reopen.
    currentSlices = (cached && cached.slices) ? cached.slices : [];
    setMode(cached && cached.mode !== undefined ? cached.mode : DEFAULT_MODE);
    // After setMode has set the auto row visibility, applyEntryMode overrides
    // it for manual (hiding both rows + the toggle/Generate, showing the manual
    // toolbar) and swaps the title/help.
    applyEntryMode();
    updateSensitivityLabel();
    updateGridBpmLabel();
    renderResultsList();

    loadWaveformAudio(videoId, (cached && cached.slices) ? cached.slices : []);
  }

  // Manual Chops entry point: same panel, opened without the auto controls.
  function openForVideoManual(videoId) {
    openForVideo(videoId, 'manual');
  }

  function finishClose() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    closing = false;
    sidenav.classList.remove('slicer-takeover', 'slicer-closing');
    window.removeEventListener('keydown', handleSlicerKeydown, true);
    stopFullTrack();
    if (waveform) {
      waveform.destroy();
      waveform = null;
    }
    open = false;
    currentVideoId = null;
    currentSlices = [];
    currentAudioBuffer = null;
    undoStack.length = 0;
    assignedMap.clear();
    selected.clear();
    entryMode = 'auto';
  }

  function performClose() {
    if (closing) return;
    // Logic stops immediately; only the visual teardown waits for the exit
    // animation (mirror of slicerTakeoverIn, shrinking back to the right).
    cancelWorker();
    stopPreview();
    stopFullTrack();
    closing = true;
    sidenav.classList.add('slicer-closing');
    const onEnd = (e) => {
      if (e.target !== sidenav) return;
      sidenav.removeEventListener('animationend', onEnd);
      finishClose();
    };
    sidenav.addEventListener('animationend', onEnd);
    // Fallback in case animationend never fires (e.g. reduced motion).
    closeTimer = setTimeout(() => {
      sidenav.removeEventListener('animationend', onEnd);
      finishClose();
    }, 300);
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

  // Called when a video is deleted (WS `video:removed` or the local delete
  // path) while it may still be cached or open in the takeover. The video's
  // audio no longer exists server-side, so there is nothing left to confirm
  // -- performClose() already terminates any running worker and tears down
  // the waveform/preview, so this just skips the usual close-confirm modal
  // and tells the user why the panel closed.
  function handleVideoRemoved(videoId) {
    // Both entry-mode variants must go — the video's audio is gone server-side.
    cache.delete(cacheKey(videoId, 'auto'));
    cache.delete(cacheKey(videoId, 'manual'));
    if (open && currentVideoId === videoId) {
      performClose();
      showToast(t('slicer.videoRemoved'), 'info');
    }
  }

  closeBtn.addEventListener('click', close);

  sensitivityInput.addEventListener('input', updateSensitivityLabel);
  sensitivityValueEl.addEventListener('input', onSensitivityNumberInput);
  // Normalize/clamp the displayed number when the user commits (blur/enter).
  sensitivityValueEl.addEventListener('change', () => {
    onSensitivityNumberInput();
    updateSensitivityLabel();
  });
  previewVolumeInput.addEventListener('input', updatePreviewVolume);

  modeOnsetsBtn.addEventListener('click', () => {
    if (analyzing) return; // also hard-disabled while analyzing, this is belt-and-suspenders
    setMode('onsets');
  });
  modeGridBtn.addEventListener('click', () => {
    if (analyzing) return;
    setMode('grid');
  });
  gridBeatsInput.addEventListener('input', updateGridBpmLabel);
  gridDivisionsInput.addEventListener('change', updateGridBpmLabel);

  generateBtn.addEventListener('click', async () => {
    if (!currentVideoId || analyzing) return;
    if (mode === 'grid') {
      generateGrid();
      return;
    }
    // Claim the busy flag synchronously, before the audio-load await below.
    // `analyzing` was previously only flipped inside startAnalysis(), which
    // runs after this await -- two rapid clicks both read it as false and
    // both proceed, firing overlapping loads/analyses. Early-return paths
    // below restore it since no analysis actually started in that case.
    setAnalyzing(true);
    let buffer;
    try {
      buffer = await audio.loadAudio(currentVideoId, api.getAudioUrl(currentVideoId));
    } catch (err) {
      setAnalyzing(false);
      showToast(t('toast.audioLoadFailed', { message: err.message }), 'error');
      return;
    }
    if (buffer.duration > LONG_AUDIO_THRESHOLD_SEC) {
      // Not analyzing yet -- only if/when the user confirms does
      // startAnalysis() (and its own setAnalyzing(true)) actually run.
      setAnalyzing(false);
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

  // The overlay's Cancel serves two phases: aborting an in-flight load, or
  // cancelling onset analysis. Branch on which is active.
  cancelBtn.addEventListener('click', () => {
    if (loading && loadAbort) {
      loadAbort.abort();
      return;
    }
    cancelWorker();
  });

  if (manualClearBtn) manualClearBtn.addEventListener('click', clearManualCuts);
  if (manualPlayBtn) manualPlayBtn.addEventListener('click', playFullTrack);
  if (manualPauseBtn) manualPauseBtn.addEventListener('click', pauseFullTrack);
  if (manualStopBtn) manualStopBtn.addEventListener('click', stopFullTrack);

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
          const padObject = buildSlicePadObject(position, videoId, slice, sliceIndex, currentSliceBpm());
          pads.update(position, padObject);
          assignedMap.set(sliceIndex, position);
        });
        selected.clear();
        showToast(t('slicer.newSessionCreated', { count }), 'success');
        performClose();
      },
    });
  });

  return { openForVideo, openForVideoManual, isOpen, close, handleVideoRemoved };
}
