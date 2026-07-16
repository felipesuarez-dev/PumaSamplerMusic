// Pure, DOM-free peak-bucketing math extracted from waveform.js so it can be
// unit tested without a canvas/AudioBuffer/browser environment. Buckets a
// flat sample array (e.g. Float32Array from AudioBuffer.getChannelData(0))
// into `targetBucketCount` buckets, keeping the min/max sample per bucket.
export function buildPeakCache(data, targetBucketCount) {
  const bucketSize = Math.max(1, Math.ceil(data.length / targetBucketCount));
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
