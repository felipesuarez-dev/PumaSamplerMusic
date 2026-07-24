import { sanitizeFilename, padMidiNote } from './common.js';

// SFZ: an open, plain-text sampler format (sforzando, many hardware/software
// samplers). One <region> per chop, each mapped to a single ascending key from
// C1. Fully generatable and deterministic -- the lowest-risk sampler format.
export function buildSfz(slices) {
  const lines = [
    '// PumaSampler export (SFZ)',
    '<control>',
    'default_path=samples/',
    '',
    '<global>',
    'loop_mode=one_shot',
    '',
  ];
  for (const slice of slices) {
    const note = padMidiNote(slice.index);
    lines.push('<region>');
    lines.push(`sample=${slice.filename}`);
    lines.push(`lokey=${note} hikey=${note} pitch_keycenter=${note}`);
    lines.push('');
  }
  return lines.join('\n');
}

export default {
  id: 'sfz',
  ext: 'zip',
  async build({ session, archive, getSlices }) {
    const slices = await getSlices();
    const name = sanitizeFilename(session.name || 'kit');
    archive.append(buildSfz(slices), { name: `${name}.sfz` });
    for (const slice of slices) {
      archive.file(slice.path, { name: `samples/${slice.filename}` });
    }
  },
};
