// Shared waveform render-style preference, persisted in localStorage the same
// way as the locale (see i18n.js). Read once by each createWaveform() call site
// for its initial style; changes are broadcast on a window CustomEvent so every
// live waveform instance re-styles itself without the Settings modal needing a
// reference to any of them.
const KEY = 'puma-waveform-style';
export const WAVEFORM_STYLE_EVENT = 'waveformstylechange';

export function getWaveformStyle() {
  return localStorage.getItem(KEY) === 'bars' ? 'bars' : 'classic';
}

export function setWaveformStyle(style) {
  const normalized = style === 'bars' ? 'bars' : 'classic';
  localStorage.setItem(KEY, normalized);
  window.dispatchEvent(new CustomEvent(WAVEFORM_STYLE_EVENT, { detail: normalized }));
}
