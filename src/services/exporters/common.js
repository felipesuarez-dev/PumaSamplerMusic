import { sanitizeFilename } from '../../utils/validation.js';

export { sanitizeFilename };

// Bounded-concurrency pool: runs `worker` over `items` with at most `limit` in
// flight. Shared by the exporters that spawn one ffmpeg per pad/source.
export async function runPool(items, limit, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

// Maps the Nth exported pad to a MIDI note starting at C1 (MIDI 36), the
// convention Quick Sampler/Simpler slice maps and MPC drum programs use, capped
// at the MIDI ceiling so very large kits don't overflow.
export function padMidiNote(index) {
  return Math.min(127, 36 + index);
}

export function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// A short human note bundled with the best-effort DAW presets, so the sample
// WAVs are usable even if a given DAW rejects the generated preset.
export function readmeFor(daw, presetFile) {
  return [
    `PumaSampler export — ${daw}`,
    '',
    `Preset: ${presetFile}`,
    'Samples: samples/  (one WAV per chop, 44.1 kHz / 16-bit)',
    '',
    'Import the preset with your DAW. If the preset does not load,',
    'the WAV chops in samples/ can be dragged in manually.',
    '',
  ].join('\n');
}
