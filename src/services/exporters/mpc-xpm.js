import { sanitizeFilename, xmlEscape, readmeFor } from './common.js';

// Akai MPC Drum program (.xpm) — plain-text XML in MPC 2.x. One pad per chop,
// each referencing its own already-cut WAV.
//
// BEST-EFFORT (QA-gated): the full modern MPC-V pad schema is large and only
// partially documented publicly, so this emits a compact, well-formed Drum
// program. The chop WAVs are bundled alongside so they remain usable even if a
// given MPC firmware rejects the program file. Refine against a real MPC export
// during QA; isolated here so changes don't touch the other formats.
export function buildXpm(slices, programName) {
  const pads = slices.map((slice, i) => [
    `        <Pad number="${i}">`,
    `          <SampleName>${xmlEscape(slice.filename.replace(/\.wav$/i, ''))}</SampleName>`,
    '          <SampleStart>0</SampleStart>',
    `          <SampleEnd>${slice.frameCount || 0}</SampleEnd>`,
    '          <Loop>False</Loop>',
    `          <RootNote>${Math.min(127, 36 + i)}</RootNote>`,
    '        </Pad>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPCVObject>',
    '    <Version>',
    '        <File_Version>2.1</File_Version>',
    '        <Application>MPC-V</Application>',
    '    </Version>',
    '    <Program type="Drum">',
    `        <ProgramName>${xmlEscape(programName)}</ProgramName>`,
    `        <PadCount>${slices.length}</PadCount>`,
    '      <Pads>',
    pads,
    '      </Pads>',
    '    </Program>',
    '</MPCVObject>',
    '',
  ].join('\n');
}

export default {
  id: 'mpc',
  ext: 'zip',
  async build({ session, archive, getSlices }) {
    const slices = await getSlices();
    const name = sanitizeFilename(session.name || 'program');
    archive.append(buildXpm(slices, name), { name: `${name}.xpm` });
    // MPC looks for samples alongside the program file, so WAVs go at the root.
    for (const slice of slices) {
      archive.file(slice.path, { name: slice.filename });
    }
    archive.append(readmeFor('Akai MPC — Drum program', `${name}.xpm`), { name: 'README.txt' });
  },
};
