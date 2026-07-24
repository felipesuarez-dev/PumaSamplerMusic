import { buildSlicedWavBundle } from './sliced-wav.js';

// FL Studio: a full-length WAV per source with chop boundaries embedded as RIFF
// cue markers. Fruity Slicer 2 auto-detects those markers as slices when the
// WAV is dropped on a channel. Best-effort (validated by DAW round-trip).
export default {
  id: 'fl',
  ext: 'zip',
  async build(ctx) {
    await buildSlicedWavBundle({ ...ctx, daw: 'FL Studio — Fruity Slicer 2' });
  },
};
