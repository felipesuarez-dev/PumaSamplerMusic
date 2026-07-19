// Pure, DOM-free onset-detection DSP core for the Auto-Slicer feature.
// No AudioContext/Worker dependency so it can run under node:test, inside a
// module Worker (slicer-worker.js), or directly in the main thread.
//
// Pipeline (see detectOnsets): mono-mix -> normalize -> Hann-windowed FFT
// frames -> spectral flux -> adaptive threshold -> peak-picking -> min-IOI
// -> zero-crossing snap -> full-duration slice tiling.
//
// Performance note: a 1h file at 48kHz/hop 512 is ~337k frames. The frame
// loop in detectOnsets must not allocate per frame or GC pressure dominates
// runtime. FFT twiddle factors, the bit-reversal permutation and the Hann
// window are precomputed once per window size (module-level caches below,
// keyed by size) and detectOnsets preallocates its re/im/magnitude work
// buffers once and reuses them for every frame.

export function monoMix(channels) {
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c][i];
    out[i] = sum / channels.length;
  }
  return out;
}

// Scales data in place so its peak absolute sample hits `target`. No-op on
// silence (all-zero data) to avoid a divide-by-zero blow-up. In-place by
// design: for hour-long buffers a defensive copy would double memory, and
// callers that need the original untouched (e.g. a cached AudioBuffer) are
// expected to pass a disposable copy.
export function normalizePeak(data, target = 0.99) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return data;

  const scale = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= scale;
  return data;
}

// --- FFT: precomputed tables, cached per window size --------------------
// Each cache is built once (first call for a given size) and reused for
// every subsequent frame/call at that size, so the hot per-frame path below
// (fft()) never allocates.

const bitReverseCache = new Map();
const twiddleCache = new Map();
const hannCache = new Map();

function getBitReverseTable(size) {
  let table = bitReverseCache.get(size);
  if (table) return table;

  const bits = Math.log2(size);
  table = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let rev = 0;
    let v = i;
    for (let b = 0; b < bits; b++) {
      rev = (rev << 1) | (v & 1);
      v >>= 1;
    }
    table[i] = rev;
  }
  bitReverseCache.set(size, table);
  return table;
}

function getTwiddles(size) {
  let tw = twiddleCache.get(size);
  if (tw) return tw;

  const half = size / 2;
  const cosTable = new Float64Array(half);
  const sinTable = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / size;
    cosTable[k] = Math.cos(angle);
    sinTable[k] = Math.sin(angle);
  }
  tw = { cosTable, sinTable };
  twiddleCache.set(size, tw);
  return tw;
}

// Hann window coefficients for a given frame size, computed once and cached.
export function hann(size) {
  let table = hannCache.get(size);
  if (table) return table;

  table = new Float32Array(size);
  const denom = size - 1;
  for (let i = 0; i < size; i++) {
    table[i] = denom > 0 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom) : 1;
  }
  hannCache.set(size, table);
  return table;
}

// In-place iterative radix-2 decimation-in-time FFT. `re`/`im` must be the
// same power-of-two length; they are overwritten with the transform. Uses
// the bit-reversal and twiddle tables cached above, so calling this
// repeatedly at a fixed size (the normal case: one call per analysis frame)
// performs zero additional allocation past the first call.
export function fft(re, im) {
  const size = re.length;
  const bitRev = getBitReverseTable(size);

  for (let i = 0; i < size; i++) {
    const j = bitRev[i];
    if (j > i) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }

  const { cosTable, sinTable } = getTwiddles(size);
  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const stride = size / len;
    for (let i = 0; i < size; i += len) {
      for (let j = 0; j < half; j++) {
        const twIdx = j * stride;
        const cos = cosTable[twIdx];
        const sin = sinTable[twIdx];
        const evenIdx = i + j;
        const oddIdx = i + j + half;

        const oddRe = re[oddIdx] * cos - im[oddIdx] * sin;
        const oddIm = re[oddIdx] * sin + im[oddIdx] * cos;

        re[oddIdx] = re[evenIdx] - oddRe;
        im[oddIdx] = im[evenIdx] - oddIm;
        re[evenIdx] += oddRe;
        im[evenIdx] += oddIm;
      }
    }
  }
}

// Half-wave rectified spectral flux between two magnitude spectra of equal
// length: sum of the positive bin-by-bin increases only (rising energy is
// what marks an onset; falling energy is ignored).
export function spectralFlux(magnitude, prevMagnitude) {
  let sum = 0;
  for (let i = 0; i < magnitude.length; i++) {
    const diff = magnitude[i] - prevMagnitude[i];
    if (diff > 0) sum += diff;
  }
  return sum;
}

// Sum of squared samples over a windowed (post-Hann) real frame. The
// cheapest detection value available -- needs no FFT -- and simply tracks
// how loud the frame is, which is enough to flag sudden loud bursts.
export function frameEnergy(frameSamples) {
  let sum = 0;
  for (let i = 0; i < frameSamples.length; i++) {
    const s = frameSamples[i];
    sum += s * s;
  }
  return sum;
}

// High-frequency content: sum of (bin+1)*|X[bin]|^2 over the half-spectrum
// magnitude array. Weighting by bin index emphasizes high-frequency energy,
// which rises sharply on percussive/transient onsets (Masri, 1996). Takes
// the same half-spectrum magnitude shape spectralFlux consumes.
export function highFrequencyContent(magnitude) {
  let sum = 0;
  for (let i = 0; i < magnitude.length; i++) {
    sum += (i + 1) * magnitude[i] * magnitude[i];
  }
  return sum;
}

// Multiplier applied to the local mean absolute deviation on top of the
// local mean. Chosen empirically against the synthetic burst/click test
// signals in slicer-core.test.js so that sensitivity 0.5 (multiplier
// 1 + K*0.5) sits comfortably between "misses real onsets" (too high) and
// "fires on flux noise between onsets" (too low). K=3 mirrors the classic
// "outlier beyond ~3 deviations" MAD heuristic, adapted to a 0..1 sensitivity
// knob: sensitivity 1 -> multiplier 1 (permissive), sensitivity 0 -> 1+K=4
// (conservative).
const ADAPTIVE_THRESHOLD_K = 3;

// threshold[i] = localMean[i] + (1 + K*(1-sensitivity)) * localMeanAbsDeviation[i]
// over a +-`window` frame neighborhood.
export function adaptiveThreshold(flux, { window = 5, sensitivity = 0.5 } = {}) {
  const n = flux.length;
  const threshold = new Float32Array(n);
  const multiplier = 1 + ADAPTIVE_THRESHOLD_K * (1 - sensitivity);

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(n - 1, i + window);

    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += flux[j];
    const count = hi - lo + 1;
    const mean = sum / count;

    let madSum = 0;
    for (let j = lo; j <= hi; j++) madSum += Math.abs(flux[j] - mean);
    const mad = madSum / count;

    threshold[i] = mean + multiplier * mad;
  }

  return threshold;
}

// Frame indices where flux exceeds the adaptive threshold and is a local
// maximum (>= both neighbors, edges compared against -Infinity so they can
// still qualify).
export function pickPeaks(flux, threshold) {
  const peaks = [];
  const n = flux.length;
  for (let i = 0; i < n; i++) {
    if (flux[i] <= threshold[i]) continue;
    const prev = i > 0 ? flux[i - 1] : -Infinity;
    const next = i < n - 1 ? flux[i + 1] : -Infinity;
    if (flux[i] >= prev && flux[i] >= next) peaks.push(i);
  }
  return peaks;
}

// Greedily keeps the earliest onset in any cluster tighter than `minGap`,
// dropping later ones that are too close to the last KEPT onset. Unit-
// agnostic: called with sample counts in detectOnsets, but works the same
// on frame indices or seconds.
export function enforceMinIOI(onsets, minGap) {
  if (onsets.length === 0) return [];
  const sorted = [...onsets].sort((a, b) => a - b);
  const kept = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - kept[kept.length - 1] >= minGap) {
      kept.push(sorted[i]);
    }
  }
  return kept;
}

// Scans outward from `index` (both directions, closest distance wins) for
// the nearest zero crossing -- a sample pair whose sign flips (or an exact
// zero sample). Bounded by `maxRadius` because digital silence has no
// crossings at all; an unbounded scan would walk to the end of the buffer.
// Returns the original (clamped) index untouched if nothing is found.
//
// Best-of-two refinement (Shuriken sampleutils.cpp): once a genuine
// sign-flip pair (i, i+1) is found, the true zero crossing sits somewhere
// between the two samples, not necessarily at the earlier one. Returning
// whichever of the pair has the smaller absolute amplitude picks the sample
// that is actually closer to that true crossing, instead of always favoring
// the left side.
export function snapToZeroCrossing(data, index, maxRadius) {
  const n = data.length;
  if (n === 0) return index;
  const start = Math.max(0, Math.min(index, n - 1));

  const isCrossing = (i) => {
    if (i < 0 || i >= n - 1) return false;
    const a = data[i];
    const b = data[i + 1];
    return a === 0 || (a < 0 && b >= 0) || (a > 0 && b <= 0);
  };

  // Resolves a crossing found at pair (i, i+1) to the single best index. An
  // exact-zero sample at i is the crossing itself and wins outright; a
  // genuine sign-flip pair resolves to whichever side has smaller
  // |amplitude| (ties keep i, matching the pre-refinement behavior).
  const bestOfPair = (i) => {
    const a = data[i];
    if (a === 0) return i;
    const b = data[i + 1];
    return Math.abs(b) < Math.abs(a) ? i + 1 : i;
  };

  if (data[start] === 0) return start;

  for (let d = 0; d <= maxRadius; d++) {
    const right = start + d;
    if (isCrossing(right)) return bestOfPair(right);
    const left = start - d;
    if (left >= 0 && isCrossing(left)) return bestOfPair(left);
  }

  return start;
}

// Builds full-duration, gap-free slices from onset sample positions.
// Boundaries always include 0 and totalSamples. Any candidate slice shorter
// than minSliceSamples is folded into the previous slice (its end boundary
// is simply dropped) rather than kept as its own tiny slice -- this is what
// keeps the tiling complete with no gaps. The very first slice is the one
// exception: if it alone is short, there is no previous slice to merge into.
export function buildSlices(onsetSamples, totalSamples, minSliceSamples) {
  const clean = Array.from(new Set(onsetSamples.filter((s) => s > 0 && s < totalSamples))).sort(
    (a, b) => a - b
  );
  const boundaries = [0, ...clean, totalSamples];

  const slices = [];
  let start = boundaries[0];
  for (let i = 1; i < boundaries.length; i++) {
    const end = boundaries[i];
    const length = end - start;

    if (length < minSliceSamples && slices.length > 0) {
      slices[slices.length - 1].end = end;
    } else {
      slices.push({ start, end });
    }
    start = end;
  }

  return slices;
}

const WINDOW_SIZE = 1024;
const HOP_SIZE = 512;
const MIN_IOI_SECONDS = 0.05;
export const MIN_SLICE_SECONDS = 0.08;
const ZERO_CROSSING_RADIUS_SECONDS = 0.01;
const PROGRESS_FRAME_STRIDE = 512;

// Detection methods available to detectOnsets. 'specflux' (default)
// preserves the original behavior exactly; 'hfc' and 'energy' are Shuriken-
// derived alternatives that swap in a different per-frame detection value
// while every downstream stage (adaptive threshold, peak-picking, min-IOI,
// zero-crossing snap, slice tiling) stays method-agnostic.
const DETECTION_METHODS = new Set(['specflux', 'hfc', 'energy']);

// Orchestrates the full pipeline over one mono channel and returns onsets as
// { start, end } slice boundaries in seconds, tiling the whole buffer.
//
// Mutates channelData in place (see normalizePeak) -- callers that need the
// original buffer preserved must pass a disposable copy. This is deliberate:
// defensively copying an hour-long buffer would double peak memory use.
//
// `method` selects the per-frame detection value: 'specflux' (default,
// spectral flux -- rising spectral energy), 'hfc' (high-frequency content),
// or 'energy' (frame RMS energy, no FFT needed but computed alongside it
// here to keep the frame loop's shape and allocations identical across
// methods). An unknown method falls back to 'specflux'.
export function detectOnsets(
  channelData,
  sampleRate,
  { sensitivity = 0.5, method = 'specflux', onProgress } = {}
) {
  const totalSamples = channelData.length;
  if (totalSamples === 0) return [];

  const numFrames = Math.max(0, Math.floor((totalSamples - WINDOW_SIZE) / HOP_SIZE) + 1);
  if (numFrames <= 0) {
    return [{ start: 0, end: totalSamples / sampleRate }];
  }

  const effectiveMethod = DETECTION_METHODS.has(method) ? method : 'specflux';

  normalizePeak(channelData, 0.99);

  const hannWindow = hann(WINDOW_SIZE);
  const halfSize = WINDOW_SIZE / 2;

  // Preallocated once, reused for every frame -- the ~337k frames of a 1h
  // file must not allocate per frame.
  const re = new Float32Array(WINDOW_SIZE);
  const im = new Float32Array(WINDOW_SIZE);
  let magnitude = new Float32Array(halfSize);
  let prevMagnitude = new Float32Array(halfSize);
  const detection = new Float32Array(numFrames);

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * HOP_SIZE;
    for (let i = 0; i < WINDOW_SIZE; i++) {
      re[i] = channelData[offset + i] * hannWindow[i];
      im[i] = 0;
    }

    // frameEnergy needs the windowed real samples as they are *before* the
    // FFT below overwrites re/im in place with the transform.
    const energyValue = effectiveMethod === 'energy' ? frameEnergy(re) : 0;

    fft(re, im);

    for (let i = 0; i < halfSize; i++) {
      magnitude[i] = Math.hypot(re[i], im[i]);
    }

    switch (effectiveMethod) {
      case 'hfc':
        detection[frame] = highFrequencyContent(magnitude);
        break;
      case 'energy':
        detection[frame] = energyValue;
        break;
      case 'specflux':
      default:
        // Frame 0 has no previous frame to compare against -- prevMagnitude
        // starts all-zero, so without this guard spectralFlux would score
        // frame 0's full spectral energy as a rise, registering a fake
        // onset right at (or ~10ms into) any signal that starts sounding at
        // sample 0.
        detection[frame] = frame === 0 ? 0 : spectralFlux(magnitude, prevMagnitude);
        break;
    }

    // Ping-pong the magnitude buffers instead of copying.
    const tmp = prevMagnitude;
    prevMagnitude = magnitude;
    magnitude = tmp;

    if (onProgress && (frame % PROGRESS_FRAME_STRIDE === 0 || frame === numFrames - 1)) {
      // numFrames === 1 has no meaningful fraction between frames -- report
      // done (1) instead of the frame/(numFrames-1||1) formula, which would
      // otherwise divide by the fallback 1 and always emit 0.
      onProgress(numFrames > 1 ? frame / (numFrames - 1) : 1);
    }
  }

  const threshold = adaptiveThreshold(detection, { window: 5, sensitivity });
  const peakFrames = pickPeaks(detection, threshold);

  // Frame index -> sample index, compensating for the window's center: a
  // spectral event detected at frame f actually sits windowSize/2 samples
  // after that frame's left (analysis) edge, not at the edge itself.
  const onsetSamplesRaw = peakFrames.map((f) => f * HOP_SIZE + halfSize);

  const minIOISamples = Math.round(MIN_IOI_SECONDS * sampleRate);
  const dedupedSamples = enforceMinIOI(onsetSamplesRaw, minIOISamples);

  const zeroCrossingRadius = Math.round(ZERO_CROSSING_RADIUS_SECONDS * sampleRate);
  const snappedSamples = dedupedSamples.map((s) =>
    snapToZeroCrossing(channelData, Math.min(s, totalSamples - 1), zeroCrossingRadius)
  );

  const minSliceSamples = Math.round(MIN_SLICE_SECONDS * sampleRate);
  const slices = buildSlices(snappedSamples, totalSamples, minSliceSamples);

  return slices.map(({ start, end }) => ({ start: start / sampleRate, end: end / sampleRate }));
}
