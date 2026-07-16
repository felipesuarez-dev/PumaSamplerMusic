import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeakCache } from './waveform-peaks.js';

// Brute-force min/max scan over data[offset, limit) — used as the ground
// truth to check the bucketed cache against.
function bruteForceMinMax(data, offset, limit) {
  let min = 1;
  let max = -1;
  for (let i = offset; i < limit; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return { min, max };
}

test('buildPeakCache: larger buffer buckets match brute-force min/max per bucket', () => {
  const length = 100;
  const targetBucketCount = 10;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic wave with varying amplitude so min/max differ per bucket.
    data[i] = Math.sin(i * 0.3) * (i / length);
  }

  const { bucketSize, mins, maxs } = buildPeakCache(data, targetBucketCount);

  assert.equal(bucketSize, 10);
  assert.equal(mins.length, 10);
  assert.equal(maxs.length, 10);

  for (let b = 0; b < mins.length; b++) {
    const offset = b * bucketSize;
    const limit = Math.min(offset + bucketSize, length);
    const { min: bruteMin, max: bruteMax } = bruteForceMinMax(data, offset, limit);

    // Bucketed range must never be narrower than the brute-force scan over
    // the same sample range (it should be exactly equal for aligned buckets).
    assert.ok(mins[b] <= bruteMin, `bucket ${b} min ${mins[b]} should be <= brute-force min ${bruteMin}`);
    assert.ok(maxs[b] >= bruteMax, `bucket ${b} max ${maxs[b]} should be >= brute-force max ${bruteMax}`);
    assert.equal(mins[b], bruteMin);
    assert.equal(maxs[b], bruteMax);
  }
});

test('buildPeakCache: small buffer (fewer samples than buckets) yields one sample per bucket', () => {
  const data = new Float32Array([0.1, -0.9, 0.5, -0.2, 0.75]);
  const targetBucketCount = 8192;

  const { bucketSize, mins, maxs } = buildPeakCache(data, targetBucketCount);

  // With fewer samples than the target bucket count, bucketSize clamps to 1
  // and each sample gets its own bucket, so min === max === the sample.
  assert.equal(bucketSize, 1);
  assert.equal(mins.length, data.length);
  assert.equal(maxs.length, data.length);

  for (let i = 0; i < data.length; i++) {
    assert.equal(mins[i], data[i]);
    assert.equal(maxs[i], data[i]);
  }
});

test('buildPeakCache: empty buffer produces no buckets', () => {
  const { mins, maxs } = buildPeakCache(new Float32Array(0), 8192);
  assert.equal(mins.length, 0);
  assert.equal(maxs.length, 0);
});
