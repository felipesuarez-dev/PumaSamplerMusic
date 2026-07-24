import { buildSlicedWavBundle } from './sliced-wav.js';

// Logic Pro Quick Sampler: same full-length WAV + embedded cue markers as the
// FL export. Quick Sampler's Slice mode positions slice markers from a file's
// transients/markers on import.
//
// NOTE (QA-gated): unlike Fruity Slicer 2, there is no confirmed evidence that
// Quick Sampler imports embedded RIFF cue points (Apple documents only its own
// transient detection). This exporter ships the same marked WAVs so Slice mode
// can at least auto-detect transients; if a round-trip proves cue import
// unsupported, this format should be hidden until an alternative is found.
export default {
  id: 'logic',
  ext: 'zip',
  async build(ctx) {
    await buildSlicedWavBundle({ ...ctx, daw: 'Logic Pro — Quick Sampler' });
  },
};
