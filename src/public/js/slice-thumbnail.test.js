import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlicePeaks } from './slice-thumbnail.js';

function sine(length, cyclesPerBuffer = 8) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin((2 * Math.PI * cyclesPerBuffer * i) / length);
  }
  return data;
}

test('buildSlicePeaks: a full-scale sine reaches near +/-1 in every column', () => {
  // 480 cycles over 120 columns = 4 full cycles per bucket, so every bucket is
  // guaranteed to span a crest and a trough. (Fewer cycles per bucket is not a
  // bug -- a bucket covering half a cycle legitimately reports a shallow min.)
  const data = sine(48000, 480);
  const { mins, maxs, columns } = buildSlicePeaks(data, 0, data.length, 120);
  assert.equal(columns, 120);
  for (let c = 0; c < columns; c++) {
    assert.ok(maxs[c] > 0.9, `column ${c} max ${maxs[c]} should approach +1`);
    assert.ok(mins[c] < -0.9, `column ${c} min ${mins[c]} should approach -1`);
  }
});

test('buildSlicePeaks: an all-zero buffer produces all-zero buckets', () => {
  const data = new Float32Array(10000);
  const { mins, maxs } = buildSlicePeaks(data, 0, data.length, 64);
  assert.ok(mins.every((v) => v === 0));
  assert.ok(maxs.every((v) => v === 0));
});

test('buildSlicePeaks: columns are clamped to the sample count for a tiny slice', () => {
  const data = sine(1000, 4);
  const { columns, mins, maxs } = buildSlicePeaks(data, 0, 10, 120);
  assert.equal(columns, 10);
  assert.equal(mins.length, 10);
  assert.equal(maxs.length, 10);
});

test('buildSlicePeaks: a range past the end of the array is clamped, not fatal', () => {
  const data = sine(500, 4);
  const { columns, mins, maxs } = buildSlicePeaks(data, 400, 99999, 32);
  assert.equal(columns, 32);
  assert.ok(mins.every(Number.isFinite));
  assert.ok(maxs.every(Number.isFinite));
});

test('buildSlicePeaks: a degenerate range still returns one paintable column', () => {
  const data = sine(500, 4);
  const empty = buildSlicePeaks(data, 300, 300, 64);
  assert.equal(empty.columns, 1);
  assert.equal(empty.mins[0], 0);
  assert.equal(empty.maxs[0], 0);
  // end < start must behave like an empty range rather than scanning backwards.
  const inverted = buildSlicePeaks(data, 300, 100, 64);
  assert.equal(inverted.columns, 1);
});

test('buildSlicePeaks: the strided path still returns exactly `columns` finite buckets', () => {
  // Over MAX_SCAN_SAMPLES (2e6), so this exercises stride > 1.
  const data = sine(3_000_000, 512);
  const { columns, mins, maxs } = buildSlicePeaks(data, 0, data.length, 132);
  assert.equal(columns, 132);
  assert.ok(mins.every(Number.isFinite));
  assert.ok(maxs.every(Number.isFinite));
  for (let c = 0; c < columns; c++) {
    assert.ok(maxs[c] >= mins[c], `column ${c} max must not fall below min`);
    assert.ok(Math.abs(maxs[c]) <= 1 && Math.abs(mins[c]) <= 1, `column ${c} must stay in range`);
  }
});

test('buildSlicePeaks: peaks reflect the requested sub-range, not the whole buffer', () => {
  // Loud first half, silent second half: a slice over the silent half must
  // report silence, which is what proves the offset is honoured.
  const data = new Float32Array(20000);
  for (let i = 0; i < 10000; i++) data[i] = 1;
  const loud = buildSlicePeaks(data, 0, 10000, 16);
  const quiet = buildSlicePeaks(data, 10000, 20000, 16);
  assert.ok(loud.maxs.every((v) => v === 1));
  assert.ok(quiet.maxs.every((v) => v === 0));
});
