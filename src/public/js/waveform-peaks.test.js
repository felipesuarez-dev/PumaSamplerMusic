import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeakCache, buildPeakCacheAsync, selectLevel } from './waveform-peaks.js';

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

function assertLevelMatchesBruteForce(data, level) {
  for (let b = 0; b < level.mins.length; b++) {
    const offset = b * level.bucketSize;
    const limit = Math.min(offset + level.bucketSize, data.length);
    const { min: bruteMin, max: bruteMax } = bruteForceMinMax(data, offset, limit);
    assert.equal(level.mins[b], bruteMin, `bucketSize ${level.bucketSize} bucket ${b} min mismatch`);
    assert.equal(level.maxs[b], bruteMax, `bucketSize ${level.bucketSize} bucket ${b} max mismatch`);
  }
}

test('buildPeakCache: single-level (number arg) buckets match brute-force min/max per bucket', () => {
  const length = 1000;
  const targetBucketCount = 10;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Deterministic wave with varying amplitude so min/max differ per bucket.
    data[i] = Math.sin(i * 0.3) * (i / length);
  }

  const { levels } = buildPeakCache(data, targetBucketCount);

  assert.equal(levels.length, 1);
  const [level] = levels;
  assert.equal(level.bucketSize, 100);
  assert.equal(level.mins.length, 10);
  assert.equal(level.maxs.length, 10);
  assertLevelMatchesBruteForce(data, level);
});

test('buildPeakCache: multiple target counts produce distinct levels sorted coarsest-first', () => {
  // Data length + targets chosen so each target count yields a distinct
  // bucketSize >= the 64-sample floor.
  const length = 6400;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = Math.cos(i * 0.17) * ((i % 97) / 97);
  }

  // target=64 -> bucketSize 100 (coarsest), target=80 -> bucketSize 80,
  // target=100 -> bucketSize 64 (finest).
  const { levels } = buildPeakCache(data, [64, 80, 100]);

  assert.equal(levels.length, 3);
  assert.deepEqual(levels.map((l) => l.bucketSize), [100, 80, 64]);
  for (const level of levels) {
    assertLevelMatchesBruteForce(data, level);
  }
});

test('buildPeakCache: levels finer than the 64-sample floor are skipped', () => {
  const data = new Float32Array([0.1, -0.9, 0.5, -0.2, 0.75]);

  // With only 5 samples, every one of the default target counts collapses
  // to a bucketSize of 1, well under the 64-sample floor, so every level is
  // skipped and the raw per-sample scan (cheap for buffers this small) is
  // left to the caller.
  const { levels } = buildPeakCache(data);

  assert.deepEqual(levels, []);
});

test('buildPeakCache: duplicate bucket sizes across target counts are de-duplicated', () => {
  const length = 100;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin(i);

  // Both target counts are small enough that bucketSize clamps to the full
  // buffer length in a single bucket -> same bucketSize, should collapse to
  // one level.
  const { levels } = buildPeakCache(data, [1, 1]);

  assert.equal(levels.length, 1);
  assert.equal(levels[0].bucketSize, 100);
});

test('buildPeakCache: empty buffer produces no levels', () => {
  const { levels } = buildPeakCache(new Float32Array(0));
  assert.deepEqual(levels, []);
});

test('selectLevel: picks the coarsest level with bucketSize <= step', () => {
  const cache = {
    levels: [
      { bucketSize: 100, mins: new Float32Array(1), maxs: new Float32Array(1) },
      { bucketSize: 80, mins: new Float32Array(1), maxs: new Float32Array(1) },
      { bucketSize: 64, mins: new Float32Array(1), maxs: new Float32Array(1) },
    ],
  };

  assert.equal(selectLevel(cache, 200).bucketSize, 100);
  assert.equal(selectLevel(cache, 100).bucketSize, 100);
  assert.equal(selectLevel(cache, 90).bucketSize, 80);
  assert.equal(selectLevel(cache, 64).bucketSize, 64);
});

test('selectLevel: falls back to null when no level is fine enough for step', () => {
  const cache = {
    levels: [{ bucketSize: 100, mins: new Float32Array(1), maxs: new Float32Array(1) }],
  };

  assert.equal(selectLevel(cache, 50), null);
});

test('selectLevel: returns null for an empty or missing cache', () => {
  assert.equal(selectLevel({ levels: [] }, 10), null);
  assert.equal(selectLevel(null, 10), null);
});

test('buildPeakCacheAsync: output is bit-identical to buildPeakCache', async () => {
  // 600k samples so the coarsest level (8192 target → bucketSize ~74) survives
  // the 64-sample floor and gets split across multiple chunks — a real,
  // non-empty comparison rather than two empty caches.
  const length = 600000;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin(i * 0.017) * (0.3 + 0.7 * Math.sin(i * 0.0003));
  }

  const sync = buildPeakCache(data);
  const async = await buildPeakCacheAsync(data, { chunkBuckets: 1000 });

  assert.ok(sync.levels.length > 0, 'at least one level survives the floor');
  assert.equal(async.levels.length, sync.levels.length);
  for (let l = 0; l < sync.levels.length; l++) {
    assert.equal(async.levels[l].bucketSize, sync.levels[l].bucketSize);
    assert.deepEqual(async.levels[l].mins, sync.levels[l].mins);
    assert.deepEqual(async.levels[l].maxs, sync.levels[l].maxs);
  }
});

test('buildPeakCacheAsync: reports progress ending at exactly 1', async () => {
  const data = new Float32Array(600000);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.1);
  const seen = [];
  await buildPeakCacheAsync(data, { chunkBuckets: 500, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 0, 'onProgress was called');
  assert.equal(seen[seen.length - 1], 1);
  for (const f of seen) assert.ok(f >= 0 && f <= 1, `fraction ${f} in range`);
});

test('buildPeakCacheAsync: aborts via signal', async () => {
  const data = new Float32Array(600000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => buildPeakCacheAsync(data, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});
