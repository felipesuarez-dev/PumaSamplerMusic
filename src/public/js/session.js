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

async function readZipEntryText(file, entryName) {
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

      let rawBytes;
      if (compressionMethod === 0) {
        rawBytes = compressedData;
      } else if (compressionMethod === 8) {
        rawBytes = await inflateRaw(compressedData);
      } else {
        throw new Error(t('error.zipUnsupportedCompression', { method: compressionMethod }));
      }

      return decoder.decode(rawBytes);
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(t('error.zipEntryNotFound', { entry: entryName }));
}

export function createSessionManager(options = {}) {
  const { onSessionLoad, onSessionListChange, showToast } = options;
  const nameInput = document.getElementById('session-name');
  const saveBtn = document.getElementById('btn-save-session');
  const newBtn = document.getElementById('btn-new-session');
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
      if (onSessionListChange) onSessionListChange(sessions);
      return sessions;
    } catch (err) {
      console.error('Failed to list sessions:', err);
      return [];
    }
  }

  async function save(sessionData) {
    const name = nameInput.value.trim();
    if (!name) {
      showToast(t('toast.enterSessionName'), 'warning');
      return;
    }

    try {
      const saved = await api.saveSession({ ...sessionData, name });
      currentSession = saved;
      nameInput.value = saved.name;
      showToast(t('toast.sessionSaved', { name: saved.name }), 'success');
      await refreshList();
      return saved;
    } catch (err) {
      showToast(t('toast.sessionSaveFailed', { message: err.message }), 'error');
      throw err;
    }
  }

  async function load(name) {
    if (!name) return;
    try {
      const session = await api.loadSession(name);
      currentSession = session;
      nameInput.value = session.name;
      select.value = '';
      showToast(t('toast.sessionLoaded', { name: session.name }), 'success');
      if (onSessionLoad) onSessionLoad(session);
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
      nameInput.value = saved.name;
      select.value = '';
      showToast(t('toast.sessionImported', { name: saved.name }), 'success');
      await refreshList();
      if (onSessionLoad) onSessionLoad(saved);

      // Reconcile videos referenced by the imported pads: queue any that
      // aren't already loaded through the same flow used for a normal
      // YouTube URL submission (api.addVideo). Each video is reconciled
      // independently so one missing/unavailable source doesn't hide the
      // failure of the others, and any failures are surfaced to the user
      // instead of only logged (the source video may no longer exist on
      // YouTube, which this ZIP-only import path cannot recover from).
      const videoIds = [...new Set((saved.pads || []).map((p) => p.videoId).filter(Boolean))];
      const failedVideoIds = [];
      try {
        const { videos: knownVideos } = await api.listVideos();
        const knownIds = new Set(knownVideos.map((v) => v.videoId));
        for (const videoId of videoIds) {
          if (knownIds.has(videoId)) continue;
          try {
            await api.addVideo(`https://youtu.be/${videoId}`);
          } catch (err) {
            console.error(`Failed to reconcile video ${videoId} from imported session:`, err);
            failedVideoIds.push(videoId);
          }
        }
      } catch (err) {
        console.error('Failed to reconcile videos from imported session:', err);
      }
      if (failedVideoIds.length > 0) {
        showToast(t('toast.sessionImportVideosFailed', { count: failedVideoIds.length }), 'warning');
      }

      return saved;
    } catch (err) {
      showToast(t('toast.sessionImportFailed', { message: err.message }), 'error');
      throw err;
    }
  }

  function clearWorkspace() {
    currentSession = null;
    nameInput.value = '';
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

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

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
        nameInput.value = '';
        showToast(t('toast.sessionCopied'), 'info');
      });
    }

    modal.querySelector('#modal-cancel').addEventListener('click', cleanup);
    backdrop.addEventListener('click', cleanup);

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

  saveBtn.addEventListener('click', () => {
    if (options.onSaveRequest) options.onSaveRequest();
  });

  newBtn.addEventListener('click', newSession);

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
    refreshList,
    importFromZip,
    getCurrent: () => currentSession,
    setName: (name) => { nameInput.value = name; },
  };
}
