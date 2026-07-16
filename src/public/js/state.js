export function createStore(initialState = {}) {
  let state = { ...initialState };
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(partial) {
    state = { ...state, ...partial };
    listeners.forEach((fn) => fn(state));
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { get, set, subscribe };
}

export function formatTime(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '00:00.000';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

export function buildKeyCombo(e) {
  const modifiers = [];
  if (e.ctrlKey) modifiers.push('ctrl');
  if (e.altKey) modifiers.push('alt');
  if (e.metaKey) modifiers.push('meta');
  if (e.shiftKey && e.key.length > 1) modifiers.push('shift');

  const key = e.key.toLowerCase();
  return modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key;
}

export function parseTime(text) {
  if (typeof text === 'number') return text;
  if (!text) return 0;

  const parts = text.toString().split(':');
  let total = 0;

  if (parts.length === 1) {
    total = parseFloat(parts[0]);
  } else if (parts.length === 2) {
    total = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  } else if (parts.length === 3) {
    total = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }

  return Number.isNaN(total) ? 0 : total;
}
