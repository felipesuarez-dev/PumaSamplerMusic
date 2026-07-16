import { api } from './api.js';

export function createSessionManager(options = {}) {
  const { onSessionLoad, onSessionListChange, hasConfiguredPads, showToast } = options;
  const nameInput = document.getElementById('session-name');
  const saveBtn = document.getElementById('btn-save-session');
  const newBtn = document.getElementById('btn-new-session');
  const select = document.getElementById('session-select');

  let currentSession = null;
  let modalOpen = false;

  async function refreshList() {
    try {
      const { sessions } = await api.listSessions();
      select.innerHTML = '<option value="">Load session...</option>';
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
      showToast('Enter a session name', 'warning');
      return;
    }

    try {
      const saved = await api.saveSession({ ...sessionData, name });
      currentSession = saved;
      nameInput.value = saved.name;
      showToast(`Session "${saved.name}" saved`, 'success');
      await refreshList();
      return saved;
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
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
      showToast(`Session "${session.name}" loaded`, 'success');
      if (onSessionLoad) onSessionLoad(session);
      return session;
    } catch (err) {
      showToast(`Load failed: ${err.message}`, 'error');
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
    const hasPads = typeof hasConfiguredPads === 'function' ? hasConfiguredPads() : false;
    if (!hasPads) {
      clearWorkspace();
      return;
    }

    modalOpen = true;
    const sessions = await refreshList();

    const backdrop = document.createElement('div');
    backdrop.className = 'session-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'session-modal';
    modal.innerHTML = `
      <h3>Start a new session</h3>
      <p class="session-modal-hint">What do you want to do with the current pads?</p>
      <div class="session-modal-actions">
        <button class="btn btn-secondary" id="modal-start-fresh">Start fresh</button>
        ${sessions.length > 0 ? `
          <div class="session-modal-copy-row">
            <span class="session-modal-or">or copy from</span>
            <select id="modal-copy-select" class="session-modal-select">
              <option value="">Select a session...</option>
              ${sessions.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} (${s.padCount || 0} pads)</option>`).join('')}
            </select>
            <button class="btn" id="modal-copy-btn">Copy</button>
          </div>
        ` : ''}
      </div>
      <button class="session-modal-close" id="modal-cancel" title="Cancel">&times;</button>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    function cleanup() {
      closeModal(modal, backdrop);
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
          showToast('Select a session to copy', 'warning');
          return;
        }
        cleanup();
        await load(name);
        setName('');
        showToast('Session copied. Enter a new name and save.', 'info');
      });
    }

    modal.querySelector('#modal-cancel').addEventListener('click', cleanup);
    backdrop.addEventListener('click', cleanup);

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        window.removeEventListener('keydown', escHandler);
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
    getCurrent: () => currentSession,
    setName: (name) => { nameInput.value = name; },
  };
}
