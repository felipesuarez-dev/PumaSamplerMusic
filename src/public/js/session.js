import { api } from './api.js';
import { t } from './i18n.js';

// --- Minimal client-side ZIP reader ----------------------------------------
// The project is vanilla JS with no bundler/build step, so we can't pull in
// a real zip library. Session export zips (built server-side with
// `archiver` + zlib) are read here well enough to pull out a single named
// entry ("session.json") using the central directory (this is more robust
// than trusting the local file header, since it works even when the writer
// used a trailing data descriptor instead of exact sizes up front). Actual
// inflation is done via the browser's built-in DecompressionStream, so no
// deflate implementation has to be hand-rolled.

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(t('error.zipUnsupportedBrowser'));
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// Shared by readZipEntryText and readZipEntryBytes -- scans the central
// directory for `entryName` and returns its decompressed raw bytes. Kept
// separate from the two thin wrappers below so the binary variant (needed to
// pull a media manifest's opus files back out of an export ZIP) doesn't have
// to duplicate this parsing.
async function readZipEntryRaw(file, entryName) {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const EOCD_SIG = 0x06054b50;
  const MIN_EOCD_SIZE = 22;
  const MAX_COMMENT_SIZE = 65535;
  const searchStart = Math.max(0, bytes.length - MIN_EOCD_SIZE - MAX_COMMENT_SIZE);

  let eocdOffset = -1;
  for (let i = bytes.length - MIN_EOCD_SIZE; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error(t('error.zipInvalidEocd'));
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const CENTRAL_DIR_SIG = 0x02014b50;
  const LOCAL_HEADER_SIG = 0x04034b50;
  const decoder = new TextDecoder();

  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIG) {
      throw new Error(t('error.zipMalformedCentralDir'));
    }
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    if (name === entryName) {
      if (view.getUint32(localHeaderOffset, true) !== LOCAL_HEADER_SIG) {
        throw new Error(t('error.zipMalformedLocalHeader'));
      }
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressedData = bytes.slice(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return compressedData;
      } else if (compressionMethod === 8) {
        return inflateRaw(compressedData);
      }
      throw new Error(t('error.zipUnsupportedCompression', { method: compressionMethod }));
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(t('error.zipEntryNotFound', { entry: entryName }));
}

async function readZipEntryText(file, entryName) {
  const rawBytes = await readZipEntryRaw(file, entryName);
  return new TextDecoder().decode(rawBytes);
}

// Binary variant of readZipEntryText -- used to pull a local media's opus
// bytes back out of a session export ZIP for restore-on-import.
async function readZipEntryBytes(file, entryName) {
  return readZipEntryRaw(file, entryName);
}

export function createSessionManager(options = {}) {
  const { onSessionLoad, onSessionListChange, showToast, openConfirmModal, collectSessionData } = options;
  const saveBtn = document.getElementById('btn-save-session');
  const newBtn = document.getElementById('btn-new-session');
  const manageBtn = document.getElementById('btn-manage-sessions');
  const select = document.getElementById('session-select');

  let currentSession = null;
  let modalOpen = false;

  async function refreshList() {
    try {
      const { sessions } = await api.listSessions();
      select.innerHTML = `<option value="">${t('header.loadSessionOption')}</option>`;
      for (const session of sessions) {
        const option = document.createElement('option');
        option.value = session.name;
        option.textContent = session.name;
        select.appendChild(option);
      }
      // Reflect the active session as the selected option (no-op if it isn't
      // in the list). currentSession drives selection everywhere.
      select.value = currentSession ? currentSession.name : '';
      if (onSessionListChange) onSessionListChange(sessions);
      return sessions;
    } catch (err) {
      console.error('Failed to list sessions:', err);
      return [];
    }
  }

  async function save(sessionData, { silent = false } = {}) {
    const name = (sessionData.name || '').trim();
    if (!name) {
      if (!silent) showToast(t('toast.enterSessionName'), 'warning');
      return;
    }

    try {
      const saved = await api.saveSession({ ...sessionData, name });
      currentSession = saved;
      if (!silent) showToast(t('toast.sessionSaved', { name: saved.name }), 'success');
      await refreshList();
      return saved;
    } catch (err) {
      if (!silent) showToast(t('toast.sessionSaveFailed', { message: err.message }), 'error');
      throw err;
    }
  }

  // Re-queues a download for any videoId a session's pads reference that
  // isn't already in the video store (e.g. evicted from cache, or cleared
  // via "Clear cache"). Shared by both load() and importFromZip() so a
  // session's videos come back regardless of how it was opened.
  //
  // `{ file, manifest }` are both optional: load() (no ZIP available) calls
  // this with neither, so every missing id falls back to the YouTube
  // re-download flow below -- which is also what happens for a manifest-less
  // ZIP (predating the media library) or for any missing id the manifest
  // doesn't otherwise mark as `source: 'local'`. Only importFromZip() passes
  // both, letting missing local media be offered a restore from the ZIP.
  async function reconcileSessionVideos(session, { file, manifest } = {}) {
    const videoIds = [...new Set((session.pads || []).map((p) => p.videoId).filter(Boolean))];
    if (videoIds.length === 0) return;

    const manifestById = new Map();
    if (Array.isArray(manifest)) {
      for (const entry of manifest) {
        if (entry && entry.videoId) manifestById.set(entry.videoId, entry);
      }
    }

    let known;
    try {
      const result = await api.listVideos();
      known = result.videos;
    } catch (err) {
      console.error('Failed to reconcile session videos:', err);
      return;
    }
    const knownIds = new Set(known.map((v) => v.videoId));
    const missingIds = videoIds.filter((id) => !knownIds.has(id));
    if (missingIds.length === 0) return;

    const localMissing = [];
    const youtubeMissing = [];
    for (const videoId of missingIds) {
      const entry = manifestById.get(videoId);
      if (manifest && entry && entry.source === 'local') {
        localMissing.push(entry);
      } else {
        youtubeMissing.push(videoId);
      }
    }

    const failed = [];
    for (const videoId of youtubeMissing) {
      try {
        await api.addVideo(`https://youtu.be/${videoId}`);
      } catch (err) {
        console.error(`Failed to reconcile video ${videoId}:`, err);
        failed.push(videoId);
      }
    }
    if (failed.length > 0) {
      showToast(t('toast.sessionImportVideosFailed', { count: failed.length }), 'warning');
    }

    if (localMissing.length === 0) return;

    if (!file) {
      // Nothing to restore from without a ZIP on hand (shouldn't normally be
      // reachable -- a manifest only exists when a ZIP was just read -- kept
      // as a defensive warn-only fallback).
      const list = localMissing.map((e) => e.title || e.videoId).join(', ');
      showToast(t('import.localSkipped', { count: localMissing.length, list }), 'warning');
      return;
    }

    // confirm() can't relabel its buttons, so the prompt text itself spells
    // out OK = Restore / Cancel = Skip (same precedent as the overwrite
    // confirm above).
    const promptList = localMissing.map((e) => e.title || e.videoId).join('\n');
    const restore = window.confirm(t('import.localMissingPrompt', { list: promptList }));

    if (!restore) {
      const skippedList = localMissing.map((e) => e.title || e.videoId).join(', ');
      showToast(t('import.localSkipped', { count: localMissing.length, list: skippedList }), 'warning');
      return;
    }

    let restoredCount = 0;
    const restoreFailed = [];
    for (const entry of localMissing) {
      try {
        const bytes = await readZipEntryBytes(file, `audio/${entry.videoId}.opus`);
        await api.restoreLocalAudio(entry.videoId, bytes, entry.title || entry.videoId);
        restoredCount += 1;
      } catch (err) {
        console.error(`Failed to restore local media ${entry.videoId}:`, err);
        restoreFailed.push(entry.title || entry.videoId);
      }
    }

    showToast(
      t('import.localRestored', { restored: restoredCount, total: localMissing.length }),
      restoredCount === localMissing.length ? 'success' : 'warning',
    );
    if (restoreFailed.length > 0) {
      showToast(t('import.localSkipped', { count: restoreFailed.length, list: restoreFailed.join(', ') }), 'warning');
    }
  }

  async function load(name) {
    if (!name) return;
    try {
      const session = await api.loadSession(name);
      currentSession = session;
      select.value = session.name;
      select.blur();
      showToast(t('toast.sessionLoaded', { name: session.name }), 'success');
      if (onSessionLoad) onSessionLoad(session);
      await reconcileSessionVideos(session);
      return session;
    } catch (err) {
      showToast(t('toast.sessionLoadFailed', { message: err.message }), 'error');
      throw err;
    }
  }

  async function importFromZip(file) {
    if (!file) return;
    try {
      const json = await readZipEntryText(file, 'session.json');
      const session = JSON.parse(json);

      const { sessions: existing } = await api.listSessions();
      if (existing.some((s) => s.name === session.name)) {
        const overwrite = window.confirm(t('session.confirmOverwrite', { name: session.name }));
        if (!overwrite) return;
      }

      const saved = await api.saveSession(session);
      currentSession = saved;
      showToast(t('toast.sessionImported', { name: saved.name }), 'success');
      await refreshList(); // sets select.value from currentSession
      if (onSessionLoad) onSessionLoad(saved);

      // media.json is optional -- only present in ZIPs exported after the
      // media library was added. Its absence just means every missing id
      // falls back to the plain YouTube reconcile flow.
      let manifest = null;
      try {
        const manifestJson = await readZipEntryText(file, 'media.json');
        manifest = JSON.parse(manifestJson);
      } catch {
        manifest = null;
      }
      await reconcileSessionVideos(saved, { file, manifest });

      return saved;
    } catch (err) {
      showToast(t('toast.sessionImportFailed', { message: err.message }), 'error');
      throw err;
    }
  }

  function clearWorkspace() {
    currentSession = null;
    select.value = '';
    if (onSessionLoad) onSessionLoad({ name: '', pads: [] });
  }

  function closeModal(modal, backdrop) {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    modalOpen = false;
  }

  async function showNewSessionModal() {
    if (modalOpen) return;

    modalOpen = true;
    const sessions = await refreshList();

    const backdrop = document.createElement('div');
    backdrop.className = 'session-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'session-modal';
    modal.innerHTML = `
      <h3>${t('session.modalTitle')}</h3>
      <p class="session-modal-hint">${t('session.modalHint')}</p>
      <div class="session-modal-actions">
        <button class="btn btn-secondary" id="modal-start-fresh">${t('session.startFresh')}</button>
        ${sessions.length > 0 ? `
          <div class="session-modal-copy-row">
            <span class="session-modal-or">${t('session.orCopyFrom')}</span>
            <select id="modal-copy-select" class="session-modal-select">
              <option value="">${t('session.selectSession')}</option>
              ${sessions.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(t('session.copySessionOption', { name: s.name, count: s.padCount || 0 }))}</option>`).join('')}
            </select>
            <button class="btn" id="modal-copy-btn">${t('common.copy')}</button>
          </div>
        ` : ''}
      </div>
      <button class="session-modal-close" id="modal-cancel" title="${t('common.cancel')}">&times;</button>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    let escHandler = null;

    function cleanup() {
      closeModal(modal, backdrop);
      if (escHandler) {
        window.removeEventListener('keydown', escHandler);
        escHandler = null;
      }
    }

    modal.querySelector('#modal-start-fresh').addEventListener('click', () => {
      cleanup();
      clearWorkspace();
    });

    if (sessions.length > 0) {
      const copySelect = modal.querySelector('#modal-copy-select');
      const copyBtn = modal.querySelector('#modal-copy-btn');
      copyBtn.addEventListener('click', async () => {
        const name = copySelect.value;
        if (!name) {
          showToast(t('toast.selectSessionToCopy'), 'warning');
          return;
        }
        cleanup();
        await load(name);
        currentSession = null; // next Save opens empty, so the copy saves as new
        showToast(t('toast.sessionCopied'), 'info');
      });
    }

    modal.querySelector('#modal-cancel').addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });

    escHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
      }
    };
    window.addEventListener('keydown', escHandler);
  }

  function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function newSession() {
    showNewSessionModal();
  }

  function formatSessionDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Scalable alternative to the flat combo: a searchable, scrollable list with
  // per-row load/delete. Session names are user text, so rows are built with
  // textContent and the delete-confirm body is pre-escaped (openConfirmModal
  // injects its body via innerHTML).
  async function showManageSessionsModal() {
    if (modalOpen) return;
    modalOpen = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'session-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'session-modal sessions-manager';
    modal.innerHTML = `
      <h3>${t('session.modalManageTitle')}</h3>
      <input type="text" class="sessions-manager-search" id="sessions-manager-search" placeholder="${escapeHtml(t('session.searchPlaceholder'))}" autocomplete="off">
      <div class="sessions-manager-list" id="sessions-manager-list"></div>
      <button class="session-modal-close" id="sessions-manager-close" title="${escapeHtml(t('common.cancel'))}">&times;</button>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const listEl = modal.querySelector('#sessions-manager-list');
    const searchEl = modal.querySelector('#sessions-manager-search');
    let sessions = [];

    function renderList() {
      const term = searchEl.value.trim().toLowerCase();
      const filtered = term ? sessions.filter((s) => s.name.toLowerCase().includes(term)) : sessions;
      listEl.innerHTML = '';

      if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'sessions-manager-empty';
        empty.textContent = sessions.length === 0 ? t('session.emptyList') : t('session.emptySearch');
        listEl.appendChild(empty);
        return;
      }

      for (const s of filtered) {
        const row = document.createElement('div');
        row.className = 'sessions-manager-row';

        const info = document.createElement('div');
        info.className = 'sessions-manager-info';
        const nameEl = document.createElement('span');
        nameEl.className = 'sessions-manager-name';
        nameEl.textContent = s.name;
        const metaEl = document.createElement('span');
        metaEl.className = 'sessions-manager-meta';
        const date = formatSessionDate(s.updatedAt || s.createdAt);
        metaEl.textContent = t('session.padCount', { count: s.padCount || 0 }) + (date ? ` · ${date}` : '');
        info.append(nameEl, metaEl);

        const actions = document.createElement('div');
        actions.className = 'sessions-manager-actions';
        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'btn';
        loadBtn.textContent = t('session.load');
        loadBtn.addEventListener('click', () => {
          cleanup();
          load(s.name);
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-danger';
        delBtn.textContent = t('session.delete');
        delBtn.addEventListener('click', () => requestDelete(s.name));
        actions.append(loadBtn, delBtn);

        row.append(info, actions);
        listEl.appendChild(row);
      }
    }

    async function performDelete(name) {
      try {
        await api.deleteSession(name);
        showToast(t('toast.sessionDeleted', { name }), 'success');
        sessions = await refreshList();
        renderList();
      } catch (err) {
        showToast(t('toast.sessionDeleteFailed', { message: err.message }), 'error');
      }
    }

    function requestDelete(name) {
      if (openConfirmModal) {
        openConfirmModal({
          title: t('session.deleteConfirmTitle'),
          body: t('session.deleteConfirmBody', { name: escapeHtml(name) }),
          confirmLabel: t('session.deleteConfirmButton'),
          onConfirm: () => performDelete(name),
        });
      } else if (window.confirm(t('session.deleteConfirmBody', { name }))) {
        performDelete(name);
      }
    }

    function cleanup() {
      closeModal(modal, backdrop);
      window.removeEventListener('keydown', escHandler);
    }
    function escHandler(e) {
      if (e.key === 'Escape') cleanup();
    }

    searchEl.addEventListener('input', renderList);
    modal.querySelector('#sessions-manager-close').addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });
    window.addEventListener('keydown', escHandler);

    sessions = await refreshList();
    renderList();
    searchEl.focus();
  }

  // Save opens a modal that collects the name (prefilled from the active
  // session; empty for a fresh or copied one). collectSessionData gathers the
  // pads/fx payload and runs any pre-save guards, returning null to abort.
  function showSaveModal() {
    if (modalOpen) return;
    const data = collectSessionData ? collectSessionData() : { pads: [] };
    if (data == null) return; // a guard (e.g. missing pad key) aborted
    modalOpen = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'session-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'session-modal';
    modal.innerHTML = `
      <h3>${t('session.saveModalTitle')}</h3>
      <div class="session-modal-actions">
        <input type="text" class="session-modal-input" id="save-modal-name" placeholder="${escapeHtml(t('header.sessionNamePlaceholder'))}" autocomplete="off">
        <button class="btn" id="save-modal-confirm">${escapeHtml(t('header.save'))}</button>
      </div>
      <button class="session-modal-close" id="save-modal-cancel" title="${escapeHtml(t('common.cancel'))}">&times;</button>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const nameField = modal.querySelector('#save-modal-name');
    nameField.value = currentSession?.name || '';

    let escHandler = null;
    function cleanup() {
      closeModal(modal, backdrop);
      if (escHandler) window.removeEventListener('keydown', escHandler);
    }
    async function confirm() {
      const name = nameField.value.trim();
      if (!name) {
        showToast(t('toast.enterSessionName'), 'warning');
        nameField.focus();
        return;
      }
      cleanup();
      await save({ ...data, name });
    }

    modal.querySelector('#save-modal-confirm').addEventListener('click', confirm);
    nameField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm();
    });
    modal.querySelector('#save-modal-cancel').addEventListener('click', cleanup);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup();
    });
    escHandler = (e) => {
      if (e.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', escHandler);
    nameField.focus();
  }

  saveBtn.addEventListener('click', showSaveModal);

  newBtn.addEventListener('click', newSession);
  if (manageBtn) manageBtn.addEventListener('click', showManageSessionsModal);

  select.addEventListener('change', (e) => {
    if (e.target.value) {
      load(e.target.value);
    }
  });

  refreshList();

  return {
    save,
    load,
    newSession,
    showManageSessionsModal,
    refreshList,
    importFromZip,
    clearWorkspace,
    getCurrent: () => currentSession,
  };
}
