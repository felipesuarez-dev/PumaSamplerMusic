import { sanitizeFilename, padMidiNote, xmlEscape } from './common.js';

// DecentSampler: an open, documented, free-plugin XML format (.dspreset). One
// <sample> per chop mapped to a single key from C1. Fully generatable.
export function buildDspreset(slices) {
  const samples = slices.map((slice) => {
    const note = padMidiNote(slice.index);
    const path = xmlEscape(`samples/${slice.filename}`);
    return `      <sample path="${path}" rootNote="${note}" loNote="${note}" hiNote="${note}" />`;
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DecentSampler>',
    '  <groups>',
    '    <group>',
    samples,
    '    </group>',
    '  </groups>',
    '</DecentSampler>',
    '',
  ].join('\n');
}

export default {
  id: 'decentsampler',
  ext: 'zip',
  async build({ session, archive, getSlices }) {
    const slices = await getSlices();
    const name = sanitizeFilename(session.name || 'kit');
    archive.append(buildDspreset(slices), { name: `${name}.dspreset` });
    for (const slice of slices) {
      archive.file(slice.path, { name: `samples/${slice.filename}` });
    }
  },
};
