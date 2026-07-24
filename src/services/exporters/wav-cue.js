// Injects RIFF 'cue ' markers into a PCM WAV so FL Studio's Fruity Slicer 2 and
// Logic's Quick Sampler pick up the chops as slice points on import. Pure
// Buffer manipulation -- no native deps. The cue chunk is appended after the
// existing chunks and the outer RIFF size field is patched to match.
//
// cue chunk layout (little-endian):
//   'cue ' | chunkSize(4) | numCuePoints(4) | numCuePoints * 24-byte points
// each cue point:
//   dwIdentifier(4) | dwPosition(4) | fccChunk(4)='data' |
//   dwChunkStart(4)=0 | dwBlockStart(4)=0 | dwSampleOffset(4)
// For a single-data-chunk PCM file dwPosition and dwSampleOffset are both the
// sample-frame offset.

function assertRiffWave(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE buffer');
  }
}

export function buildCueChunk(positions) {
  const n = positions.length;
  const body = Buffer.alloc(4 + n * 24);
  body.writeUInt32LE(n, 0);
  for (let i = 0; i < n; i++) {
    const base = 4 + i * 24;
    const pos = Math.max(0, Math.round(positions[i]));
    body.writeUInt32LE(i + 1, base); // dwIdentifier (1-based)
    body.writeUInt32LE(pos, base + 4); // dwPosition
    body.write('data', base + 8, 4, 'ascii'); // fccChunk
    body.writeUInt32LE(0, base + 12); // dwChunkStart
    body.writeUInt32LE(0, base + 16); // dwBlockStart
    body.writeUInt32LE(pos, base + 20); // dwSampleOffset
  }
  const header = Buffer.alloc(8);
  header.write('cue ', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// Returns a new Buffer with a 'cue ' chunk carrying the given sample-frame
// positions. Positions are de-duplicated and sorted. A cue chunk is always an
// even length here (4 + 24n), so no RIFF word-padding byte is needed.
export function addCuePoints(wavBuffer, positions) {
  assertRiffWave(wavBuffer);
  const unique = [...new Set(positions.map((p) => Math.max(0, Math.round(p))))].sort((a, b) => a - b);
  if (unique.length === 0) return Buffer.from(wavBuffer);

  const cueChunk = buildCueChunk(unique);
  const out = Buffer.concat([wavBuffer, cueChunk]);
  // Patch the outer RIFF size (everything after the first 8 bytes).
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
