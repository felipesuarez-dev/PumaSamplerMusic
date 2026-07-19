// Pure, DOM-free slice/boundary geometry for the Auto-Slicer feature.
// All times are in seconds. A "boundaries" array is always sorted, starts
// at 0 and ends at the buffer's total duration; every interior entry is a
// user- or algorithm-placed slice point. A "slices" array is the derived
// contiguous [{start, end}] tiling of those boundaries.
//
// This module owns the editing operations (move/insert/remove a boundary)
// and the grid/BPM helpers used by Grid mode. It has no DOM or Worker
// dependency so it can run under node:test or in either thread.

import { MIN_SLICE_SECONDS } from './slicer-core.js';

// Converts a sorted boundaries array into contiguous slices. Mirrors
// slicer.js's private slicesToMarkerTimes in reverse (see slicesToBoundaries
// below for the inverse).
export function boundariesToSlices(boundaries) {
  const slices = [];
  for (let i = 1; i < boundaries.length; i++) {
    slices.push({ start: boundaries[i - 1], end: boundaries[i] });
  }
  return slices;
}

// Converts a contiguous slices array back into a boundaries array: every
// slice's start, plus the final slice's end. Empty input yields an empty
// array (no duration to anchor a lone 0/end pair to).
export function slicesToBoundaries(slices) {
  if (!slices.length) return [];
  const boundaries = slices.map((s) => s.start);
  boundaries.push(slices[slices.length - 1].end);
  return boundaries;
}

// Moves boundaries[index] to newTime, clamped to [left+minGap, right-minGap]
// where left/right are its immediate neighbors. index 0 and the last index
// are anchors (0 and total duration) and are never moved.
//
// Guard (Shuriken-derived): if the neighbors are already closer together
// than 2*minGap, the clamp range [left+minGap, right-minGap] is inverted
// (its low bound exceeds its high bound). Clamping into an inverted range
// would silently teleport the boundary past a neighbor, so this is a no-op
// instead -- the input array is returned unchanged.
export function moveBoundary(boundaries, index, newTime, minGap = MIN_SLICE_SECONDS) {
  if (index <= 0 || index >= boundaries.length - 1) return boundaries;

  const left = boundaries[index - 1];
  const right = boundaries[index + 1];
  if (right - left < 2 * minGap) return boundaries;

  const min = left + minGap;
  const max = right - minGap;
  const clamped = Math.min(max, Math.max(min, newTime));

  const next = boundaries.slice();
  next[index] = clamped;
  return next;
}

// Inserts a new boundary at `time`, keeping the array sorted. Returns null
// (rejected) if `time` is outside the open interval (0, duration), or
// within minGap of ANY existing boundary -- including the 0 and duration
// ends -- since that would create a slice shorter than minGap.
export function insertBoundary(boundaries, time, minGap = MIN_SLICE_SECONDS) {
  if (boundaries.length < 2) return null;
  const start = boundaries[0];
  const end = boundaries[boundaries.length - 1];
  if (time <= start || time >= end) return null;

  for (const b of boundaries) {
    if (Math.abs(b - time) < minGap) return null;
  }

  const next = boundaries.slice();
  let insertAt = next.length;
  for (let i = 0; i < next.length; i++) {
    if (time < next[i]) {
      insertAt = i;
      break;
    }
  }
  next.splice(insertAt, 0, time);
  return next;
}

// Removes boundaries[index]. index 0 and the last index (the 0/duration
// anchors) are never removable -- no-op, returns the input unchanged.
export function removeBoundary(boundaries, index) {
  if (index <= 0 || index >= boundaries.length - 1) return boundaries;
  const next = boundaries.slice();
  next.splice(index, 1);
  return next;
}

// Builds numBeats*divisionsPerBeat equally-spaced boundaries from 0 to
// durationSeconds inclusive. Each step is computed as i*duration/N rather
// than accumulated by repeated addition, so the final boundary is exactly
// durationSeconds with no float drift.
export function computeGridBoundaries(durationSeconds, numBeats, divisionsPerBeat) {
  const n = numBeats * divisionsPerBeat;
  const boundaries = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    boundaries[i] = i === n ? durationSeconds : (i * durationSeconds) / n;
  }
  return boundaries;
}

// Length-based BPM: how many beats-per-minute numBeats spans across
// durationSeconds.
export function bpmFromLength(numBeats, durationSeconds) {
  return numBeats / (durationSeconds / 60);
}
