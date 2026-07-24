import { gzipSync } from 'node:zlib';
import { sanitizeFilename, xmlEscape, padMidiNote, readmeFor } from './common.js';

// Ableton Live device preset (.adv) — a gzip-compressed XML document. Targets a
// Drum Rack of one-shot Simplers (the shape Live's own "Slice to New MIDI
// Track" produces), one branch per chop, using the long-stable SampleStart/
// SampleEnd fields rather than the newer, less-documented slicing mode.
//
// BEST-EFFORT (QA-gated): Ableton's device XML schema is undocumented and drifts
// across Live versions, so byte-perfect compatibility is not guaranteed. The
// chop WAVs are bundled so they stay usable if the preset fails to load.
// Isolated here so refinements never touch the other formats.
export function buildAdvXml(slices, presetName) {
  const branches = slices.map((slice, i) => {
    const note = padMidiNote(i);
    return [
      `        <DrumBranch>`,
      `          <Name Value="${xmlEscape(slice.filename.replace(/\.wav$/i, ''))}" />`,
      `          <ReceivingNote Value="${note}" />`,
      `          <SampleRef>`,
      `            <RelativePath Value="Samples/${xmlEscape(slice.filename)}" />`,
      `            <FileSize Value="0" />`,
      `          </SampleRef>`,
      `          <SampleStart Value="0" />`,
      `          <SampleEnd Value="${slice.frameCount || 0}" />`,
      `        </DrumBranch>`,
    ].join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Ableton MajorVersion="5" MinorVersion="11.0" Creator="PumaSampler">',
    '  <DrumGroupDevice>',
    `    <UserName Value="${xmlEscape(presetName)}" />`,
    '    <Branches>',
    branches,
    '    </Branches>',
    '  </DrumGroupDevice>',
    '</Ableton>',
    '',
  ].join('\n');
}

export default {
  id: 'ableton',
  ext: 'zip',
  async build({ session, archive, getSlices }) {
    const slices = await getSlices();
    const name = sanitizeFilename(session.name || 'rack');
    const xml = buildAdvXml(slices, name);
    // .adv files are gzip-compressed XML.
    archive.append(gzipSync(Buffer.from(xml, 'utf8')), { name: `${name}.adv` });
    for (const slice of slices) {
      archive.file(slice.path, { name: `Samples/${slice.filename}` });
    }
    archive.append(readmeFor('Ableton Live — Drum Rack (Simpler)', `${name}.adv`), { name: 'README.txt' });
  },
};
