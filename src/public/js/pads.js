import { buildKeyCombo, formatTime } from './state.js';

export function createPads(container, options = {}, initialCount = 9) {
  const { onSelect, onTrigger, onRelease } = options;
  const pads = new Map(); // position -> pad element
  const state = new Map(); // position -> pad data
  let selectedPosition = null;
  let padCount = 0;

  function createPadElement(position) {
    const el = document.createElement('div');
    el.className = 'pad empty';
    el.dataset.position = position;

    el.innerHTML = `
      <span class="pad-key"></span>
      <span class="pad-position">${position}</span>
      <span class="pad-playing-indicator"></span>
      <span class="pad-label">Pad ${position}</span>
      <span class="pad-time"></span>
      <span class="pad-color-indicator"></span>
    `;

    el.addEventListener('click', () => select(position));

    return el;
  }

  function init(count) {
    container.innerHTML = '';
    pads.clear();
    state.clear();
    selectedPosition = null;
    padCount = count;
    for (let i = 1; i <= count; i++) {
      const el = createPadElement(i);
      pads.set(i, el);
      state.set(i, null);
      container.appendChild(el);
    }
  }

  function resize(count) {
    if (count < 1) return;
    const newCount = Math.min(count, 27);
    const oldState = Array.from(state.entries());
    init(newCount);
    for (const [position, data] of oldState) {
      if (data && position <= newCount) {
        state.set(position, data);
        render(position);
      }
    }
    if (selectedPosition && selectedPosition > newCount) {
      selectedPosition = null;
    }
    if (selectedPosition) {
      render(selectedPosition);
    }
  }

  function update(position, data) {
    state.set(position, data);
    render(position);
  }

  function render(position) {
    const el = pads.get(position);
    const data = state.get(position);
    if (!el) return;

    if (!data) {
      el.className = 'pad empty';
      el.style.background = '';
      el.style.borderColor = '';
      el.style.boxShadow = '';
      el.querySelector('.pad-key').textContent = '';
      el.querySelector('.pad-label').textContent = `Pad ${position}`;
      el.querySelector('.pad-time').textContent = '';
      el.querySelector('.pad-color-indicator').style.background = 'var(--accent)';
      return;
    }

    el.className = `pad ${selectedPosition === position ? 'selected' : ''}`;
    el.querySelector('.pad-key').textContent = data.key || '';
    el.querySelector('.pad-label').textContent = data.label || `Pad ${position}`;
    el.querySelector('.pad-time').textContent = `${formatTime(data.start)} - ${formatTime(data.end)}`;
    el.querySelector('.pad-color-indicator').style.background = data.color || 'var(--accent)';
  }

  function select(position) {
    selectedPosition = position;
    for (const pos of pads.keys()) {
      render(pos);
    }
    if (onSelect) onSelect(position, state.get(position));
  }

  function getSelected() {
    return selectedPosition;
  }

  function getData(position) {
    return state.get(position);
  }

  function getAll() {
    const result = [];
    for (const [position, data] of state.entries()) {
      if (data) {
        result.push({ position, ...data });
      }
    }
    return result;
  }

  function setAll(padsArray) {
    for (const pos of pads.keys()) {
      state.set(pos, null);
    }
    for (const pad of padsArray) {
      if (pad && pads.has(pad.position)) {
        state.set(pad.position, pad);
      }
    }
    for (const pos of pads.keys()) {
      render(pos);
    }
  }

  function applyColorActive(el, color) {
    if (!color) return;
    el.style.background = `${color}22`;
    el.style.borderColor = color;
    el.style.boxShadow = `0 0 24px ${color}55`;
  }

  function clearColorActive(el) {
    el.style.background = '';
    el.style.borderColor = '';
    el.style.boxShadow = '';
  }

  function trigger(position) {
    const el = pads.get(position);
    const data = state.get(position);
    if (el) {
      el.classList.add('active');
      applyColorActive(el, data?.color);
      setTimeout(() => {
        el.classList.remove('active');
        clearColorActive(el);
      }, 120);
    }
    if (data && onTrigger) {
      onTrigger(position, data);
    }
  }

  function release(position) {
    const el = pads.get(position);
    if (el) {
      el.classList.remove('active');
      clearColorActive(el);
    }
    const data = state.get(position);
    if (data && onRelease) {
      onRelease(position, data);
    }
  }

  function setPlaying(position, isPlaying) {
    const el = pads.get(position);
    if (!el) return;
    if (isPlaying) {
      el.classList.add('playing');
    } else {
      el.classList.remove('playing');
    }
  }

  function positionFromKey(key) {
    const normalized = key.toLowerCase();
    for (const [position, data] of state.entries()) {
      if (data && data.key.toLowerCase() === normalized) {
        return position;
      }
    }
    return null;
  }

  function handleKeyDown(e) {
    if (e.repeat) return;
    if (isInputFocused()) return;

    const combo = buildKeyCombo(e);
    const position = positionFromKey(combo);

    if (position !== null) {
      e.preventDefault();
      trigger(position);
    }
  }

  function handleKeyUp(e) {
    if (isInputFocused()) return;

    const combo = buildKeyCombo(e);
    const position = positionFromKey(combo);

    if (position !== null) {
      e.preventDefault();
      release(position);
    }
  }

  function isInputFocused() {
    if (window.__pumaKeyCapturing) return true;
    const active = document.activeElement;
    return active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.classList.contains('key-capture')
    );
  }

  function getCount() {
    return padCount;
  }

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  window.addEventListener('audiosourcestart', (e) => {
    setPlaying(e.detail.position, true);
  });

  window.addEventListener('audiosourcestop', (e) => {
    setPlaying(e.detail.position, false);
  });

  init(initialCount);

  return {
    update,
    select,
    getSelected,
    getData,
    getAll,
    setAll,
    resize,
    getCount,
    trigger,
    release,
    setPlaying,
  };
}

export { buildKeyCombo, formatTime };
