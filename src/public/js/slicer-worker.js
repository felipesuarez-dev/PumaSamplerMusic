// Thin module Worker wrapper around the pure DSP core, so onset analysis
// runs off the main thread. Every message carries a `gen` (generation)
// token supplied by the caller; it is echoed back unchanged on every reply
// so a stale progress/done/error from a canceled analysis can be told apart
// from the current one and ignored (see video-display.js's loadGen for the
// same pattern on the UI side).
import { detectOnsets } from './slicer-core.js';

self.onmessage = (event) => {
  const { channelData, sampleRate, sensitivity, gen } = event.data;

  try {
    const slices = detectOnsets(channelData, sampleRate, {
      sensitivity,
      onProgress: (value) => {
        self.postMessage({ type: 'progress', value, gen });
      },
    });

    self.postMessage({ type: 'done', slices, gen });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err), gen });
  }
};
