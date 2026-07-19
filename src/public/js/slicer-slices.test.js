import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundariesToSlices,
  slicesToBoundaries,
  moveBoundary,
  insertBoundary,
  removeBoundary,
  computeGridBoundaries,
  bpmFromLength,
} from './slicer-slices.js';

test('boundariesToSlices <-> slicesToBoundaries: round-trip', () => {
  const boundaries = [0, 1.5, 3, 4.25, 6];
  const slices = boundariesToSlices(boundaries);

  assert.deepEqual(slices, [
    { start: 0, end: 1.5 },
    { start: 1.5, end: 3 },
    { start: 3, end: 4.25 },
    { start: 4.25, end: 6 },
  ]);

  assert.deepEqual(slicesToBoundaries(slices), boundaries);
});

test('slicesToBoundaries: empty input returns empty array', () => {
  assert.deepEqual(slicesToBoundaries([]), []);
});

test('boundariesToSlices: two boundaries yield a single slice', () => {
  assert.deepEqual(boundariesToSlices([0, 5]), [{ start: 0, end: 5 }]);
});

// --- moveBoundary ----------------------------------------------------------

test('moveBoundary: clamps to left+minGap when dragged past the left neighbor', () => {
  const boundaries = [0, 2, 4, 10];
  const next = moveBoundary(boundaries, 1, 0.5, 0.5);
  assert.equal(next[1], 0.5); // left(0)+minGap(0.5)
});

test('moveBoundary: clamps to right-minGap when dragged past the right neighbor', () => {
  const boundaries = [0, 2, 4, 10];
  const next = moveBoundary(boundaries, 1, 3.9, 0.5);
  assert.equal(next[1], 3.5); // right(4)-minGap(0.5)
});

test('moveBoundary: within range moves freely', () => {
  const boundaries = [0, 2, 4, 10];
  const next = moveBoundary(boundaries, 1, 2.7, 0.5);
  assert.equal(next[1], 2.7);
});

test('moveBoundary: inverted-clamp guard -- neighbors closer than 2*minGap is a no-op', () => {
  // Moving index 2 (2.3): its neighbors are index 1 (2) and index 3 (2.6),
  // gap 0.6 < 2*minGap(0.8) -> inverted range [left+minGap, right-minGap]
  // = [2.4, 2.2], no-op.
  const boundaries = [0, 2, 2.3, 2.6, 10];
  const next = moveBoundary(boundaries, 2, 2.4, 0.4);
  assert.equal(next, boundaries, 'expected the exact same array reference (no-op)');
});

test('moveBoundary: moving index 0 is a no-op', () => {
  const boundaries = [0, 2, 4, 10];
  const next = moveBoundary(boundaries, 0, 1, 0.5);
  assert.equal(next, boundaries);
});

test('moveBoundary: moving the last index is a no-op', () => {
  const boundaries = [0, 2, 4, 10];
  const next = moveBoundary(boundaries, 3, 8, 0.5);
  assert.equal(next, boundaries);
});

// --- insertBoundary ----------------------------------------------------------

test('insertBoundary: inserts into the correct sorted position', () => {
  const boundaries = [0, 2, 4, 10];
  const next = insertBoundary(boundaries, 3, 0.5);
  assert.deepEqual(next, [0, 2, 3, 4, 10]);
});

test('insertBoundary: rejects a time within minGap of an existing interior boundary', () => {
  const boundaries = [0, 2, 4, 10];
  assert.equal(insertBoundary(boundaries, 2.2, 0.5), null);
});

test('insertBoundary: rejects a time within minGap of the start (0)', () => {
  const boundaries = [0, 2, 4, 10];
  assert.equal(insertBoundary(boundaries, 0.3, 0.5), null);
});

test('insertBoundary: rejects a time within minGap of the end (duration)', () => {
  const boundaries = [0, 2, 4, 10];
  assert.equal(insertBoundary(boundaries, 9.8, 0.5), null);
});

test('insertBoundary: rejects a time outside (0, duration)', () => {
  const boundaries = [0, 2, 4, 10];
  assert.equal(insertBoundary(boundaries, -1, 0.5), null);
  assert.equal(insertBoundary(boundaries, 11, 0.5), null);
  assert.equal(insertBoundary(boundaries, 0, 0.5), null);
  assert.equal(insertBoundary(boundaries, 10, 0.5), null);
});

test('insertBoundary: accepts a time exactly minGap away from its neighbors', () => {
  const boundaries = [0, 2, 4, 10];
  const next = insertBoundary(boundaries, 2.5, 0.5);
  assert.deepEqual(next, [0, 2, 2.5, 4, 10]);
});

// --- removeBoundary ----------------------------------------------------------

test('removeBoundary: removes an interior boundary', () => {
  const boundaries = [0, 2, 4, 10];
  assert.deepEqual(removeBoundary(boundaries, 1), [0, 4, 10]);
  assert.deepEqual(removeBoundary(boundaries, 2), [0, 2, 10]);
});

test('removeBoundary: index 0 is a no-op', () => {
  const boundaries = [0, 2, 4, 10];
  const next = removeBoundary(boundaries, 0);
  assert.equal(next, boundaries);
});

test('removeBoundary: the last index is a no-op', () => {
  const boundaries = [0, 2, 4, 10];
  const next = removeBoundary(boundaries, 3);
  assert.equal(next, boundaries);
});

// --- computeGridBoundaries ----------------------------------------------------------

test('computeGridBoundaries: produces numBeats*divisionsPerBeat+1 equally spaced boundaries', () => {
  const boundaries = computeGridBoundaries(30, 4, 2); // 8 steps
  assert.equal(boundaries.length, 9);
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries[boundaries.length - 1], 30);

  for (let i = 1; i < boundaries.length; i++) {
    const step = boundaries[i] - boundaries[i - 1];
    assert.ok(Math.abs(step - 30 / 8) < 1e-9, `expected uniform step, got ${step}`);
  }
});

test('computeGridBoundaries: last boundary is exactly durationSeconds, no float drift', () => {
  // A duration/step ratio that is not exactly representable in binary
  // floating point (0.1-style drift risk if accumulated by repeated adds).
  const boundaries = computeGridBoundaries(7.7, 3, 7); // 21 steps
  assert.equal(boundaries[boundaries.length - 1], 7.7);
});

test('computeGridBoundaries: single division yields [0, duration]', () => {
  assert.deepEqual(computeGridBoundaries(5, 1, 1), [0, 5]);
});

// --- bpmFromLength ----------------------------------------------------------

test('bpmFromLength: 16 beats over 30s is 32 BPM', () => {
  assert.equal(bpmFromLength(16, 30), 32);
});

test('bpmFromLength: 4 beats over 2s is 120 BPM', () => {
  assert.equal(bpmFromLength(4, 2), 120);
});

// --- degenerate durations ----------------------------------------------------------

test('degenerate duration: moveBoundary no-ops when total span is under 2*minGap', () => {
  // Whole clip duration (0.1s) is less than 2*minGap (0.16s): any 3-point
  // boundary set here already violates the invariant, but the guard must
  // still hold for whatever slice the boundary sits in.
  const boundaries = [0, 0.05, 0.1];
  const next = moveBoundary(boundaries, 1, 0.06, 0.08);
  assert.equal(next, boundaries);
});

test('degenerate duration: insertBoundary rejects everything when duration < 2*minGap', () => {
  const boundaries = [0, 0.1];
  // Any candidate time in (0, 0.1) is within minGap(0.08) of one of the ends.
  assert.equal(insertBoundary(boundaries, 0.05, 0.08), null);
});
