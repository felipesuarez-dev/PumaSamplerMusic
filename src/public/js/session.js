import { api } from './api.js';

export function createSessionManager(options = {}) {
  const { onSessionLoad, onSessionListChange, showToast } = options;
  const nameInput = document.getElementById('session-name');
  const saveBtn = document.getElementById('btn-save-session');
  const newBtn = document.getElementById('btn-new-session');
  const select = document.getElementById('session-select');

  let currentSession = null;

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
    } catch (err) {
      console.error('Failed to list sessions:', err);
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

  function newSession() {
    currentSession = null;
    nameInput.value = '';
    select.value = '';
    if (onSessionLoad) onSessionLoad({ name: '', pads: [] });
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
