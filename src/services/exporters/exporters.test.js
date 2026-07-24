import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSfz } from './sfz.js';
import { buildDspreset } from './decentsampler.js';
import { buildXpm } from './mpc-xpm.js';
import { buildAdvXml } from './ableton-adv.js';
import { addCuePoints, buildCueChunk } from './wav-cue.js';
import { sliceFramesByVideo } from './slice-cutter.js';

const SLICES = [
  { index: 0, filename: 'pad-01.wav', frameCount: 44100 },
  { index: 1, filename: 'pad-02.wav', frameCount: 22050 },
];

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function minimalWav(dataBytes = 8) {
  const data = Buffer.alloc(dataBytes);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt32LE(44100 * 4, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  const fmtChunk = Buffer.concat([Buffer.from('fmt '), u32(16), fmt]);
  const dataChunk = Buffer.concat([Buffer.from('data'), u32(data.length), data]);
  const body = Buffer.concat([Buffer.from('WAVE'), fmtChunk, dataChunk]);
  return Buffer.concat([Buffer.from('RIFF'), u32(body.length), body]);
}

function findChunk(buf, id) {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (chunkId === id) return { offset, size, dataStart: offset + 8 };
    offset += 8 + size + (size % 2);
  }
  return null;
}

test('buildSfz: one region per slice, ascending keys from C1 (36)', () => {
  const sfz = buildSfz(SLICES);
  const regions = sfz.split('<region>').length - 1;
  assert.equal(regions, 2);
  assert.match(sfz, /sample=pad-01\.wav/);
  assert.match(sfz, /lokey=36 hikey=36 pitch_keycenter=36/);
  assert.match(sfz, /lokey=37 hikey=37 pitch_keycenter=37/);
});

test('buildDspreset: one sample per slice with rootNote from C1', () => {
  const xml = buildDspreset(SLICES);
  assert.match(xml, /<DecentSampler>/);
  const samples = xml.split('<sample ').length - 1;
  assert.equal(samples, 2);
  assert.match(xml, /path="samples\/pad-01\.wav" rootNote="36" loNote="36" hiNote="36"/);
  assert.match(xml, /rootNote="37"/);
});

test('buildXpm: well-formed drum program referencing each chop', () => {
  const xml = buildXpm(SLICES, 'My Kit');
  assert.match(xml, /<Program type="Drum">/);
  assert.match(xml, /<ProgramName>My Kit<\/ProgramName>/);
  assert.equal(xml.split('<Pad number=').length - 1, 2);
  assert.match(xml, /<SampleName>pad-01<\/SampleName>/);
  assert.match(xml, /<SampleEnd>44100<\/SampleEnd>/);
});

test('buildAdvXml: one drum branch per chop with sample refs', () => {
  const xml = buildAdvXml(SLICES, 'Rack');
  assert.match(xml, /<DrumGroupDevice>/);
  assert.equal(xml.split('<DrumBranch>').length - 1, 2);
  assert.match(xml, /RelativePath Value="Samples\/pad-01\.wav"/);
  assert.match(xml, /ReceivingNote Value="36"/);
});

test('buildCueChunk: correct header and per-point layout', () => {
  const chunk = buildCueChunk([100, 200]);
  assert.equal(chunk.toString('ascii', 0, 4), 'cue ');
  assert.equal(chunk.readUInt32LE(4), 4 + 2 * 24); // chunk size
  assert.equal(chunk.readUInt32LE(8), 2); // num cue points
  // first point dwSampleOffset
  assert.equal(chunk.readUInt32LE(8 + 4 + 20), 100);
});

test('addCuePoints: appends a valid cue chunk and patches RIFF size', () => {
  const wav = minimalWav(16);
  const out = addCuePoints(wav, [50, 10, 10]); // dupes + unsorted
  // RIFF size field matches new length
  assert.equal(out.readUInt32LE(4), out.length - 8);
  const cue = findChunk(out, 'cue ');
  assert.ok(cue, 'cue chunk present');
  const n = out.readUInt32LE(cue.dataStart);
  assert.equal(n, 2); // de-duped to {10, 50}
  const firstOffset = out.readUInt32LE(cue.dataStart + 4 + 20);
  assert.equal(firstOffset, 10); // sorted ascending
});

test('addCuePoints: no positions returns an untouched copy', () => {
  const wav = minimalWav(8);
  const out = addCuePoints(wav, []);
  assert.deepEqual(out, wav);
});

test('sliceFramesByVideo: frame offsets from pad start/end at the export rate', () => {
  const session = {
    pads: [
      { videoId: 'aaaaaaaaaaa', start: 0, end: 1 },
      { videoId: 'aaaaaaaaaaa', start: 1, end: 2 },
      { videoId: 'bbbbbbbbbbb', start: 0.5, end: 1.5 },
    ],
  };
  const frames = sliceFramesByVideo(session, 44100);
  assert.deepEqual(frames.get('aaaaaaaaaaa'), [0, 44100, 88200]);
  assert.deepEqual(frames.get('bbbbbbbbbbb'), [22050, 66150]);
});
