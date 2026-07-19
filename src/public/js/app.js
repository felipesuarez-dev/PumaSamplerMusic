import { api } from './api.js';
import { createStore, buildKeyCombo, formatTime, parseTime } from './state.js';
import { createWebSocketClient } from './ws-client.js';
import { createAudioEngine } from './audio-engine.js';
import { createVideoDisplay } from './video-display.js';
import { createPads } from './pads.js';
import { createWaveform } from './waveform.js';
import { createSessionManager } from './session.js';
import { createSlicer } from './slicer.js';
import { t, getLocale, setLocale, applyTranslations } from './i18n.js';
import { enhanceKnobs } from './knob.js';

// Duplicated from src/utils/validation.js (server-only, not servable over
// HTTP since only src/public is exposed as static content) so the client can
// reject a non-YouTube URL before a round-trip to the server. Keep these
// patterns in sync with that file if they ever change.
const YT_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
  /^https?:\/\/(www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /^https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/,
];
const isValidYouTubeUrl = (url) => YT_PATTERNS.some((p) => p.test(url));

const store = createStore({
  videos: [],
  activeDownloads: [],
  selectedPosition: null,
  currentPad: null,
});

const ws = createWebSocketClient();
const audio = createAudioEngine();
window.addEventListener('audioworkletfallback', () => showToast(t('toast.pitchFallbackActive'), 'info'));
const videoDisplay = createVideoDisplay(document.getElementById('video-player'));
const toastEl = document.getElementById('toast');
let editorWaveform = null;
let padEditorActiveTab = 'general';
let isCapturingKey = false;
let masterFxControls = null;
let padFxControls = null;
// Populated once all collapsible toggles exist (see "Initial load" below);
// referenced by syncAllToggles(), which is called after every
// applyTranslations(document) to fix stale state-aware titles.
let syncableToggles = [];

const STOP_KEY_STORAGE = 'puma-stop-key';
const PREVIEW_VOLUME_STORAGE = 'puma-preview-volume';
const HEADER_HIDDEN_STORAGE = 'puma-header-hidden';
const FONT_SCALE_STORAGE = 'puma-font-scale';
const FONT_SCALE_DEFAULT = 16;
const FONT_SCALE_MIN = 12;
const FONT_SCALE_MAX = 22;
const AUTOSAVE_ENABLED_STORAGE = 'puma-autosave-enabled';
const AUTOSAVE_MODE_STORAGE = 'puma-autosave-mode'; // 'change' | 'interval'
const AUTOSAVE_INTERVAL_STORAGE = 'puma-autosave-interval'; // seconds
const AUTOSAVE_INTERVAL_DEFAULT = 30;
const AUTOSAVE_INTERVAL_MIN = 5;
const AUTOSAVE_INTERVAL_MAX = 600;
const PADS_VIDEOS_SWAP_STORAGE = 'puma-pads-videos-swapped';
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

// Reuses the same minimal modal/backdrop pattern as the New Session modal
// (session.js) instead of introducing a separate modal system.
function openWaveformHelpModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'session-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'session-modal waveform-help-modal';
  modal.innerHTML = `
    <h3>${t('waveform.helpTitle')}</h3>
    <section>
      <h4>${t('waveform.helpNavTitle')}</h4>
      <p>${t('waveform.helpNavBody')}</p>
    </section>
    <section>
      <h4>${t('waveform.helpMarkTitle')}</h4>
      <p>${t('waveform.helpMarkBody')}</p>
    </section>
    <section>
      <h4>${t('waveform.helpPlayTitle')}</h4>
      <p>${t('waveform.helpPlayBody')}</p>
    </section>
    <button class="session-modal-close" id="waveform-help-close" title="${t('common.cancel')}">&times;</button>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function cleanup() {
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    window.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) {
    if (e.key === 'Escape') cleanup();
  }

  modal.querySelector('#waveform-help-close').addEventListener('click', cleanup);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', onKeydown);
}

// Log viewer modal — same modal/backdrop pattern as the others in this app.
async function openLogsModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'session-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'session-modal logs-modal';
  modal.innerHTML = `
    <h3>${t('logs.title')}</h3>
    <div class="logs-list" id="logs-list"><p class="hint">${t('logs.loading')}</p></div>
    <div class="session-modal-actions">
      <button class="btn btn-secondary" id="logs-refresh">${t('logs.refresh')}</button>
    </div>
    <button class="session-modal-close" id="logs-close" title="${t('common.cancel')}">&times;</button>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const listEl = modal.querySelector('#logs-list');

  async function loadLogs() {
    listEl.innerHTML = `<p class="hint">${t('logs.loading')}</p>`;
    try {
      const { logs } = await api.getLogs();
      if (!logs.length) {
        listEl.innerHTML = `<p class="hint">${t('logs.empty')}</p>`;
        return;
      }
      listEl.innerHTML = logs
        .map((entry) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          return `<div class="log-line log-line-${entry.level}"><span class="log-time">${time}</span><span class="log-message">${escapeHtml(entry.message)}</span></div>`;
        })
        .join('');
      listEl.scrollTop = listEl.scrollHeight;
    } catch (err) {
      listEl.innerHTML = `<p class="hint">${t('logs.loadFailed', { message: err.message })}</p>`;
    }
  }

  function cleanup() {
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    window.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) {
    if (e.key === 'Escape') cleanup();
  }

  modal.querySelector('#logs-close').addEventListener('click', cleanup);
  modal.querySelector('#logs-refresh').addEventListener('click', loadLogs);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', onKeydown);

  await loadLogs();
}

// Small reusable confirm dialog, same modal/backdrop pattern as the other
// two modals in this app — used wherever a destructive action needs an
// explicit "are you sure" with more context than a native confirm() allows.
function openConfirmModal({ title, body, confirmLabel, onConfirm }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'session-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'session-modal';
  modal.innerHTML = `
    <h3>${title}</h3>
    <p class="session-modal-hint">${body}</p>
    <div class="session-modal-actions">
      <button class="btn btn-danger" id="confirm-modal-confirm">${confirmLabel}</button>
      <button class="btn btn-secondary" id="confirm-modal-cancel">${t('common.cancel')}</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function cleanup() {
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    window.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) {
    if (e.key === 'Escape') cleanup();
  }

  modal.querySelector('#confirm-modal-confirm').addEventListener('click', () => {
    cleanup();
    onConfirm();
  });
  modal.querySelector('#confirm-modal-cancel').addEventListener('click', cleanup);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', onKeydown);
}

// --- App text size ---------------------------------------------------------
// Every font-size in the stylesheet is in rem, so scaling the root font-size
// scales all text uniformly; --pad-size is px/vw, so pads are unaffected.
function getFontScale() {
  const stored = parseFloat(localStorage.getItem(FONT_SCALE_STORAGE));
  if (Number.isNaN(stored)) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, stored));
}

function applyFontScale(px) {
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, px));
  document.documentElement.style.fontSize = `${clamped}px`;
  localStorage.setItem(FONT_SCALE_STORAGE, String(clamped));
  return clamped;
}

// --- Auto-save -------------------------------------------------------------
// Saves the active session automatically. Mode 'change' debounces ~1s after
// the last edit (a knob drag = one save); mode 'interval' saves every N s when
// something changed. Silent (no toasts) and a no-op until a named session
// exists. A Word-style indicator beside Save reflects saving/saved.
let sessionDirty = false;
let autosaveDebounceTimer = null;
let autosaveIntervalTimer = null;
let autosaveSavedResetTimer = null;

function isAutosaveEnabled() {
  return localStorage.getItem(AUTOSAVE_ENABLED_STORAGE) === 'true';
}
function getAutosaveMode() {
  return localStorage.getItem(AUTOSAVE_MODE_STORAGE) === 'interval' ? 'interval' : 'change';
}
function getAutosaveInterval() {
  const stored = parseInt(localStorage.getItem(AUTOSAVE_INTERVAL_STORAGE), 10);
  if (Number.isNaN(stored)) return AUTOSAVE_INTERVAL_DEFAULT;
  return Math.min(AUTOSAVE_INTERVAL_MAX, Math.max(AUTOSAVE_INTERVAL_MIN, stored));
}

function setAutosaveStatus(state) {
  const enabled = isAutosaveEnabled();
  // Full indicator (beside Save) + the mini one in the collapsed-header grip.
  for (const id of ['autosave-status', 'grip-autosave-status']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !enabled;
    if (!enabled) continue;
    const icon = el.querySelector('.material-symbols-outlined');
    const label = el.querySelector('.autosave-status-label');
    el.classList.toggle('saving', state === 'saving');
    if (state === 'saving') {
      if (icon) icon.textContent = 'sync';
      if (label) label.textContent = t('autosave.saving');
    } else if (state === 'saved') {
      if (icon) icon.textContent = 'check_circle';
      if (label) label.textContent = t('autosave.saved');
    } else {
      if (icon) icon.textContent = 'cloud_done';
      if (label) label.textContent = t('autosave.idle');
    }
  }
}

async function runAutosave() {
  if (!isAutosaveEnabled()) return;
  const current = sessionManager.getCurrent();
  if (!current?.name) return; // nothing to autosave into yet
  const data = collectSessionData();
  if (!data) return; // a guard aborted (e.g. pad missing key) — skip silently
  setAutosaveStatus('saving');
  try {
    await sessionManager.save({ ...data, name: current.name }, { silent: true });
    sessionDirty = false;
    setAutosaveStatus('saved');
    clearTimeout(autosaveSavedResetTimer);
    autosaveSavedResetTimer = setTimeout(() => setAutosaveStatus('idle'), 2000);
  } catch {
    setAutosaveStatus('idle'); // save() already logged; stay quiet
  }
}

function markDirty() {
  sessionDirty = true;
  if (!isAutosaveEnabled() || getAutosaveMode() !== 'change') return;
  clearTimeout(autosaveDebounceTimer);
  autosaveDebounceTimer = setTimeout(runAutosave, 1000);
}

function restartAutosaveInterval() {
  clearInterval(autosaveIntervalTimer);
  autosaveIntervalTimer = null;
  if (isAutosaveEnabled() && getAutosaveMode() === 'interval') {
    autosaveIntervalTimer = setInterval(() => {
      if (sessionDirty) runAutosave();
    }, getAutosaveInterval() * 1000);
  }
}

// Called when autosave settings change: refresh indicator + interval timer.
function refreshAutosave() {
  setAutosaveStatus('idle');
  restartAutosaveInterval();
}

// --- Settings modal --------------------------------------------------------
function openSettingsModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'session-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'session-modal settings-modal';
  modal.innerHTML = `
    <h3>${t('settings.title')}</h3>
    <div class="settings-section">
      <label class="settings-label">${t('settings.stopKeyLabel')}</label>
      <div class="key-capture" id="settings-stop-key" title="${t('settings.stopKeyHint')}"></div>
      <p class="session-modal-hint">${t('settings.stopKeyHint')}</p>
    </div>
    <div class="settings-section">
      <label class="settings-label">${t('settings.fontSizeLabel')}</label>
      <div class="settings-font-row">
        <button class="btn btn-secondary" id="settings-font-dec" title="${t('settings.fontDecrease')}">A−</button>
        <span class="settings-font-value" id="settings-font-value"></span>
        <button class="btn btn-secondary" id="settings-font-inc" title="${t('settings.fontIncrease')}">A+</button>
        <button class="btn btn-secondary" id="settings-font-reset">${t('settings.fontReset')}</button>
      </div>
    </div>
    <div class="settings-section">
      <label class="settings-toggle-row">
        <input type="checkbox" id="settings-autosave-enabled">
        <span class="settings-label">${t('settings.autosaveLabel')}</span>
      </label>
      <div class="settings-autosave-options" id="settings-autosave-options">
        <select id="settings-autosave-mode" class="session-modal-select">
          <option value="change">${t('settings.autosaveModeChange')}</option>
          <option value="interval">${t('settings.autosaveModeInterval')}</option>
        </select>
        <div class="settings-autosave-interval" id="settings-autosave-interval-row">
          <label class="settings-label" for="settings-autosave-interval">${t('settings.autosaveIntervalLabel')}</label>
          <input type="number" id="settings-autosave-interval" min="${AUTOSAVE_INTERVAL_MIN}" max="${AUTOSAVE_INTERVAL_MAX}" step="1">
        </div>
      </div>
    </div>
    <button class="session-modal-close" id="settings-close" title="${t('common.cancel')}">&times;</button>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  initStopKeyCapture(modal.querySelector('#settings-stop-key'));

  // Auto-save controls
  const autosaveEnabledEl = modal.querySelector('#settings-autosave-enabled');
  const autosaveModeEl = modal.querySelector('#settings-autosave-mode');
  const autosaveOptionsEl = modal.querySelector('#settings-autosave-options');
  const autosaveIntervalRow = modal.querySelector('#settings-autosave-interval-row');
  const autosaveIntervalEl = modal.querySelector('#settings-autosave-interval');

  function paintAutosaveControls() {
    const enabled = isAutosaveEnabled();
    autosaveEnabledEl.checked = enabled;
    autosaveModeEl.value = getAutosaveMode();
    autosaveIntervalEl.value = String(getAutosaveInterval());
    autosaveOptionsEl.hidden = !enabled;
    autosaveIntervalRow.hidden = getAutosaveMode() !== 'interval';
  }
  paintAutosaveControls();

  autosaveEnabledEl.addEventListener('change', () => {
    localStorage.setItem(AUTOSAVE_ENABLED_STORAGE, String(autosaveEnabledEl.checked));
    paintAutosaveControls();
    refreshAutosave();
  });
  autosaveModeEl.addEventListener('change', () => {
    localStorage.setItem(AUTOSAVE_MODE_STORAGE, autosaveModeEl.value);
    paintAutosaveControls();
    refreshAutosave();
  });
  autosaveIntervalEl.addEventListener('change', () => {
    const n = Math.min(AUTOSAVE_INTERVAL_MAX, Math.max(AUTOSAVE_INTERVAL_MIN, parseInt(autosaveIntervalEl.value, 10) || AUTOSAVE_INTERVAL_DEFAULT));
    localStorage.setItem(AUTOSAVE_INTERVAL_STORAGE, String(n));
    autosaveIntervalEl.value = String(n);
    refreshAutosave();
  });

  const valueEl = modal.querySelector('#settings-font-value');
  function paintFont(px) {
    valueEl.textContent = `${px}px`;
  }
  paintFont(getFontScale());
  modal.querySelector('#settings-font-dec').addEventListener('click', () => paintFont(applyFontScale(getFontScale() - 1)));
  modal.querySelector('#settings-font-inc').addEventListener('click', () => paintFont(applyFontScale(getFontScale() + 1)));
  modal.querySelector('#settings-font-reset').addEventListener('click', () => paintFont(applyFontScale(FONT_SCALE_DEFAULT)));

  function cleanup() {
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    window.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) {
    if (e.key === 'Escape' && !isCapturingKey) cleanup();
  }
  modal.querySelector('#settings-close').addEventListener('click', cleanup);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', onKeydown);
}

// --- Organize mode: context menu, clear confirm, copy modal, save guard ---

let padContextMenu = null;

function closePadContextMenu() {
  if (!padContextMenu) return;
  const { el, onDismiss } = padContextMenu;
  if (el.parentNode) el.parentNode.removeChild(el);
  document.removeEventListener('pointerdown', onDismiss, true);
  window.removeEventListener('keydown', onDismiss);
  padContextMenu = null;
}

function openPadContextMenu(position, x, y) {
  closePadContextMenu();
  if (!pads.getData(position)) return; // nothing to manage on an empty pad

  const menu = document.createElement('div');
  menu.className = 'pad-context-menu';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = t('organize.contextCopy');
  copyBtn.addEventListener('click', () => {
    closePadContextMenu();
    openCopyPadModal(position);
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'danger';
  clearBtn.textContent = t('organize.contextClear');
  clearBtn.addEventListener('click', () => {
    closePadContextMenu();
    confirmClearPad(position);
  });

  menu.append(copyBtn, clearBtn);
  document.body.appendChild(menu);

  // Clamp inside the viewport (long-press near an edge can pass coords that
  // would otherwise push the menu off-screen).
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDismiss = (e) => {
    if (e.type === 'keydown') {
      if (e.key === 'Escape') closePadContextMenu();
      return;
    }
    if (!menu.contains(e.target)) closePadContextMenu();
  };
  document.addEventListener('pointerdown', onDismiss, true);
  window.addEventListener('keydown', onDismiss);
  padContextMenu = { el: menu, onDismiss };
}

function confirmClearPad(position) {
  if (!pads.getData(position)) return;
  // Body references the pad by position only — openConfirmModal injects it via
  // innerHTML and t() does not escape, so a user-set label must never reach it.
  openConfirmModal({
    title: t('organize.clearConfirmTitle', { position }),
    body: t('organize.clearConfirmBody', { position }),
    confirmLabel: t('organize.clearConfirmButton'),
    onConfirm: () => {
      pads.clear(position);
      showToast(t('toast.padCleared', { position }), 'info');
    },
  });
}

function openCopyPadModal(sourcePosition) {
  if (!pads.getData(sourcePosition)) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'session-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'session-modal';
  modal.innerHTML = `
    <h3>${t('organize.copyModalTitle', { position: sourcePosition })}</h3>
    <p class="session-modal-hint">${t('organize.copyModalHint')}</p>
    <div class="session-modal-actions">
      <select id="copy-pad-select" class="session-modal-select"></select>
      <button class="btn" id="copy-pad-confirm">${t('organize.copyButton')}</button>
    </div>
    <button class="session-modal-close" id="copy-pad-cancel" title="${t('common.cancel')}">&times;</button>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Options are built as DOM nodes with textContent (never innerHTML), so a
  // pad label could never inject markup even if labels are shown here later.
  const select = modal.querySelector('#copy-pad-select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('organize.copySelectTargetFirst');
  select.appendChild(placeholder);
  const count = pads.getCount();
  for (let p = 1; p <= count; p++) {
    if (p === sourcePosition) continue;
    const opt = document.createElement('option');
    opt.value = String(p);
    opt.textContent = t(
      pads.getData(p) ? 'organize.copyTargetOccupied' : 'organize.copyTargetEmpty',
      { position: p },
    );
    select.appendChild(opt);
  }

  let escHandler = null;
  function cleanup() {
    if (modal.parentNode) modal.parentNode.removeChild(modal);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (escHandler) window.removeEventListener('keydown', escHandler);
  }

  function doCopy(targetPosition) {
    pads.copyPad(sourcePosition, targetPosition);
    pads.select(targetPosition); // opens the editor on the "assign a key" state
    showToast(t('organize.copyNeedsKey', { position: targetPosition }), 'info');
  }

  modal.querySelector('#copy-pad-confirm').addEventListener('click', () => {
    const targetPosition = parseInt(select.value, 10);
    if (!targetPosition) {
      showToast(t('organize.copySelectTargetFirst'), 'warning');
      return;
    }
    cleanup();
    if (pads.getData(targetPosition)) {
      openConfirmModal({
        title: t('organize.overwriteConfirmTitle', { position: targetPosition }),
        body: t('organize.overwriteConfirmBody', { position: targetPosition }),
        confirmLabel: t('organize.overwriteConfirmButton'),
        onConfirm: () => doCopy(targetPosition),
      });
    } else {
      doCopy(targetPosition);
    }
  });

  modal.querySelector('#copy-pad-cancel').addEventListener('click', cleanup);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  escHandler = (e) => {
    if (e.key === 'Escape') cleanup();
  };
  window.addEventListener('keydown', escHandler);
}

// Copies leave a pad keyless (see pads.copyPad); block save/export until it's
// assigned, since server validation rejects a session with any keyless pad and
// the generic error wouldn't say which one.
function findPadMissingKey() {
  return pads.getAll().find((p) => !p.key);
}

// Global stop
function stopAll() {
  audio.stopAll();
  videoDisplay.stop();
  showToast(t('toast.allStopped'), 'info');
}

// Stop button
const stopBtn = document.getElementById('btn-stop-all');
if (stopBtn) {
  stopBtn.addEventListener('click', stopAll);
}

// Organize mode toggle
const organizeBtn = document.getElementById('btn-organize-mode');
if (organizeBtn) {
  organizeBtn.addEventListener('click', () => {
    const next = !pads.isOrganizeMode();
    pads.setOrganizeMode(next);
    organizeBtn.setAttribute('aria-pressed', String(next));
    closePadContextMenu();
  });
}

// Wires a click-to-capture control for the global stop key. Used by the
// Settings modal (the control used to live in the navbar). The element shows
// the current key and, on click, listens for the next keypress to rebind it.
function initStopKeyCapture(el) {
  if (!el) return;
  el.textContent = formatKeyLabel(stopKey);
  el.dataset.key = stopKey;
  el.addEventListener('click', () => {
    el.classList.add('listening');
    el.textContent = t('common.pressKey');
    isCapturingKey = true;
    pads.setKeyCapturing(true);

    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = buildKeyCombo(e);
      saveStopKey(combo);
      el.classList.remove('listening');
      el.textContent = formatKeyLabel(combo);
      el.dataset.key = combo;
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

// Header visibility shortcut (Ctrl/Cmd+Shift+H). Checked directly via
// e.shiftKey instead of buildKeyCombo, which discards Shift for
// single-character keys and would never match this combo.
window.addEventListener('keydown', (e) => {
  if (isCapturingKey) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'h') return;

  const active = document.activeElement;
  const isInput = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT' ||
    active.classList.contains('key-capture')
  );
  if (isInput) return;

  e.preventDefault();
  document.getElementById('header-toggle')?.click();
});

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
    const previewVideo = videoDisplay.getVideo();
    if (!previewVideo || !startInput || !endInput) return;
    const time = previewVideo.currentTime;
    const end = parseTime(endInput.value);
    startInput.value = formatTime(time);
    endInput.value = formatTime(Math.max(time + 0.1, end));
    if (editorWaveform) editorWaveform.setSegment(parseTime(startInput.value), parseTime(endInput.value));
    autoCommitPad(selectedPosition, { start: parseTime(startInput.value), end: parseTime(endInput.value) });
  } else if (e.key === 'o' || e.key === 'O') {
    e.preventDefault();
    const startInput = document.getElementById('pad-start');
    const endInput = document.getElementById('pad-end');
    const previewVideo = videoDisplay.getVideo();
    if (!previewVideo || !startInput || !endInput) return;
    const time = previewVideo.currentTime;
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

// Single shared toggle mechanism for both collapsible panels (Pad Editor and
// the Video Library sidenav) so they present the same visual/interaction
// language even though their underlying CSS state class differs (one
// collapses height, the other collapses width) and neither needed to change.
function createCollapsibleToggle(toggleEl, {
  isCollapsed,
  setCollapsed,
  onExpand,
  expandTitleKey = 'panel.expandTitle',
  collapseTitleKey = 'panel.collapseTitle',
} = {}) {
  if (!toggleEl) return null;

  function sync() {
    const collapsed = isCollapsed();
    toggleEl.setAttribute('aria-expanded', String(!collapsed));
    const title = collapsed ? t(expandTitleKey) : t(collapseTitleKey);
    toggleEl.title = title;
    toggleEl.setAttribute('aria-label', title);
  }

  // Fuerza un estado específico (no alterna) — necesario para que el
  // auto-colapso por umbral del resize (makeResizable) sea idempotente: se
  // llama en cada mousemove mientras el drag esté por debajo del umbral.
  function collapse() {
    if (isCollapsed()) return;
    setCollapsed(true);
    sync();
  }

  // Symmetric force-expand — used when dragging a collapsed panel's resize
  // handle re-opens it before resizing.
  function expand() {
    if (!isCollapsed()) return;
    setCollapsed(false);
    sync();
    if (typeof onExpand === 'function') onExpand();
  }

  sync();
  toggleEl.addEventListener('click', () => {
    const next = !isCollapsed();
    setCollapsed(next);
    sync();
    if (!next && typeof onExpand === 'function') onExpand();
  });

  return { collapse, expand, isCollapsed, sync };
}

function syncAllToggles() {
  syncableToggles.forEach((ctrl) => ctrl.sync());
}

// help-icon tooltips use position:fixed (see app.css) so ancestors with
// overflow:hidden/auto (panels, the sidenav body) never clip them. A single
// delegated listener covers every icon, including ones injected dynamically
// (e.g. the waveform's help icon re-rendered per pad), and clamps the
// horizontal position so the bubble never runs off the viewport edge.
function initTooltipPositioning() {
  document.body.addEventListener('mouseover', (e) => {
    const icon = e.target.closest('.help-icon, .has-tip, .mini-switch-label');
    if (!icon) return;
    const rect = icon.getBoundingClientRect();
    // The video (.has-tip) bubble is wider/taller than the help-icon one, so it
    // needs a larger clamp margin and a bigger top-flip threshold.
    const isWide = icon.classList.contains('has-tip');
    const halfTip = isWide ? 170 : 140;
    const x = Math.min(
      Math.max(rect.left + rect.width / 2, halfTip + 8),
      window.innerWidth - halfTip - 8
    );
    // Si no hay espacio arriba (ej. el ícono de STOP, muy cerca del borde
    // superior de la página), abrir el tooltip hacia abajo en vez de arriba.
    const estimatedTipHeight = isWide ? 140 : 90;
    const openBelow = rect.top < estimatedTipHeight + 16;
    icon.style.setProperty('--tip-x', `${x}px`);
    icon.style.setProperty('--tip-y', `${openBelow ? rect.bottom + 8 : rect.top - 8}px`);
    icon.classList.toggle('tip-below', openBelow);
  });
}

// Drag-to-resize handle shared by the Video Library sidenav (width) and the
// Pad Editor panel (height, via flex-basis — .right-panel is a column flex
// container so the panel's flex-basis controls its vertical extent, not its
// width). Resets to the CSS default on every reload; not persisted.
function makeResizable(el, { edge, dimension, min, max, onResizeEnd, collapseBelow, onCollapse, isCollapsed, onExpand } = {}) {
  const handle = document.createElement('div');
  el.appendChild(handle);

  // Edge is mutable so a PADS/VIDEOS swap can flip which side the handle sits
  // on (the center-facing edge). Positioning is pure CSS via the edge class;
  // only the drag sign depends on it, so a class swap is enough.
  let currentEdge;
  let sign;
  function applyEdge(newEdge) {
    currentEdge = newEdge;
    sign = (currentEdge === 'right' || currentEdge === 'bottom') ? -1 : 1;
    handle.className = `resize-handle resize-handle-${currentEdge}`;
  }
  applyEdge(edge);

  handle.addEventListener('mousedown', (e) => {
    // The slicer takeover pins this panel to the full viewport via CSS
    // (position: fixed; inset: 0) — CSS alone already hides the handle, but
    // this guard also stops a drag from writing an inline width/flexBasis
    // that would fight the takeover's layout once it closes.
    if (el.classList.contains('slicer-takeover')) return;
    e.preventDefault();
    // Dragging a collapsed panel's handle re-expands it first, then resizes
    // from the freshly-expanded size (offsetWidth read below is synchronous
    // after the class change, so it reflects the expanded layout).
    if (typeof isCollapsed === 'function' && isCollapsed() && typeof onExpand === 'function') {
      onExpand();
    }
    const startPos = dimension === 'width' ? e.clientX : e.clientY;
    const startSize = dimension === 'width' ? el.offsetWidth : el.offsetHeight;
    handle.classList.add('resizing');
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      // Si ya no hay ningún botón del mouse presionado, el drag terminó
      // aunque el mouseup nunca haya llegado a window (ej. se soltó fuera
      // de la ventana del navegador) — sin esto, el listener queda pegado.
      if (ev.buttons === 0) { onUp(); return; }
      const current = dimension === 'width' ? ev.clientX : ev.clientY;
      const delta = (startPos - current) * sign;
      const raw = startSize + delta;
      if (typeof collapseBelow === 'number' && raw < collapseBelow) {
        // Limpiar el estilo inline: si no, el ancho/alto arrastrado se queda
        // pisando la regla de la clase .collapsed/no-.expanded (un estilo
        // inline le gana en especificidad), y el panel "colapsa" por dentro
        // sin ningún efecto visible.
        el.style[dimension === 'width' ? 'width' : 'flexBasis'] = '';
        if (typeof onCollapse === 'function') onCollapse();
        return;
      }
      // If the panel was collapsed earlier in this same drag (crossed below
      // the threshold) and we're now back above it, re-expand before writing
      // the inline size — otherwise the box grows but its content stays hidden
      // (the collapsed class zeroes opacity/grid-rows). expand() is idempotent.
      if (typeof isCollapsed === 'function' && isCollapsed() && typeof onExpand === 'function') {
        onExpand();
      }
      const maxPx = typeof max === 'function' ? max() : max;
      const next = Math.max(min, Math.min(maxPx, raw));
      el.style[dimension === 'width' ? 'width' : 'flexBasis'] = `${next}px`;
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      handle.classList.remove('resizing');
      document.body.style.userSelect = '';
      if (typeof onResizeEnd === 'function') onResizeEnd();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  return {
    setEdge(newEdge) {
      if (newEdge !== currentEdge) applyEdge(newEdge);
    },
  };
}

function initLibrarySidenav() {
  const sidenav = document.getElementById('library-sidenav');
  const toggle = document.getElementById('library-sidenav-toggle');
  if (!sidenav || !toggle) return null;

  return createCollapsibleToggle(toggle, {
    isCollapsed: () => !sidenav.classList.contains('expanded'),
    setCollapsed: (collapsed) => {
      sidenav.style.width = '';
      sidenav.classList.toggle('expanded', !collapsed);
    },
  });
}

function initPadsSidenav() {
  const sidenav = document.getElementById('pads-sidenav');
  const toggle = document.getElementById('pads-sidenav-toggle');
  if (!sidenav || !toggle) return null;

  return createCollapsibleToggle(toggle, {
    isCollapsed: () => !sidenav.classList.contains('expanded'),
    setCollapsed: (collapsed) => {
      sidenav.style.width = '';
      sidenav.classList.toggle('expanded', !collapsed);
    },
  });
}

// Header dropdown menus (kebab + locale) register a close callback here so
// they can be dismissed together when the header collapses or the window
// resizes — events that move/hide their trigger button without a click, which
// would otherwise leave a fixed-positioned menu floating detached.
const headerMenuClosers = [];
function closeHeaderMenus() {
  headerMenuClosers.forEach((fn) => fn());
}
window.addEventListener('resize', closeHeaderMenus);

// Places a fixed-positioned dropdown just under its trigger button, right-
// aligned to the button and clamped inside the viewport. Called after the menu
// is unhidden so offsetWidth reflects real layout; kept synchronous so there's
// no frame painted at a stale position.
function positionMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
}

// Header collapse is persisted (unlike the sidenavs, which always reopen on
// reload) — precedent is STOP_KEY_STORAGE/MASTER_FX_STORAGE, not
// initLibrarySidenav. The grip stays visible either way so reloading with a
// hidden header is discoverable, not surprising.
function initHeaderToggle() {
  const app = document.querySelector('.app');
  const toggle = document.getElementById('header-toggle');
  if (!app || !toggle) return null;

  const persistedHidden = localStorage.getItem(HEADER_HIDDEN_STORAGE) === 'true';
  app.classList.toggle('header-hidden', persistedHidden);

  return createCollapsibleToggle(toggle, {
    isCollapsed: () => app.classList.contains('header-hidden'),
    setCollapsed: (collapsed) => {
      app.classList.toggle('header-hidden', collapsed);
      localStorage.setItem(HEADER_HIDDEN_STORAGE, String(collapsed));
      closeHeaderMenus();
    },
    expandTitleKey: 'header.showTitle',
    collapseTitleKey: 'header.hideTitle',
  });
}

function initPanelToggle() {
  const controllers = [];
  document.querySelectorAll('.collapsible-box').forEach((panel) => {
    const toggle = panel.querySelector('.panel-toggle');
    if (!toggle) return;

    const ctrl = createCollapsibleToggle(toggle, {
      isCollapsed: () => panel.classList.contains('collapsed'),
      setCollapsed: (collapsed) => {
        panel.style.flexBasis = '';
        panel.classList.toggle('collapsed', collapsed);
      },
      onExpand: () => {
        if (editorWaveform) {
          editorWaveform.resize();
          editorWaveform.draw();
        }
      },
    });
    controllers.push({ panel, ctrl });
  });
  return controllers;
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
    const played = await triggerPad(position, data);
    if (played) ws.send('pad:trigger', { position, videoId: data.videoId });
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
  // Organize mode: stop the voices of any pads about to be mutated so a
  // swapped/moved/cleared pad never leaves an orphaned voice keyed to its old
  // position (activeSources is keyed by position in audio-engine.js).
  onBeforeChange(positions) {
    positions.forEach((p) => audio.stop(p));
    if (audio.getActivePositions().length === 0) {
      videoDisplay.stop();
    }
  },
  onAfterSwap(from, to, targetWasOccupied) {
    showToast(
      t(targetWasOccupied ? 'toast.padSwapped' : 'toast.padMoved', { a: from, b: to }),
      'info',
    );
  },
  onContextMenu(position, x, y) {
    openPadContextMenu(position, x, y);
  },
  onChange() {
    markDirty();
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
  const max = Math.log10(10000);
  const log = min + (percent / 100) * (max - min);
  return Math.pow(10, log);
}

function freqToPercent(freq) {
  const min = Math.log10(20);
  const max = Math.log10(10000);
  return ((Math.log10(freq) - min) / (max - min)) * 100;
}

function formatHz(freq) {
  if (freq >= 1000) return `${(freq / 1000).toFixed(1)}kHz`;
  return `${Math.round(freq)}Hz`;
}

function formatSemitones(semitones) {
  const n = Math.round(semitones);
  return `${n > 0 ? '+' : ''}${n}`;
}

// Pan readout: C at center, L{n}/R{n} toward the sides (n is 0..100).
function formatPan(v) {
  const pct = Math.round(v * 100);
  if (pct === 0) return 'C';
  return pct < 0 ? `L${Math.abs(pct)}` : `R${pct}`;
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
      markDirty();
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

// PAD FX knob strip — mirrors the master-strip's knob look, but instead of a
// global value it edits whichever pad is currently selected (like the
// physical per-pad knobs on an AKAI MPC). Changes are auto-committed to the
// pad's stored data AND, if that pad is currently sounding, applied live via
// audio.updateVoiceFx so you can hear the change while it plays.
function initPadFxControls() {
  const labelEl = document.getElementById('pad-fx-label');

  const controls = [
    {
      id: 'pad-fx-pitch',
      displayId: 'pad-fx-pitch-value',
      key: 'pitch',
      default: 0,
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => formatSemitones(v),
    },
    {
      id: 'pad-fx-speed',
      displayId: 'pad-fx-speed-value',
      key: 'speed',
      default: 100,
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => `${v}%`,
    },
    {
      id: 'pad-fx-cutoff',
      displayId: 'pad-fx-cutoff-value',
      key: 'cutoff',
      default: 100,
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => formatHz(percentToFreq(v)),
      toEngine: (v) => percentToFreq(v),
    },
    {
      id: 'pad-fx-resonance',
      displayId: 'pad-fx-resonance-value',
      key: 'resonance',
      default: 0.1,
      toValue: (v) => parseFloat(v),
      toDisplay: (v) => v.toFixed(1),
    },
    {
      id: 'pad-fx-reverb-send',
      displayId: 'pad-fx-reverb-send-value',
      key: 'reverbSend',
      default: 0,
      toValue: (v) => parseInt(v, 10) / 100,
      toDisplay: (v) => `${Math.round(v * 100)}%`,
    },
    {
      id: 'pad-fx-delay-send',
      displayId: 'pad-fx-delay-send-value',
      key: 'delaySend',
      default: 0,
      toValue: (v) => parseInt(v, 10) / 100,
      toDisplay: (v) => `${Math.round(v * 100)}%`,
    },
    {
      id: 'pad-fx-drive',
      displayId: 'pad-fx-drive-value',
      key: 'drive',
      default: 0,
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => `${v}%`,
    },
    {
      id: 'pad-fx-pan',
      displayId: 'pad-fx-pan-value',
      key: 'pan',
      default: 0,
      toValue: (v) => parseInt(v, 10) / 100,
      toDisplay: (v) => formatPan(v),
    },
    {
      id: 'pad-fx-attack',
      displayId: 'pad-fx-attack-value',
      key: 'attack',
      default: 0,
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => `${v}ms`,
    },
    {
      id: 'pad-fx-release',
      displayId: 'pad-fx-release-value',
      key: 'release',
      default: 0,
      toValue: (v) => parseInt(v, 10),
      toDisplay: (v) => `${v}ms`,
    },
  ];

  // P.SHIFT/STRETCH are checkboxes, not knobs — separate from `controls`
  // (boolean `checked` instead of a `value` range, `change` instead of
  // `input`) but committed/applied through the same autoCommitPad +
  // audio.updateVoiceFx pattern.
  const switches = [
    { id: 'pad-fx-pshift', key: 'pitchShiftOn', default: true },
    { id: 'pad-fx-stretch', key: 'stretchOn', default: false },
    { id: 'pad-fx-reverse', key: 'reverse', default: false },
  ];

  // The Speed knob is only meaningful while STRETCH is on, in addition to
  // the usual "no pad selected" gate every other control follows — kept as
  // its own function so the STRETCH checkbox's change handler can re-run it
  // without touching the rest of the strip.
  function updateSpeedDisabled() {
    const speedInput = document.getElementById('pad-fx-speed');
    const stretchInput = document.getElementById('pad-fx-stretch');
    if (!speedInput) return;
    const { selectedPosition } = store.get();
    speedInput.disabled = !selectedPosition || !(stretchInput && stretchInput.checked);
  }

  for (const ctrl of controls) {
    const input = document.getElementById(ctrl.id);
    const display = document.getElementById(ctrl.displayId);
    if (!input) continue;

    input.addEventListener('input', () => {
      const { selectedPosition } = store.get();
      if (!selectedPosition) return;

      const value = ctrl.toValue(input.value);
      if (display) display.textContent = ctrl.toDisplay(value);
      autoCommitPad(selectedPosition, { [ctrl.key]: value });
      audio.updateVoiceFx(selectedPosition, { [ctrl.key]: ctrl.toEngine ? ctrl.toEngine(value) : value });
    });
  }

  for (const sw of switches) {
    const input = document.getElementById(sw.id);
    if (!input) continue;

    input.addEventListener('change', () => {
      // Toggling steals focus onto this checkbox, which pads.js'
      // isInputFocused() treats as "typing" and blocks all pad keydowns —
      // blur it immediately so pad keys work again without an extra click
      // elsewhere (mirrors the session.js load() precedent).
      input.blur();

      const { selectedPosition } = store.get();
      if (!selectedPosition) return;

      autoCommitPad(selectedPosition, { [sw.key]: input.checked });
      audio.updateVoiceFx(selectedPosition, { [sw.key]: input.checked });
      if (sw.key === 'stretchOn') updateSpeedDisabled();
    });
  }

  function bindPad(position, data) {
    if (labelEl) {
      labelEl.textContent = position ? t('pads.fxGroupSelected', { position }) : t('pads.fxGroupNone');
    }

    for (const ctrl of controls) {
      const input = document.getElementById(ctrl.id);
      const display = document.getElementById(ctrl.displayId);
      if (!input) continue;

      input.disabled = !position;
      const value = position ? (data?.[ctrl.key] ?? ctrl.default) : ctrl.default;
      input.value = value;
      if (display) display.textContent = ctrl.toDisplay(value);
    }

    for (const sw of switches) {
      const input = document.getElementById(sw.id);
      if (!input) continue;

      input.disabled = !position;
      input.checked = position ? (data?.[sw.key] ?? sw.default) : sw.default;
    }

    updateSpeedDisabled();
  }

  return { bindPad };
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

  // Show the loading spinner (delay-gated) across the whole load: audio decode
  // here + video buffering in playSegment. The token flows into playSegment so
  // it owns the success-clear; the error paths clear it themselves.
  const loadToken = videoDisplay.setLoading(true);

  try {
    await audio.loadAudio(data.videoId, audioUrl);
  } catch (err) {
    showToast(t('toast.audioLoadFailed', { message: err.message }), 'error');
    videoDisplay.setLoading(false, loadToken);
    return;
  }

  try {
    await audio.play(position, {
      videoId: data.videoId,
      start: data.start,
      end: data.end,
      volume: data.volume ?? 0.2,
      loop: data.loop ?? false,
      triggerMode: data.triggerMode ?? 'oneshot',
      pitch: data.pitch ?? 0,
      cutoff: percentToFreq(data.cutoff ?? 100),
      resonance: data.resonance ?? 0.1,
      reverbSend: data.reverbSend ?? 0,
      delaySend: data.delaySend ?? 0,
      pitchShiftOn: data.pitchShiftOn ?? true,
      stretchOn: data.stretchOn ?? false,
      speed: data.speed ?? 100,
      pan: data.pan ?? 0,
      drive: data.drive ?? 0,
      attack: data.attack ?? 0,
      release: data.release ?? 0,
      reverse: data.reverse ?? false,
    });
  } catch (err) {
    showToast(t('toast.playbackFailed', { message: err.message }), 'error');
    videoDisplay.setLoading(false, loadToken);
    return;
  }

  // Reverse only flips the audio playback direction — the video element has
  // no reverse-playback API, so playing it forward alongside reversed audio
  // would just look wrong. Instead, show a frozen frame at the slice end,
  // since reversed audio audibly starts from that end of the slice; real
  // video reverse is out of scope for this pad FX.
  if (data.reverse) {
    videoDisplay.showFrame({
      videoId: data.videoId,
      url: videoUrl,
      time: data.end,
      loadToken,
    });
  } else {
    videoDisplay.playSegment({
      videoId: data.videoId,
      url: videoUrl,
      start: data.start,
      end: data.end,
      muted: true,
      loadToken,
    });
  }

  return true;
}

// Pad Editor
const editorEl = document.getElementById('pad-editor');

function renderPadEditor(position, data) {
  if (editorWaveform) {
    editorWaveform.destroy();
    editorWaveform = null;
  }

  if (padFxControls) padFxControls.bindPad(position, data);

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

  const previewPct = Math.round(previewVolume * 100);
  const padPct = Math.round((data?.volume ?? 0.2) / 2 * 100);
  editorEl.innerHTML = `
    <div class="pad-editor-tabs">
      <span class="pad-editor-tabs-pad">PAD ${position}</span>
      <button type="button" class="pad-tab${padEditorActiveTab === 'general' ? ' active' : ''}" data-tab="general">${t('editor.tabGeneral')}</button>
      <button type="button" class="pad-tab${padEditorActiveTab === 'volume' ? ' active' : ''}" data-tab="volume">${t('editor.tabVolume')}</button>
      <button type="button" class="pad-tab${padEditorActiveTab === 'trim' ? ' active' : ''}" data-tab="trim">${t('editor.tabTrim')}</button>
    </div>

    <div class="pad-tab-panel${padEditorActiveTab === 'general' ? ' active' : ''}" data-tab-panel="general">
      <div class="form-row">
        <label>${t('editor.labelField')} <span class="help-icon" data-i18n-tooltip="tip.label" data-tooltip="${t('tip.label')}">?</span></label>
        <input type="text" id="pad-label" value="${escapeHtml(data?.label || '')}" placeholder="${t('editor.labelPlaceholder')}">
      </div>
      <div class="form-row">
        <label>${t('editor.keyField')} <span class="help-icon" data-i18n-tooltip="tip.key" data-tooltip="${t('tip.key')}">?</span></label>
        <div class="key-capture" id="pad-key-capture" data-key="${escapeHtml(data?.key || '')}">
          ${data?.key ? t('editor.keyValue', { key: escapeHtml(data.key) }) : t('editor.clickPressKey')}
        </div>
      </div>
      <div class="form-row">
        <label>${t('editor.videoField')} <span class="help-icon" data-i18n-tooltip="tip.video" data-tooltip="${t('tip.video')}">?</span></label>
        <select id="pad-video">${videoOptions}</select>
      </div>
      <div class="form-row">
        <label>${t('editor.triggerModeField')} <span class="help-icon" data-i18n-tooltip="tip.triggerMode" data-tooltip="${t('tip.triggerMode')}">?</span></label>
        <select id="pad-trigger-mode">
          <option value="oneshot" ${data?.triggerMode === 'oneshot' ? 'selected' : ''}>${t('editor.oneshotOption')}</option>
          <option value="gate" ${data?.triggerMode === 'gate' ? 'selected' : ''}>${t('editor.gateOption')}</option>
        </select>
      </div>
      <div class="form-row">
        <label>${t('editor.colorField')} <span class="help-icon" data-i18n-tooltip="tip.color" data-tooltip="${t('tip.color')}">?</span></label>
        <input type="color" id="pad-color" value="${data?.color || '#ff9f1c'}">
      </div>
      <div class="form-row">
        <label>
          <input type="checkbox" id="pad-loop" ${data?.loop ? 'checked' : ''}> ${t('editor.loopField')}
          <span class="help-icon" data-i18n-tooltip="tip.loop" data-tooltip="${t('tip.loop')}">?</span>
        </label>
      </div>
    </div>

    <div class="pad-tab-panel${padEditorActiveTab === 'volume' ? ' active' : ''}" data-tab-panel="volume">
      <div class="form-row">
        <label>${t('editor.previewVolumeField')} <span class="help-icon" data-i18n-tooltip="tip.previewVolume" data-tooltip="${t('tip.previewVolume')}">?</span></label>
        <div class="volume-row">
          <input type="range" id="pad-preview-volume" min="0" max="1" step="0.01" value="${previewVolume}">
          <input type="number" class="vol-number" id="pad-preview-volume-number" min="0" max="100" step="1" value="${previewPct}">
        </div>
      </div>
      <div class="form-row">
        <label>${t('editor.padVolumeField')} <span class="help-icon" data-i18n-tooltip="tip.padVolume" data-tooltip="${t('tip.padVolume')}">?</span></label>
        <div class="volume-row">
          <input type="range" id="pad-volume" min="0" max="2" step="0.02" value="${data?.volume ?? 0.2}">
          <input type="number" class="vol-number" id="pad-volume-number" min="0" max="100" step="1" value="${padPct}">
        </div>
      </div>
    </div>

    <div class="pad-tab-panel${padEditorActiveTab === 'trim' ? ' active' : ''}" data-tab-panel="trim">
      <div class="form-row">
        <label>${t('editor.transportField')} <span class="help-icon" data-i18n-tooltip="tip.transport" data-tooltip="${t('tip.transport')}">?</span></label>
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
          <button type="button" class="link-btn" id="btn-waveform-help-more">${t('waveform.seeMore')}</button>
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
          <label>${t('editor.startField')} <span class="help-icon" data-i18n-tooltip="tip.start" data-tooltip="${t('tip.start')}">?</span></label>
          <input type="text" id="pad-start" value="${formatTime(data?.start ?? 0)}">
        </div>
        <div class="form-row">
          <label>${t('editor.endField')} <span class="help-icon" data-i18n-tooltip="tip.end" data-tooltip="${t('tip.end')}">?</span></label>
          <input type="text" id="pad-end" value="${formatTime(data?.end ?? 0)}">
        </div>
      </div>
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
      videoDisplay.seek(time);
      if (editorWaveform) editorWaveform.setPlayhead(time);
      updatePreviewTime();
    },
    onZoom: (level) => {
      const zoomLevelEl = document.getElementById('waveform-zoom-level');
      if (zoomLevelEl) zoomLevelEl.textContent = `${Math.round(level * 10) / 10}x`;
    },
  });

  if (data?.videoId) {
    loadEditorWaveform(data.videoId, data.start ?? 0, data.end ?? 0);
    videoDisplay.load(data.videoId, api.getVideoUrl(data.videoId));
  }

  updateWaveformStatus(data?.start ?? 0, data?.end ?? 0);

  initEditorListeners(position);
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
  const video = videoDisplay.getVideo();
  if (timeEl && video) {
    timeEl.textContent = formatTime(video.currentTime);
  }
}

function updateWaveformStatus(start, end) {
  const statusEl = document.getElementById('waveform-status');
  if (!statusEl) return;
  const duration = Math.max(0, end - start);
  statusEl.textContent = t('waveform.status', { in: formatTime(start), out: formatTime(end), dur: formatTime(duration) });
}

function syncPlayhead(videoId) {
  const video = videoDisplay.getVideo();
  if (videoDisplay.getVideoId() !== videoId) return; // otro pad tomó el video compartido
  if (video && editorWaveform) {
    editorWaveform.setPlayhead(video.currentTime);
    updatePreviewTime();
  }
  if (video && !video.paused) {
    requestAnimationFrame(() => syncPlayhead(videoId));
  }
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Human-readable file size. Individual videos are tens/hundreds of MB, so KB/MB
// read better than the aggregate GB used for total cache usage.
function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function initEditorListeners(position) {
  // Tab switching. The RECORTE tab holds the waveform canvas; createWaveform
  // measured it at construction, so if it was built while that tab was hidden
  // the canvas is stuck at 1×1 — re-resize/draw whenever RECORTE is shown
  // (after the panel is made visible, so getBoundingClientRect is real).
  const tabButtons = editorEl.querySelectorAll('.pad-tab');
  function activateTab(tab) {
    padEditorActiveTab = tab;
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    editorEl.querySelectorAll('.pad-tab-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.tabPanel === tab);
    });
    if (tab === 'trim' && editorWaveform) {
      editorWaveform.resize();
      editorWaveform.draw();
    }
  }
  tabButtons.forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));
  // If the persisted active tab is RECORTE, the waveform was just built hidden
  // in some render paths — ensure it's sized now.
  if (padEditorActiveTab === 'trim' && editorWaveform) {
    editorWaveform.resize();
    editorWaveform.draw();
  }

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
  const waveformHelpMoreBtn = document.getElementById('btn-waveform-help-more');
  if (waveformHelpMoreBtn) {
    waveformHelpMoreBtn.addEventListener('click', openWaveformHelpModal);
  }

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
      videoDisplay.load(videoId, api.getVideoUrl(videoId));
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

  // Preview volume: range 0–1, number input shows 0–100%. Two-way synced.
  const previewVolumeNumber = document.getElementById('pad-preview-volume-number');
  function applyPreviewVolume(vol) {
    previewVolume = Math.max(0, Math.min(1, vol));
    localStorage.setItem(PREVIEW_VOLUME_STORAGE, String(previewVolume));
    const previewVideo = videoDisplay.getVideo();
    if (previewVideo) previewVideo.volume = previewVolume;
  }
  if (previewVolumeInput) {
    previewVolumeInput.addEventListener('input', () => {
      applyPreviewVolume(parseFloat(previewVolumeInput.value));
      if (previewVolumeNumber) previewVolumeNumber.value = String(Math.round(previewVolume * 100));
    });
  }
  if (previewVolumeNumber) {
    previewVolumeNumber.addEventListener('input', () => {
      const n = parseInt(previewVolumeNumber.value, 10);
      if (Number.isNaN(n)) return;
      const clamped = Math.max(0, Math.min(100, n));
      previewVolumeNumber.value = String(clamped);
      applyPreviewVolume(clamped / 100);
      if (previewVolumeInput) previewVolumeInput.value = String(previewVolume);
    });
  }

  // Pad volume: range 0–2, number input shows 0–100% (=value/2*100). Two-way.
  const volumeNumber = document.getElementById('pad-volume-number');
  volumeInput.addEventListener('input', () => {
    const raw = parseFloat(volumeInput.value);
    if (volumeNumber) volumeNumber.value = String(Math.round(raw / 2 * 100));
    autoCommitPad(position, { volume: raw });
  });
  if (volumeNumber) {
    volumeNumber.addEventListener('input', () => {
      const n = parseInt(volumeNumber.value, 10);
      if (Number.isNaN(n)) return;
      const clamped = Math.max(0, Math.min(100, n));
      volumeNumber.value = String(clamped);
      const raw = clamped / 100 * 2;
      volumeInput.value = String(raw);
      autoCommitPad(position, { volume: raw });
    });
  }

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
    const videoId = videoSelect.value;
    if (!videoId) return;
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };

    playBtn.disabled = true;
    pauseBtn.disabled = true;
    try {
      const ok = await videoDisplay.playSegment({
        videoId,
        url: api.getVideoUrl(videoId),
        start: segment.start,
        end: segment.end,
        muted: false,
        volume: previewVolume,
        onStop: () => setTransportState(false),
      });
      if (!ok) {
        showToast(t('toast.previewPlayFailed'), 'error');
        return;
      }
      setTransportState(true);
      syncPlayhead(videoId);
    } finally {
      playBtn.disabled = false;
      pauseBtn.disabled = false;
    }
  }

  function pausePreview() {
    videoDisplay.pause();
    setTransportState(false);
  }

  function stopPreview() {
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };
    videoDisplay.pause();
    videoDisplay.seek(segment.start);
    setTransportState(false);
    if (editorWaveform) editorWaveform.setPlayhead(segment.start);
    updatePreviewTime();
  }

  playBtn.addEventListener('click', playPreview);
  pauseBtn.addEventListener('click', pausePreview);
  stopBtn.addEventListener('click', stopPreview);

  // Mark in/out
  setInBtn.addEventListener('click', () => {
    const previewVideo = videoDisplay.getVideo();
    if (!previewVideo) return;
    const time = previewVideo.currentTime;
    const end = parseTime(endInput.value);
    startInput.value = formatTime(time);
    endInput.value = formatTime(Math.max(time + 0.1, end));
    updateSegmentFromInputs();
  });

  setOutBtn.addEventListener('click', () => {
    const previewVideo = videoDisplay.getVideo();
    if (!previewVideo) return;
    const time = previewVideo.currentTime;
    const start = parseTime(startInput.value);
    endInput.value = formatTime(Math.max(time, start + 0.1));
    updateSegmentFromInputs();
  });

  saveBtn.addEventListener('click', () => {
    const segment = editorWaveform ? editorWaveform.getSegment() : { start: 0, end: 0 };
    const key = keyCapture.dataset.key || '';
    // Tune/Cutoff/Resonance/Reverb Send/Delay Send are now edited live via the
    // PAD knob strip (auto-committed there) — start from the pad's existing
    // data so this explicit "Apply to PAD" doesn't wipe those out.
    const data = {
      ...(pads.getData(position) || {}),
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
let maxCacheGb = 5;
let videoPage = 1;
let videoSearchTerm = '';
const VIDEO_PAGE_SIZE = 8;

async function refreshVideos() {
  try {
    const { videos, active, maxCacheGb: serverMaxCacheGb } = await api.listVideos();
    if (typeof serverMaxCacheGb === 'number') maxCacheGb = serverMaxCacheGb;
    store.set({ videos, activeDownloads: active });
    renderVideoList();
    updateCacheUsage();
  } catch (err) {
    showToast(t('toast.videosLoadFailed', { message: err.message }), 'error');
  }
}

function updateCacheUsage() {
  const el = document.getElementById('cache-usage');
  if (!el) return;
  const { videos } = store.get();
  const usedBytes = videos.reduce((sum, v) => sum + (v.sizeBytes || 0), 0);
  const usedGb = (usedBytes / 1024 ** 3).toFixed(1);
  el.textContent = t('video.cacheUsage', { used: usedGb, total: maxCacheGb });
}

function statusLabel(status) {
  return t(`video.status.${status}`) || status;
}

// The server (src/services/downloader.js) prefers exposing a machine-readable
// `code` (RATE_LIMIT/BLOCKED/UNAVAILABLE) on both active-download entries and
// the download:error payload. These regexes are only a fallback for payloads
// that carry a raw message without a `code` field.
const BOT_CHECK_PATTERN = /Sign in to confirm|bot-check|DRM protected/i;
const RATE_LIMIT_PATTERN = /429|Too Many Requests/i;
const UNAVAILABLE_PATTERN = /Private video|video is private|Video unavailable|has been removed|account (has been )?terminated|not available in your country|blocked it in your country|members-only|join this channel|This live (event|stream) will begin|Premieres in|confirm your age|age-restricted/i;

// Order matches the server's classifyError: unavailable first, then
// rate_limit, then the bot-check/DRM ("blocked") fallback — a 429 can drag
// incidental format-related tokens into its message, so checking rate_limit
// before blocked avoids misreading a throttle as a client-gated failure.
function classifyErrorBucket({ code, error } = {}) {
  if (code === 'RATE_LIMIT') return 'rateLimit';
  if (code === 'BLOCKED') return 'blocked';
  if (code === 'UNAVAILABLE') return 'unavailable';
  const message = error || '';
  if (UNAVAILABLE_PATTERN.test(message)) return 'unavailable';
  if (RATE_LIMIT_PATTERN.test(message)) return 'rateLimit';
  if (BOT_CHECK_PATTERN.test(message)) return 'blocked';
  return null;
}

function renderVideoList() {
  const list = document.getElementById('video-list');
  const { videos, activeDownloads } = store.get();
  list.innerHTML = '';

  // The store already carries completed downloads once they're saved, but
  // activeDownloads keeps a 'ready' entry around for a 30s cleanup window
  // (see downloader.js). Without this dedupe, that entry would render as a
  // ghost second row (videoId as title) until the window closes.
  const readyIds = new Set(videos.map((v) => v.videoId));

  const all = [
    ...videos.map((v) => ({ ...v, status: 'ready' })),
    ...activeDownloads.filter((a) => !readyIds.has(a.videoId)).map((a) => ({
      videoId: a.videoId,
      title: a.videoId,
      duration: 0,
      status: a.status,
      progress: a.progress,
      error: a.error,
      code: a.code,
      url: a.url,
      retryAttempt: a.retryAttempt,
      retryMax: a.retryMax,
    })),
  ];

  // Filter by the search term (matches title or videoId) before paginating, so
  // the pager reflects the filtered set. videoSearchTerm is already lowercased.
  const filtered = videoSearchTerm
    ? all.filter((v) => (v.title || v.videoId).toLowerCase().includes(videoSearchTerm))
    : all;

  const totalPages = Math.max(1, Math.ceil(filtered.length / VIDEO_PAGE_SIZE));
  videoPage = Math.min(videoPage, totalPages);
  const pageItems = filtered.slice((videoPage - 1) * VIDEO_PAGE_SIZE, videoPage * VIDEO_PAGE_SIZE);

  if (pageItems.length === 0 && all.length > 0) {
    const empty = document.createElement('li');
    empty.className = 'video-empty';
    empty.textContent = t('video.emptySearch');
    list.appendChild(empty);
  }

  for (const video of pageItems) {
    const li = document.createElement('li');
    li.className = 'video-item';

    let statusHtml;
    if (video.status === 'downloading') {
      statusHtml = `<span class="status downloading"><span class="loading-spinner"></span>${Math.round(video.progress || 0)}%</span>`;
    } else if (video.status === 'extracting') {
      // Same spinner treatment as downloading/retrying — this is a normal
      // in-progress phase (local audio extraction), not a failure.
      statusHtml = `<span class="status extracting"><span class="loading-spinner"></span>${t('video.status.extracting')}</span>`;
    } else if (video.status === 'retrying') {
      // Same spinner as 'downloading' — this reads as self-healing in
      // progress, not as a failure, so it deliberately avoids the error look.
      const label = t('video.statusRetrying', { attempt: video.retryAttempt, max: video.retryMax });
      statusHtml = `<span class="status retrying"><span class="loading-spinner"></span>${label}</span>`;
    } else if (video.status === 'error') {
      const fullError = video.error || '';
      const bucket = classifyErrorBucket(video);
      const label = bucket === 'rateLimit' ? t('video.errorRateLimit')
        : bucket === 'blocked' ? t('video.errorBlocked')
        : bucket === 'unavailable' ? t('video.errorUnavailable')
        : t('video.errorGeneric');
      // Retry doesn't apply to UNAVAILABLE — that bucket is a terminal
      // classification (private/removed/region-locked), retrying it just
      // re-runs the same failure.
      const retryBtn = bucket === 'unavailable'
        ? ''
        : `<button type="button" class="link-btn" data-retry-cta>${t('common.retry')}</button>`;
      statusHtml = `
        <div class="video-item-status-wrap">
          <span class="status error" title="${escapeHtml(fullError)}">${label}</span>
          ${retryBtn}
        </div>
      `;
    } else {
      statusHtml = `<span class="status ${video.status}">${statusLabel(video.status)}</span>`;
    }

    const sliceBtnHtml = video.status === 'ready'
      ? `<button type="button" class="video-slice-btn" data-slice-id="${video.videoId}" data-i18n-title="slicer.openTitle" title="${t('slicer.openTitle')}"><span class="material-symbols-outlined">content_cut</span></button>`
      : '';

    li.innerHTML = `
      <div class="video-item-info">
        <span class="video-item-title">${escapeHtml(video.title || video.videoId)}</span>
        <span class="video-item-meta">${formatTime(video.duration || 0)} · ${video.videoId}</span>
      </div>
      ${statusHtml}
      ${sliceBtnHtml}
      <button data-id="${video.videoId}" title="${t('common.remove')}">×</button>
    `;

    // Full-detail tooltip on the info block (never clipped — fixed-positioned).
    // Set via the DOM API, NOT string interpolation: the title is attacker-
    // controlled (any uploader can name a video) and escapeHtml doesn't escape
    // quotes, so building the attribute as a string would be injectable.
    const infoEl = li.querySelector('.video-item-info');
    if (infoEl) {
      infoEl.classList.add('has-tip');
      const detail = [video.title || video.videoId, formatTime(video.duration || 0)];
      if (video.sizeBytes) detail.push(formatBytes(video.sizeBytes));
      detail.push(video.videoId);
      infoEl.dataset.tooltip = detail.join('\n');
    }

    const sliceBtn = li.querySelector('[data-slice-id]');
    if (sliceBtn) {
      sliceBtn.addEventListener('click', () => {
        // Opening the takeover from a collapsed rail must still work — force
        // it expanded first (the takeover's CSS makes the panel full-viewport
        // either way, but this keeps the toggle's own state/aria in sync).
        if (librarySidenavToggle && librarySidenavToggle.isCollapsed()) librarySidenavToggle.expand();
        slicer.openForVideo(video.videoId);
      });
    }

    const retryBtn = li.querySelector('[data-retry-cta]');
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        // Disable synchronously, before any await, to prevent a double-click
        // from firing two overlapping retry requests for the same video.
        retryBtn.disabled = true;
        // Delete first so the server's dedupe in queueDownload doesn't turn
        // the re-add into a silent no-op — an errored entry is never
        // auto-removed, so without this the retry would do nothing.
        await api.deleteVideo(video.videoId).catch(() => {});
        try {
          await api.addVideo(video.url);
          showToast(t('toast.retryQueued'), 'success');
          await refreshVideos();
        } catch (err) {
          retryBtn.disabled = false;
          showToast(t('toast.addFailed', { message: err.message }), 'error');
        }
      });
    }

    li.querySelector('button[data-id]').addEventListener('click', async () => {
      try {
        await api.deleteVideo(video.videoId);
        audio.unload(video.videoId);
        slicer.handleVideoRemoved(video.videoId);
        showToast(t('toast.videoRemoved', { name: video.title || video.videoId }), 'success');
        videoPage = 1;
        await refreshVideos();
      } catch (err) {
        showToast(t('toast.removeFailed', { message: err.message }), 'error');
      }
    });

    list.appendChild(li);
  }

  renderVideoPager(totalPages);
}

function renderVideoPager(totalPages) {
  const pager = document.getElementById('video-pager');
  if (!pager) return;

  if (totalPages <= 1) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }

  pager.hidden = false;
  pager.innerHTML = `
    <button type="button" class="btn btn-secondary btn-pager" id="video-page-prev" title="${t('video.pagePrev')}" aria-label="${t('video.pagePrev')}" ${videoPage <= 1 ? 'disabled' : ''}>&lsaquo;</button>
    <span class="video-pager-info">${t('video.pageInfo', { page: videoPage, total: totalPages })}</span>
    <button type="button" class="btn btn-secondary btn-pager" id="video-page-next" title="${t('video.pageNext')}" aria-label="${t('video.pageNext')}" ${videoPage >= totalPages ? 'disabled' : ''}>&rsaquo;</button>
  `;

  const prevBtn = document.getElementById('video-page-prev');
  const nextBtn = document.getElementById('video-page-next');
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      videoPage = Math.max(1, videoPage - 1);
      renderVideoList();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      videoPage = Math.min(totalPages, videoPage + 1);
      renderVideoList();
    });
  }
}

// Add video form
// Video Library search — filters the in-memory list on each render. The input
// is static markup (not rebuilt by renderVideoList), so its value/focus survive
// the 2s poll; the term lives in videoSearchTerm so the poll re-applies it.
document.getElementById('video-search')?.addEventListener('input', (e) => {
  videoSearchTerm = e.target.value.trim().toLowerCase();
  videoPage = 1;
  renderVideoList();
});

document.getElementById('add-video-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('video-url');
  const url = input.value.trim();
  if (!url) return;

  if (!isValidYouTubeUrl(url)) {
    showToast(t('toast.invalidYoutubeUrl'), 'error');
    return;
  }

  try {
    const result = await api.addVideo(url);
    input.value = '';
    if (result.status === 'ready') {
      showToast(t('toast.videoAlreadyAvailable'), 'success');
    } else {
      showToast(t('toast.videoQueued'), 'info');
    }
    videoPage = 1;
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

const viewLogsBtn = document.getElementById('btn-view-logs');
if (viewLogsBtn) {
  viewLogsBtn.addEventListener('click', openLogsModal);
}

// WebSocket events
ws.on('download:progress', refreshVideos);
ws.on('download:ready', refreshVideos);
ws.on('download:error', (payload) => {
  const message = payload && payload.error;
  if (message) {
    const bucket = classifyErrorBucket(payload);
    const toastMessage = bucket === 'rateLimit' ? t('toast.rateLimitDetected')
      : bucket === 'blocked' ? t('toast.blockedDetected')
      : bucket === 'unavailable' ? t('toast.unavailableDetected')
      : message;
    showToast(toastMessage, 'error');
  }
  refreshVideos();
});
// Self-healing in progress (see downloader.js's retry loop) — the list
// rendering already shows the 'retrying' spinner/label, so this just keeps
// the active-downloads state fresh; no toast (would spam on every attempt).
ws.on('download:retrying', refreshVideos);
// Local ffmpeg audio extraction phase — same rationale as 'retrying' above:
// keeps the list's 'extracting' spinner/label fresh, no toast needed.
ws.on('download:extracting', refreshVideos);
ws.on('video:removed', (payload) => {
  // The video's audio may still be cached/open in the Auto-Slicer takeover
  // (e.g. removed from another tab, or by the self-healing retry/error
  // path) — close it without the usual confirm modal, since there's
  // nothing left to confirm once the source video is gone.
  if (payload && payload.videoId) slicer.handleVideoRemoved(payload.videoId);
  refreshVideos();
});

// Session Manager
const sessionManager = createSessionManager({
  showToast,
  openConfirmModal,
  // Gathers the save payload and runs the pre-save guard; returning null aborts
  // before the Save modal opens (the pad-key guard selects the offender).
  collectSessionData() {
    const incomplete = findPadMissingKey();
    if (incomplete) {
      showToast(t('organize.saveBlockedMissingKey', { position: incomplete.position }), 'warning');
      pads.select(incomplete.position);
      return null;
    }
    return {
      pads: pads.getAll(),
      masterFx: masterFxControls ? masterFxControls.getState() : undefined,
    };
  },
  onSessionLoad(session) {
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

// Auto-Slicer takeover view
const slicer = createSlicer({
  api,
  audio,
  pads,
  store,
  sessionManager,
  showToast,
  openConfirmModal,
  t,
});

// Export session
const exportBtn = document.getElementById('btn-export-session');
if (exportBtn) {
  exportBtn.addEventListener('click', async () => {
    const current = sessionManager.getCurrent();
    if (!current?.name) {
      showToast(t('toast.saveOrLoadBeforeExport'), 'error');
      return;
    }
    const incomplete = findPadMissingKey();
    if (incomplete) {
      showToast(t('organize.saveBlockedMissingKey', { position: incomplete.position }), 'warning');
      pads.select(incomplete.position);
      return;
    }
    // Save first so the export reflects live/auto-committed pad edits, not
    // whatever was last written to disk.
    try {
      const saved = await sessionManager.save({
        name: current.name,
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

const clearCacheBtn = document.getElementById('btn-clear-cache');
if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', () => {
    openConfirmModal({
      title: t('cache.confirmTitle'),
      body: t('cache.confirmBody'),
      confirmLabel: t('cache.confirmButton'),
      onConfirm: async () => {
        try {
          await api.deleteAllVideos();
          await refreshVideos();
          showToast(t('toast.cacheCleared'), 'success');
        } catch (err) {
          showToast(t('toast.cacheClearFailed', { message: err.message }), 'error');
        }
      },
    });
  });
}

// Locale switcher — a custom button+popover instead of a native <select>,
// since <option> can't embed the SVG flag icon (plain text only), which made
// the flag emoji unreliable across platforms/fonts.
function initLocaleSwitcher() {
  const wrap = document.getElementById('locale-switcher');
  const btn = document.getElementById('locale-btn');
  const menu = document.getElementById('locale-menu');
  if (!wrap || !btn || !menu) return;

  const flagEl = btn.querySelector('[data-flag]');
  const codeEl = btn.querySelector('[data-code]');

  function paint(locale) {
    const option = menu.querySelector(`[data-locale="${locale}"]`) || menu.querySelector('[data-locale="en"]');
    const flagHtml = option.querySelector('.locale-flag').innerHTML;
    flagEl.innerHTML = flagHtml;
    codeEl.textContent = option.querySelector('span:last-child').textContent;
    // The collapsed-header grip has its own mini flag-only button (no code
    // span, room is 22px) — it's a separate DOM node from `btn`, so it needs
    // its own paint or it stays a visually-empty icon forever.
    const gripFlagEl = document.getElementById('grip-locale-btn')?.querySelector('[data-flag]');
    if (gripFlagEl) gripFlagEl.innerHTML = flagHtml;
  }

  // trigger defaults to the header button, but the collapsed-header mini flag
  // button can pass itself so the fixed menu positions under whichever was
  // clicked. aria-expanded is written on the actual trigger (and cleared on
  // the other) so the invisible one doesn't stay marked expanded.
  function setOpen(open, trigger = btn) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? String(trigger === btn) : 'false');
    const gripBtn = document.getElementById('grip-locale-btn');
    if (gripBtn) gripBtn.setAttribute('aria-expanded', open ? String(trigger !== btn) : 'false');
    if (open) positionMenu(menu, trigger);
  }

  headerMenuClosers.push(() => setOpen(false));

  paint(getLocale());

  btn.addEventListener('click', () => setOpen(menu.hidden, btn));

  menu.addEventListener('click', (e) => {
    const option = e.target.closest('[data-locale]');
    if (!option) return;

    setLocale(option.dataset.locale);
    applyTranslations(document);
    syncAllToggles();
    paint(option.dataset.locale);
    setOpen(false);

    // Re-render already-painted dynamic content that depends on text.
    const selectedPosition = store.get().selectedPosition;
    const currentPad = store.get().currentPad;
    if (selectedPosition) {
      renderPadEditor(selectedPosition, currentPad);
    }
    renderVideoList();
    sessionManager.refreshList();
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target) && !e.target.closest('#grip-locale-btn')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  return { toggle: (trigger) => setOpen(menu.hidden, trigger) };
}

// Permanent kebab menu for the header's secondary actions. The real buttons
// stay in the DOM (hidden via .is-proxied) so their handlers keep working; a
// data-proxy item just clicks its button, so behavior has a single source. A
// data-action item runs an inline action (e.g. opening the Settings modal).
const PINNED_ACTIONS_STORAGE = 'puma-pinned-actions';
const PINNABLE_IDS = [
  'btn-new-session',
  'btn-manage-sessions',
  'btn-export-session',
  'btn-import-session',
  'btn-view-logs',
];

// Icon + tooltip key per pinnable action, used to render the collapsed-header
// grip strip buttons. Tooltip keys reuse existing i18n strings (no new keys).
const PINNED_ACTION_META = {
  'btn-new-session': { icon: 'add', titleKey: 'header.new' },
  'btn-manage-sessions': { icon: 'folder_managed', titleKey: 'session.manageTitle' },
  'btn-export-session': { icon: 'download', titleKey: 'header.exportTitle' },
  'btn-import-session': { icon: 'upload', titleKey: 'header.importTitle' },
  'btn-view-logs': { icon: 'receipt_long', titleKey: 'header.logsTitle' },
};

function getPinnedActions() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_ACTIONS_STORAGE));
    if (Array.isArray(raw)) return raw.filter((id) => PINNABLE_IDS.includes(id));
  } catch {
    // ignore malformed storage — fall through to default
  }
  return [];
}

function initHeaderMoreMenu() {
  const wrap = document.getElementById('header-more');
  const btn = document.getElementById('btn-header-more');
  const menu = document.getElementById('header-more-menu');
  if (!wrap || !btn || !menu) return;

  // trigger defaults to the kebab button; the collapsed-header mini ⋯ button
  // can pass itself so the fixed menu positions under whichever was clicked.
  function setOpen(open, trigger = btn) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? String(trigger === btn) : 'false');
    const gripBtn = document.getElementById('grip-more-btn');
    if (gripBtn) gripBtn.setAttribute('aria-expanded', open ? String(trigger !== btn) : 'false');
    if (open) positionMenu(menu, trigger);
  }

  // Pinned actions also appear as navbar buttons. The 5 target buttons live in
  // .session-controls (document-scoped lookup), while their pin toggles live
  // inside this menu (menu-scoped).
  function applyPinnedState() {
    const pinned = getPinnedActions();
    for (const id of PINNABLE_IDS) {
      const isPinned = pinned.includes(id);
      const targetBtn = document.getElementById(id);
      if (targetBtn) targetBtn.classList.toggle('is-proxied', !isPinned);
      const pinEl = menu.querySelector(`.menu-pin[data-pin="${id}"]`);
      if (pinEl) pinEl.setAttribute('aria-pressed', String(isPinned));
    }
    renderGripPinnedActions(pinned);
  }

  // Mirrors pinned actions as small icon buttons in the collapsed-header grip
  // strip, so they stay reachable without expanding the header. Rebuilt from
  // scratch on every change — the list is short and this keeps ordering (and
  // pin/unpin) trivial instead of diffing DOM nodes.
  function renderGripPinnedActions(pinned) {
    const container = document.getElementById('grip-pinned-actions');
    if (!container) return;
    container.innerHTML = '';
    for (const id of PINNABLE_IDS) {
      if (!pinned.includes(id)) continue;
      const meta = PINNED_ACTION_META[id];
      if (!meta) continue;
      const gripBtn = document.createElement('button');
      gripBtn.type = 'button';
      gripBtn.className = 'grip-pin-btn';
      gripBtn.dataset.proxy = id;
      gripBtn.dataset.i18nTitle = meta.titleKey;
      gripBtn.title = t(meta.titleKey);
      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.textContent = meta.icon;
      gripBtn.appendChild(icon);
      gripBtn.addEventListener('click', () => {
        const target = document.getElementById(id);
        if (target) target.click();
      });
      container.appendChild(gripBtn);
    }
  }

  function togglePin(id) {
    if (!PINNABLE_IDS.includes(id)) return;
    const pinned = getPinnedActions();
    const idx = pinned.indexOf(id);
    if (idx >= 0) pinned.splice(idx, 1);
    else pinned.push(id);
    localStorage.setItem(PINNED_ACTIONS_STORAGE, JSON.stringify(pinned));
    applyPinnedState();
  }

  headerMenuClosers.push(() => setOpen(false));

  btn.addEventListener('click', () => setOpen(menu.hidden, btn));

  menu.addEventListener('click', (e) => {
    // Pin clicks toggle navbar visibility and keep the menu open. The pin's
    // icon span has pointer-events:none (app.css), so clicks on it resolve to
    // the .menu-pin button and this guard catches them before the action below.
    const pin = e.target.closest('.menu-pin');
    if (pin) {
      togglePin(pin.dataset.pin);
      return;
    }
    const item = e.target.closest('[data-proxy], [data-action]');
    if (!item) return;
    setOpen(false);
    if (item.dataset.action === 'settings') {
      openSettingsModal();
      return;
    }
    const target = document.getElementById(item.dataset.proxy);
    if (target) target.click();
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target) && !e.target.closest('#grip-more-btn')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  applyPinnedState();

  return { toggle: (trigger) => setOpen(menu.hidden, trigger) };
}

// Session picker for the collapsed-header grip: a fixed dropdown (like the
// kebab/locale menus) so it doesn't expand the header. Populated on open from
// the already-polled #session-select options, so no async fetch is needed.
function initGripSessionMenu() {
  const wrap = document.getElementById('grip-session-wrap');
  const menu = document.getElementById('grip-session-menu');
  if (!wrap || !menu) return null;

  function setOpen(open, trigger) {
    if (open) {
      const select = document.getElementById('session-select');
      const names = select
        ? Array.from(select.options).map((o) => o.value).filter(Boolean)
        : [];
      menu.innerHTML = '';
      if (names.length === 0) {
        const li = document.createElement('li');
        li.className = 'grip-session-empty';
        li.textContent = t('session.emptyList');
        menu.appendChild(li);
      } else {
        for (const name of names) {
          const li = document.createElement('li');
          li.setAttribute('role', 'menuitem');
          li.dataset.name = name;
          li.textContent = name;
          menu.appendChild(li);
        }
      }
    }
    menu.hidden = !open;
    if (open) positionMenu(menu, trigger);
  }

  headerMenuClosers.push(() => setOpen(false));

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-name]');
    if (!item) return;
    setOpen(false);
    sessionManager.load(item.dataset.name);
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target) && !e.target.closest('#grip-session-btn')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  return { toggle: (trigger) => setOpen(menu.hidden, trigger) };
}

// Mini action buttons shown in the collapsed-header grip. They proxy the real
// controls (stop/save) or open the same fixed menus positioned under the mini
// trigger. stopPropagation keeps a click from also toggling the grip.
function initGripActions({ localeSwitcher, headerMore, gripSession } = {}) {
  document.getElementById('grip-stop-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('btn-stop-all')?.click();
  });
  document.getElementById('grip-save-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('btn-save-session')?.click();
  });
  document.getElementById('grip-session-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    gripSession?.toggle(e.currentTarget);
  });
  document.getElementById('grip-locale-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    localeSwitcher?.toggle(e.currentTarget);
  });
  document.getElementById('grip-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    headerMore?.toggle(e.currentTarget);
  });
}

// Initial load
const panelToggleControllers = initPanelToggle();
const librarySidenavToggle = initLibrarySidenav();
const padsSidenavToggle = initPadsSidenav();
const headerToggle = initHeaderToggle();
const localeSwitcher = initLocaleSwitcher();
const headerMore = initHeaderMoreMenu();
const gripSession = initGripSessionMenu();
initGripActions({ localeSwitcher, headerMore, gripSession });
initTooltipPositioning();
applyFontScale(getFontScale());
refreshAutosave();

// Toggles whose title/aria-expanded depend on collapsed state, not just the
// static data-i18n-title attribute. applyTranslations() resets el.title from
// that attribute on every locale switch, which would stomp the state-aware
// title these toggles compute — see syncAllToggles() calls after each
// applyTranslations(document) below.
syncableToggles = [
  headerToggle,
  librarySidenavToggle,
  padsSidenavToggle,
  ...panelToggleControllers.map((c) => c.ctrl),
].filter(Boolean);

let librarySidenavResize = null;
let padsSidenavResize = null;

const librarySidenavEl = document.getElementById('library-sidenav');
if (librarySidenavEl && librarySidenavToggle) {
  librarySidenavResize = makeResizable(librarySidenavEl, {
    edge: 'left',
    dimension: 'width',
    min: 220,
    max: () => Math.min(500, window.innerWidth * 0.9),
    collapseBelow: 286,
    onCollapse: () => librarySidenavToggle.collapse(),
    isCollapsed: librarySidenavToggle.isCollapsed,
    onExpand: () => librarySidenavToggle.expand(),
  });
}

const padsSidenavEl = document.getElementById('pads-sidenav');
if (padsSidenavEl && padsSidenavToggle) {
  padsSidenavResize = makeResizable(padsSidenavEl, {
    edge: 'right',
    dimension: 'width',
    min: 300,
    max: () => Math.min(720, window.innerWidth * 0.6),
    collapseBelow: 360,
    onCollapse: () => padsSidenavToggle.collapse(),
    isCollapsed: padsSidenavToggle.isCollapsed,
    onExpand: () => padsSidenavToggle.expand(),
  });
}

const padEditorPanelEl = document.getElementById('pad-editor-panel');
const padEditorToggle = panelToggleControllers.find((c) => c.panel === padEditorPanelEl)?.ctrl;
if (padEditorPanelEl && padEditorToggle) {
  makeResizable(padEditorPanelEl, {
    edge: 'top',
    dimension: 'height',
    min: 160,
    max: 600,
    collapseBelow: 332,
    onCollapse: () => padEditorToggle.collapse(),
    isCollapsed: padEditorToggle.isCollapsed,
    onExpand: () => padEditorToggle.expand(),
    onResizeEnd: () => {
      if (editorWaveform) {
        editorWaveform.resize();
        editorWaveform.draw();
      }
    },
  });
}

// PADS ⇄ VIDEOS swap. Physical DOM reorder (keeps DOM=visual=tab order) that
// never touches .right-panel (holds the live <video>; reparenting it would
// reload playback). After a swap, each panel's resize handle must flip to the
// new center-facing edge.
function applyPadsVideosSwap(swapped) {
  const main = document.querySelector('.main');
  const pads = document.getElementById('pads-sidenav');
  const library = document.getElementById('library-sidenav');
  if (!main || !pads || !library) return;
  const [first, second] = swapped ? [library, pads] : [pads, library];
  main.insertBefore(first, main.firstElementChild);
  main.appendChild(second); // .right-panel is forced to the middle, never moved
  padsSidenavResize?.setEdge(swapped ? 'left' : 'right');
  librarySidenavResize?.setEdge(swapped ? 'right' : 'left');
}

function initPadsVideosSwap() {
  let swapped = localStorage.getItem(PADS_VIDEOS_SWAP_STORAGE) === 'true';
  applyPadsVideosSwap(swapped);
  function toggle() {
    swapped = !swapped;
    localStorage.setItem(PADS_VIDEOS_SWAP_STORAGE, String(swapped));
    applyPadsVideosSwap(swapped);
  }
  document.getElementById('pads-swap-btn')?.addEventListener('click', toggle);
  document.getElementById('library-swap-btn')?.addEventListener('click', toggle);
}
initPadsVideosSwap();

applyTranslations(document);
syncAllToggles();
masterFxControls = initMasterControls();
padFxControls = initPadFxControls();
enhanceKnobs(document);
refreshVideos();
setInterval(refreshVideos, 2000);
setInterval(() => sessionManager.refreshList(), 10000);

showToast(t('toast.appReady'), 'success');
