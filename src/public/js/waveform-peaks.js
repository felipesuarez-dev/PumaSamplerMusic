// Pure, DOM-free peak-bucketing math extracted from waveform.js so it can be
// unit tested without a canvas/AudioBuffer/browser environment. Buckets a
// flat sample array (e.g. Float32Array from AudioBuffer.getChannelData(0))
// into one or more precision "levels", each keeping the min/max sample per
// bucket.
//
// Bounded-count philosophy: bucket sizes are derived from target bucket
// *counts*, not fixed absolute sizes. This keeps memory bounded (~a few MB
// worst case) regardless of how long the source audio is — an hour-long
// file gets proportionally bigger buckets instead of proportionally more
// buckets.
const DEFAULT_TARGET_BUCKET_COUNTS = [8192, 65536, 524288];

// Levels whose bucketSize would drop below this are skipped: for buffers
// short enough (or levels fine enough) to hit this floor, a raw per-sample
// scan at draw time is already cheap, so caching adds overhead without
// benefit.
const MIN_LEVEL_BUCKET_SIZE = 64;

function buildLevel(data, bucketSize) {
  const numBuckets = Math.ceil(data.length / bucketSize);
  const mins = new Float32Array(numBuckets);
  const maxs = new Float32Array(numBuckets);

  for (let b = 0; b < numBuckets; b++) {
    const offset = b * bucketSize;
    const limit = Math.min(offset + bucketSize, data.length);
    let min = 1;
    let max = -1;
    for (let i = offset; i < limit; i++) {
      const sample = data[i];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    mins[b] = min;
    maxs[b] = max;
  }

  return { bucketSize, mins, maxs };
}

// Builds a multi-level peak cache: { levels: [{ bucketSize, mins, maxs }] }.
// `targetBucketCounts` accepts either an array (one level per entry) or a
// single number (single-level cache, for callers that only need one
// resolution). Levels are sorted coarsest-first (largest bucketSize first,
// finest/smallest bucketSize last) so consumers can walk the array looking
// for the coarsest level that still satisfies their resolution needs.
// Levels whose bucketSize would land below MIN_LEVEL_BUCKET_SIZE are
// skipped, and duplicate bucketSizes (small buffers collapsing multiple
// target counts to the same size) are de-duplicated. The function is pure —
// it never mutates `data` and always returns a fresh result.
export function buildPeakCache(data, targetBucketCounts = DEFAULT_TARGET_BUCKET_COUNTS) {
  const counts = Array.isArray(targetBucketCounts) ? targetBucketCounts : [targetBucketCounts];
  const seenBucketSizes = new Set();
  const levels = [];

  for (const targetCount of counts) {
    const bucketSize = Math.max(1, Math.ceil(data.length / targetCount));
    if (bucketSize < MIN_LEVEL_BUCKET_SIZE) continue;
    if (seenBucketSizes.has(bucketSize)) continue;
    seenBucketSizes.add(bucketSize);
    levels.push(buildLevel(data, bucketSize));
  }

  levels.sort((a, b) => b.bucketSize - a.bucketSize);

  return { levels };
}

// Picks the coarsest level whose bucketSize is still <= step (samples per
// pixel), which maximizes work saved while staying at/finer than the pixel
// resolution being drawn. Returns null when no level qualifies (e.g. zoomed
// in near sample level), signalling the caller to fall back to a raw scan.
export function selectLevel(cache, step) {
  if (!cache || !Array.isArray(cache.levels)) return null;
  for (const level of cache.levels) {
    if (level.bucketSize <= step) return level;
  }
  return null;
}
