import { buildKeyCombo, formatTime } from './state.js';

export function createPads(container, options = {}, initialCount = 9) {
  const { onSelect, onTrigger, onRelease, onBeforeChange, onAfterSwap, onContextMenu } = options;
  const pads = new Map(); // position -> pad element
  const state = new Map(); // position -> pad data
  let selectedPosition = null;
  let padCount = 0;
  let capturingKey = false;

  // Organize mode swaps the grid from "play" to "manage": pointer gestures
  // drag pads around instead of triggering audio, and right-click / long-press
  // opens a management menu. Only one gesture can be active at a time.
  let organizeMode = false;
  let gesture = null;
  const DRAG_THRESHOLD_PX = 8;
  const LONG_PRESS_MS = 500;

  function createPadElement(position) {
    const el = document.createElement('div');
    el.className = 'pad empty';
    el.dataset.position = position;

    el.innerHTML = `
      <span class="pad-key"></span>
      <span class="pad-position">${position}</span>
      <span class="pad-playing-indicator"></span>
      <span class="pad-label">PAD ${position}</span>
      <span class="pad-time"></span>
      <span class="pad-color-indicator"></span>
    `;

    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (organizeMode) {
        startGesture(position, el, e);
        return;
      }
      select(position);
      trigger(position);
    });
    el.addEventListener('pointermove', (e) => {
      if (organizeMode) updateGesture(el, e);
    });
    el.addEventListener('pointerup', (e) => {
      if (organizeMode) endGesture(position, e);
      else release(position);
    });
    el.addEventListener('pointercancel', () => {
      if (organizeMode) cancelGesture();
      else release(position);
    });
    el.addEventListener('contextmenu', (e) => {
      if (!organizeMode) return;
      e.preventDefault();
      if (onContextMenu) onContextMenu(position, e.clientX, e.clientY);
    });

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
      el.querySelector('.pad-label').textContent = `PAD ${position}`;
      el.querySelector('.pad-time').textContent = '';
      el.querySelector('.pad-color-indicator').style.background = 'var(--accent)';
      return;
    }

    // classList.toggle here (not a full className reset) so it doesn't wipe
    // out the 'playing'/'active' classes that setPlaying()/trigger() manage
    // independently — otherwise any auto-committed edit (e.g. moving a PAD
    // FX knob) while a pad is looping would visually kill its "playing" glow
    // even though the audio itself never stopped.
    el.classList.remove('empty');
    el.classList.toggle('selected', selectedPosition === position);
    el.querySelector('.pad-key').textContent = data.key || '';
    el.querySelector('.pad-label').textContent = data.label || `PAD ${position}`;
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

  function setOrganizeMode(enabled) {
    organizeMode = Boolean(enabled);
    container.classList.toggle('organize-mode', organizeMode);
    if (!organizeMode) cancelGesture(); // leaving mid-drag cleans up any ghost/highlight
  }

  function isOrganizeMode() {
    return organizeMode;
  }

  // If a touched position is the currently-selected one, re-fire onSelect so
  // the editor panel and PAD FX strip refresh with the new data instead of
  // showing what used to be there (mirrors resize()'s selection refresh).
  function resyncSelection(positions) {
    if (selectedPosition !== null && positions.includes(selectedPosition) && onSelect) {
      onSelect(selectedPosition, state.get(selectedPosition));
    }
  }

  // Occupied -> occupied swaps the two pads; occupied -> empty moves the source
  // pad to the target and empties the source.
  function swap(from, to) {
    if (from === to) return;
    const dataFrom = state.get(from);
    if (!dataFrom) return;
    const dataTo = state.get(to);
    if (onBeforeChange) onBeforeChange([from, to]);
    state.set(to, { ...dataFrom, position: to });
    state.set(from, dataTo ? { ...dataTo, position: from } : null);
    render(from);
    render(to);
    resyncSelection([from, to]);
    if (onAfterSwap) onAfterSwap(from, to, Boolean(dataTo));
  }

  // Copies every setting except the key: server validation requires a unique,
  // non-empty key per pad, so the copy starts keyless and the caller routes the
  // user to assign one before the pad can play or be saved.
  function copyPad(from, to) {
    const src = state.get(from);
    if (!src || from === to) return null;
    if (onBeforeChange) onBeforeChange([to]);
    const copy = { ...src, position: to, key: '' };
    state.set(to, copy);
    render(to);
    resyncSelection([to]);
    return copy;
  }

  function clear(position) {
    if (!state.get(position)) return;
    if (onBeforeChange) onBeforeChange([position]);
    state.set(position, null);
    render(position);
    resyncSelection([position]);
  }

  // --- Organize-mode pointer gesture (drag to swap/move, long-press for menu) ---

  function startGesture(position, el, e) {
    cancelGesture();
    gesture = {
      position,
      sourceEl: el,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      longPressFired: false,
      longPressTimer: null,
      ghostEl: null,
      targetPosition: null,
      onEscape: null,
    };
    // Touch has no right-click, so a stationary long-press opens the menu.
    if (e.pointerType === 'touch' && state.get(position) && onContextMenu) {
      gesture.longPressTimer = setTimeout(() => {
        if (!gesture || gesture.dragging) return;
        gesture.longPressFired = true;
        const rect = el.getBoundingClientRect();
        onContextMenu(position, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }, LONG_PRESS_MS);
    }
  }

  function updateGesture(el, e) {
    if (!gesture) return;
    if (!gesture.dragging) {
      if (gesture.longPressFired) return;
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      clearLongPress();
      if (!state.get(gesture.position)) return; // nothing to drag from an empty pad
      beginDrag();
    }
    moveGhost(e.clientX, e.clientY);
    updateDropTarget(e.clientX, e.clientY);
  }

  function beginDrag() {
    gesture.dragging = true;
    gesture.sourceEl.classList.add('dragging');
    gesture.ghostEl = createGhost(gesture.position);
    gesture.onEscape = (ev) => {
      if (ev.key === 'Escape') cancelGesture();
    };
    window.addEventListener('keydown', gesture.onEscape);
  }

  function endGesture(position, e) {
    if (!gesture) return;
    if (gesture.dragging) {
      const target = gesture.targetPosition;
      cleanupGesture();
      if (target !== null && target !== position) swap(position, target);
      return;
    }
    const wasLongPress = gesture.longPressFired;
    cleanupGesture();
    if (!wasLongPress) select(position); // a plain tap still opens the editor
  }

  function cancelGesture() {
    if (!gesture) return;
    cleanupGesture();
  }

  function cleanupGesture() {
    if (!gesture) return;
    clearLongPress();
    if (gesture.ghostEl && gesture.ghostEl.parentNode) {
      gesture.ghostEl.parentNode.removeChild(gesture.ghostEl);
    }
    if (gesture.sourceEl) gesture.sourceEl.classList.remove('dragging');
    if (gesture.onEscape) window.removeEventListener('keydown', gesture.onEscape);
    clearDropTargets();
    gesture = null;
  }

  function clearLongPress() {
    if (gesture && gesture.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  }

  function createGhost(position) {
    const data = state.get(position);
    const ghost = document.createElement('div');
    ghost.className = 'pad-drag-ghost';
    ghost.textContent = (data && data.label) || `PAD ${position}`;
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveGhost(x, y) {
    if (!gesture || !gesture.ghostEl) return;
    gesture.ghostEl.style.left = `${x}px`;
    gesture.ghostEl.style.top = `${y}px`;
  }

  function updateDropTarget(x, y) {
    clearDropTargets();
    // The ghost has pointer-events:none, so elementFromPoint reports the pad
    // underneath it rather than the ghost itself.
    const under = document.elementFromPoint(x, y);
    const padEl = under && under.closest('.pad[data-position]');
    if (!padEl || !container.contains(padEl)) {
      gesture.targetPosition = null;
      return;
    }
    const targetPosition = Number(padEl.dataset.position);
    if (targetPosition === gesture.position) {
      gesture.targetPosition = null;
      return;
    }
    gesture.targetPosition = targetPosition;
    padEl.classList.add(state.get(targetPosition) ? 'drop-target-swap' : 'drop-target-move');
  }

  function clearDropTargets() {
    for (const el of pads.values()) {
      el.classList.remove('drop-target-swap', 'drop-target-move');
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

  function setKeyCapturing(value) {
    capturingKey = Boolean(value);
  }

  function isInputFocused() {
    if (capturingKey) return true;
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
    setKeyCapturing,
    setOrganizeMode,
    isOrganizeMode,
    swap,
    copyPad,
    clear,
  };
}

export { buildKeyCombo, formatTime };
