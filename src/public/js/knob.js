// Rotary knob progressive enhancement for the master-strip/pad-fx-strip
// sliders. The native <input type="range"> stays in the DOM as the real
// source of truth (value, min/max/step, disabled, focus/keyboard support) —
// only its visual is replaced by a dial the user drags/wheels vertically.
const nativeValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

export function enhanceKnobs(container) {
  container.querySelectorAll('.master-knob-control input[type="range"]').forEach(enhanceKnob);
}

function enhanceKnob(input) {
  if (input.dataset.knobEnhanced) return;
  input.dataset.knobEnhanced = 'true';

  const wrapper = document.createElement('div');
  wrapper.className = 'knob';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const dial = document.createElement('div');
  dial.className = 'knob-dial';
  const indicator = document.createElement('div');
  indicator.className = 'knob-indicator';
  dial.appendChild(indicator);
  wrapper.appendChild(dial);

  function bounds() {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    return {
      min: Number.isNaN(min) ? 0 : min,
      max: Number.isNaN(max) ? 100 : max,
    };
  }

  function step() {
    const s = parseFloat(input.step);
    return Number.isNaN(s) || s === 0 ? 1 : s;
  }

  function syncVisual() {
    const { min, max } = bounds();
    const value = parseFloat(input.value);
    const ratio = max === min ? 0 : (value - min) / (max - min);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const angle = -135 + clampedRatio * 270;
    dial.style.setProperty('--knob-angle', `${angle}deg`);
    dial.classList.toggle('knob-disabled', input.disabled);
  }

  // Programmatic `input.value = x` writes elsewhere in the app (e.g.
  // re-seeding sliders when a different pad is selected) never fire an
  // `input` event, so the dial would silently go stale without this.
  // Re-read via the native getter after writing — range inputs clamp/step
  // out-of-range values, so the raw argument isn't reliable.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return nativeValueDescriptor.get.call(input);
    },
    set(v) {
      nativeValueDescriptor.set.call(input, v);
      syncVisual();
    },
  });

  function clampToStep(v) {
    const { min, max } = bounds();
    const s = step();
    const rounded = Math.round((v - min) / s) * s + min;
    return Math.max(min, Math.min(max, rounded));
  }

  let dragStartY = 0;
  let dragStartValue = 0;

  dial.addEventListener('pointerdown', (e) => {
    if (input.disabled) return;
    dial.setPointerCapture(e.pointerId);
    dragStartY = e.clientY;
    dragStartValue = parseFloat(input.value);
  });

  dial.addEventListener('pointermove', (e) => {
    if (input.disabled) return;
    if (!dial.hasPointerCapture(e.pointerId)) return;
    const { min, max } = bounds();
    const sensitivity = e.shiftKey ? 800 : 200;
    const delta = ((dragStartY - e.clientY) / sensitivity) * (max - min);
    const next = clampToStep(dragStartValue + delta);
    if (next !== parseFloat(input.value)) {
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  dial.addEventListener('pointerup', (e) => {
    if (dial.hasPointerCapture(e.pointerId)) dial.releasePointerCapture(e.pointerId);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  dial.addEventListener('wheel', (e) => {
    if (input.disabled) return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    const next = clampToStep(parseFloat(input.value) + direction * step());
    if (next !== parseFloat(input.value)) {
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  input.addEventListener('input', syncVisual);

  new MutationObserver(syncVisual).observe(input, { attributes: true, attributeFilter: ['disabled'] });

  syncVisual();
}
