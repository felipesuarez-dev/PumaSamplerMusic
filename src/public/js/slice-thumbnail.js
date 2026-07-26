// Tiny min/max waveform renderer for ONE slice, sized for a drag ghost rather
// than a full waveform view.
//
// Why not waveform-peaks.js's buildPeakCache: that module targets bucket
// *counts* in the thousands and skips any level whose bucketSize would fall
// under MIN_LEVEL_BUCKET_SIZE (64), so any buffer shorter than ~524288 samples
// (~10.9s at 48kHz) comes back with ZERO levels. Nearly every chop is shorter
// than that, so it would return nothing usable for the common case. A ghost
// needs exactly `columns` buckets no matter how short the slice is, which is a
// different contract, not a tweak of the same one.
//
// The math is split from the painting so it can be unit tested under
// node:test without a canvas, matching how waveform-peaks.js is structured.

// A slice can legitimately be the whole track (Manual Chops starts with one
// slice spanning everything). A 5-minute slice is ~14M samples, and a full
// min/max scan of that costs ~15ms -- enough to hitch the frame the drag
// starts on. Striding caps the scan: at 132px wide the thumbnail cannot show
// the difference, and the worst case drops to ~2ms.
const MAX_SCAN_SAMPLES = 2e6;

// Builds `columns` min/max buckets over channelData[startSample..endSample).
// Pure: never mutates the input, always returns a fresh result. Indices are
// clamped into the array, so an out-of-range range is safe rather than fatal.
export function buildSlicePeaks(channelData, startSample, endSample, columns) {
  const len = channelData ? channelData.length : 0;
  const start = Math.max(0, Math.min(len, Math.floor(startSample)));
  const end = Math.max(start, Math.min(len, Math.floor(endSample)));
  const sampleCount = end - start;

  // Never ask for more columns than there are samples: a 300-sample chop gets
  // 300 columns and still reads as a waveform instead of a box of empty
  // buckets. A degenerate range still returns one (silent) column so callers
  // always get a paintable result.
  const cols = Math.max(1, Math.min(Math.floor(columns) || 1, sampleCount || 1));
  const mins = new Float32Array(cols);
  const maxs = new Float32Array(cols);
  if (sampleCount === 0) return { mins, maxs, columns: cols };

  const stride = Math.max(1, Math.ceil(sampleCount / MAX_SCAN_SAMPLES));

  for (let c = 0; c < cols; c++) {
    // Derive bucket edges from the column index rather than accumulating a
    // step, so rounding can never drift past `end` on the last column.
    const from = start + Math.floor((c * sampleCount) / cols);
    const to = start + Math.floor(((c + 1) * sampleCount) / cols);
    let min = 0;
    let max = 0;
    let seen = false;
    for (let i = from; i < to; i += stride) {
      const sample = channelData[i];
      if (!seen) { min = sample; max = sample; seen = true; continue; }
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    // A bucket narrower than the stride can come out empty -- sample its first
    // frame directly so it still reflects the audio instead of reading silent.
    if (!seen && from < len) { min = channelData[from]; max = channelData[from]; }
    mins[c] = min;
    maxs[c] = max;
  }

  return { mins, maxs, columns: cols };
}

// Paints peaks into any 2D context, centred vertically. Kept separate from the
// math so the math stays testable outside a browser. `dpr` scales the minimum
// bar height only -- the caller owns the context's own transform/backing size.
export function drawSlicePeaks(ctx, peaks, { width, height, color, dpr = 1 }) {
  if (!ctx || !peaks || !peaks.columns) return;
  const mid = height / 2;
  const colWidth = width / peaks.columns;
  // Floor of 1 device pixel so a near-silent passage still draws a centre line
  // instead of disappearing -- an empty box reads as "no audio here", which
  // would be a lie about the slice being dragged.
  const minBar = Math.max(1, dpr);

  ctx.fillStyle = color;
  for (let c = 0; c < peaks.columns; c++) {
    const top = mid - peaks.maxs[c] * mid;
    const bottom = mid - peaks.mins[c] * mid;
    const barHeight = Math.max(minBar, bottom - top);
    ctx.fillRect(c * colWidth, top, Math.max(1, colWidth), barHeight);
  }
}
