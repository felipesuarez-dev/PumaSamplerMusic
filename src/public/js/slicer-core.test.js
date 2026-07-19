import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monoMix,
  normalizePeak,
  hann,
  fft,
  spectralFlux,
  adaptiveThreshold,
  pickPeaks,
  enforceMinIOI,
  snapToZeroCrossing,
  buildSlices,
  detectOnsets,
} from './slicer-core.js';

// Deterministic PRNG (mulberry32) so noise-burst test signals are
// reproducible across runs and platforms.
function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('monoMix: averages multiple channels sample-by-sample', () => {
  const left = new Float32Array([1, 0, -1, 0.5]);
  const right = new Float32Array([-1, 0, 1, 0.5]);
  const mixed = monoMix([left, right]);
  assert.deepEqual(Array.from(mixed), [0, 0, 0, 0.5]);
});

test('monoMix: single channel is returned as-is', () => {
  const only = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(monoMix([only]), only);
});

test('normalizePeak: scales in place so the peak absolute sample hits target', () => {
  const data = new Float32Array([0.1, -0.4, 0.2]);
  normalizePeak(data, 0.99);
  const peak = Math.max(...Array.from(data).map(Math.abs));
  assert.ok(Math.abs(peak - 0.99) < 1e-6);
});

test('normalizePeak: no-op on silence (all-zero data), no NaN/Infinity', () => {
  const data = new Float32Array(8);
  normalizePeak(data, 0.99);
  for (const sample of data) {
    assert.equal(sample, 0);
  }
});

test('hann: coefficients are 0 at both edges and 1 at the center, cached across calls', () => {
  const size = 8;
  const w1 = hann(size);
  const w2 = hann(size);
  assert.equal(w1, w2, 'expected the same cached Float32Array instance');
  assert.ok(Math.abs(w1[0]) < 1e-6);
  assert.ok(Math.abs(w1[size - 1]) < 1e-6);
  assert.ok(w1[Math.floor(size / 2)] > 0.9);
});

test('fft: a unit impulse has flat unit magnitude across every bin', () => {
  const size = 64;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  re[0] = 1;

  fft(re, im);

  for (let i = 0; i < size; i++) {
    const magnitude = Math.hypot(re[i], im[i]);
    assert.ok(Math.abs(magnitude - 1) < 1e-6, `bin ${i} magnitude ${magnitude} should be ~1`);
  }
});

test('fft: a pure sine at bin k puts its energy at bin k (and the mirror bin)', () => {
  const size = 64;
  const targetBin = 5;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    re[i] = Math.sin((2 * Math.PI * targetBin * i) / size);
  }

  fft(re, im);

  const magnitudes = [];
  for (let i = 0; i < size; i++) magnitudes.push(Math.hypot(re[i], im[i]));

  const peakBin = magnitudes.indexOf(Math.max(...magnitudes));
  assert.ok(
    peakBin === targetBin || peakBin === size - targetBin,
    `expected peak at bin ${targetBin} or ${size - targetBin}, got ${peakBin}`
  );

  // Energy should be strongly concentrated: peak much larger than a bin far
  // from both the target and its mirror.
  const farBin = magnitudes[(targetBin + size / 4) % size];
  assert.ok(magnitudes[peakBin] > farBin * 5);
});

test('spectralFlux: zero for identical spectra, positive and larger for a bigger amplitude step', () => {
  const prev = new Float32Array([0.1, 0.1, 0.1, 0.1]);
  const same = new Float32Array([0.1, 0.1, 0.1, 0.1]);
  assert.equal(spectralFlux(same, prev), 0);

  const smallStep = new Float32Array([0.2, 0.1, 0.1, 0.1]);
  const bigStep = new Float32Array([0.9, 0.1, 0.1, 0.1]);

  const smallFlux = spectralFlux(smallStep, prev);
  const bigFlux = spectralFlux(bigStep, prev);

  assert.ok(smallFlux > 0);
  assert.ok(bigFlux > smallFlux);
});

test('spectralFlux: falling energy is half-wave rectified away (ignored)', () => {
  const prev = new Float32Array([0.9, 0.5]);
  const drop = new Float32Array([0.1, 0.1]);
  assert.equal(spectralFlux(drop, prev), 0);
});

// A gently wobbling noise floor (so local mean absolute deviation is never
// exactly zero) with one sharp spike at index 10, far enough from the edges
// that its local window (+-5) never overlaps index 0 or 3.
const WOBBLY_FLUX_WITH_SPIKE = [
  0.01, 0.03, 0.02, 0.04, 0.01, 0.05, 0.02, 0.03, 0.04, 0.02, 5, 0.02, 0.03, 0.01, 0.04, 0.02, 0.03,
  0.01, 0.02, 0.03, 0.01,
];

test('adaptiveThreshold: rises above a noisy floor around a sharp flux spike', () => {
  const flux = new Float32Array(WOBBLY_FLUX_WITH_SPIKE);
  const threshold = adaptiveThreshold(flux, { window: 5, sensitivity: 0.5 });

  assert.ok(flux[10] > threshold[10], 'the spike should clear its own local threshold');
  assert.ok(flux[0] < threshold[0], 'the wobbly floor away from the spike should stay under threshold');
});

test('adaptiveThreshold: higher sensitivity lowers the threshold (more permissive)', () => {
  const flux = new Float32Array(WOBBLY_FLUX_WITH_SPIKE);
  const lowSensitivity = adaptiveThreshold(flux, { window: 5, sensitivity: 0.1 });
  const highSensitivity = adaptiveThreshold(flux, { window: 5, sensitivity: 0.9 });

  // Index 3's local window (+-5) never reaches the spike at index 10, so its
  // local mean absolute deviation is strictly positive and the sensitivity
  // multiplier has visible effect there.
  assert.ok(highSensitivity[3] < lowSensitivity[3]);
});

test('pickPeaks: finds the single local maximum above threshold', () => {
  const flux = new Float32Array([0, 0.1, 0.2, 5, 0.3, 0.1, 0]);
  const threshold = new Float32Array(flux.length).fill(1);
  const peaks = pickPeaks(flux, threshold);
  assert.deepEqual(peaks, [3]);
});

test('pickPeaks: nothing above threshold yields no peaks', () => {
  const flux = new Float32Array([0.1, 0.2, 0.1]);
  const threshold = new Float32Array(flux.length).fill(1);
  assert.deepEqual(pickPeaks(flux, threshold), []);
});

test('enforceMinIOI: drops onsets that are too close to the last kept one', () => {
  const onsets = [0, 10, 15, 100, 500, 520];
  const kept = enforceMinIOI(onsets, 50);
  assert.deepEqual(kept, [0, 100, 500]);
});

test('enforceMinIOI: empty input returns empty output', () => {
  assert.deepEqual(enforceMinIOI([], 50), []);
});

test('snapToZeroCrossing: finds the nearest sign change within radius', () => {
  // Sign change between index 4 (-1) and 5 (1); start the search at 2.
  const data = new Float32Array([-1, -1, -1, -1, -1, 1, 1, 1]);
  const snapped = snapToZeroCrossing(data, 2, 10);
  assert.equal(snapped, 4);
});

test('snapToZeroCrossing: closest crossing wins over a farther one', () => {
  // Crossings at index 1->2 (distance 1 from start=2... use start=3) and 5->6.
  const data = new Float32Array([1, 1, -1, -1, -1, -1, 1, 1]);
  // start at 3: nearest crossing is at index 1 (distance 2) vs index 5 (distance 2) -- tie by construction.
  // Use start at 4 so left crossing (index 1, distance 3) is farther than right crossing (index 5, distance 1).
  const snapped = snapToZeroCrossing(data, 4, 10);
  assert.equal(snapped, 5);
});

test('snapToZeroCrossing: bounded radius returns the original index when no crossing exists nearby', () => {
  // A strictly positive constant signal never changes sign, so within a
  // bounded radius there is nothing to snap to (digital silence has the
  // same property: no sign changes at all).
  const constant = new Float32Array(50).fill(0.3);
  const snapped = snapToZeroCrossing(constant, 25, 5);
  assert.equal(snapped, 25);
});

test('snapToZeroCrossing: exact digital silence (all zero) returns the original index immediately', () => {
  const silence = new Float32Array(50);
  const snapped = snapToZeroCrossing(silence, 25, 5);
  assert.equal(snapped, 25);
});

test('buildSlices: tiles the full duration with no gaps from 0 to totalSamples', () => {
  const onsets = [100, 300, 700];
  const slices = buildSlices(onsets, 1000, 50);
  assert.equal(slices[0].start, 0);
  assert.equal(slices[slices.length - 1].end, 1000);
  for (let i = 1; i < slices.length; i++) {
    assert.equal(slices[i].start, slices[i - 1].end, 'slices must be contiguous, no gaps');
  }
});

test('buildSlices: a slice shorter than minSliceSamples is merged into the previous one', () => {
  // Onsets at 100 and 120: the [100,120) slice is only 20 samples, well
  // under the 50-sample minimum, so it must fold into the previous slice.
  const onsets = [100, 120, 700];
  const slices = buildSlices(onsets, 1000, 50);

  const hasTinySlice = slices.some((s) => s.start === 100 && s.end === 120);
  assert.equal(hasTinySlice, false);

  // The samples between 100 and 120 must still belong to some slice
  // (full-duration tiling, no gaps/drops).
  const covering = slices.find((s) => s.start <= 100 && s.end >= 120);
  assert.ok(covering, 'samples [100,120) must still be covered by a slice');
});

test('buildSlices: a short trailing slice merges into the previous slice too', () => {
  const onsets = [500, 990]; // last slice [990,1000) is only 10 samples
  const slices = buildSlices(onsets, 1000, 50);
  const hasTinyTail = slices.some((s) => s.start === 990);
  assert.equal(hasTinyTail, false);
  assert.equal(slices[slices.length - 1].end, 1000);
});

test('buildSlices: with no onsets, the whole buffer is a single slice', () => {
  const slices = buildSlices([], 1000, 50);
  assert.deepEqual(slices, [{ start: 0, end: 1000 }]);
});

// --- End-to-end: detectOnsets on a synthetic click signal -----------------
//
// Each "click" is a burst of noise shaped by a fast exponential decay
// envelope, like a drum hit -- a single sharp transient followed by near-
// silence, rather than several hundred milliseconds of sustained loud noise.
// This is deliberate: sustained full-amplitude noise keeps flux high for the
// whole burst, which pollutes the adaptive threshold's own local window
// (+-5 frames straddles the transient) and can bury the attack under its
// own decay tail. A decaying click matches the real-world case this
// algorithm targets (percussive onsets) and is the alternative signal named
// in the plan.
function buildClickSignal({ sampleRate, totalSeconds, onsetSeconds, decaySeconds, amplitude }) {
  const totalSamples = Math.round(sampleRate * totalSeconds);
  const data = new Float32Array(totalSamples);
  const rand = mulberry32(1234);
  const decaySamples = Math.round(sampleRate * decaySeconds * 8); // ~8 time constants to fade out

  for (const onsetSec of onsetSeconds) {
    const startSample = Math.round(sampleRate * onsetSec);
    for (let i = 0; i < decaySamples && startSample + i < totalSamples; i++) {
      const envelope = Math.exp(-i / sampleRate / decaySeconds);
      data[startSample + i] += (rand() * 2 - 1) * amplitude * envelope;
    }
  }

  return data;
}

test('detectOnsets: finds decaying-click onsets within +-20ms at sensitivity 0.5', () => {
  const sampleRate = 48000;
  const onsetSeconds = [0.5, 1.5, 2.5, 3.5];
  const data = buildClickSignal({
    sampleRate,
    totalSeconds: 4,
    onsetSeconds,
    decaySeconds: 0.02,
    amplitude: 0.8,
  });

  const slices = detectOnsets(data, sampleRate, { sensitivity: 0.5 });

  // Slice starts after the first one correspond to detected onsets.
  const detectedStarts = slices.slice(1).map((s) => s.start);

  assert.ok(
    detectedStarts.length >= onsetSeconds.length - 1,
    `expected to detect most of the ${onsetSeconds.length} onsets, got ${detectedStarts.length}: ${detectedStarts}`
  );

  for (const expected of onsetSeconds) {
    const closest = detectedStarts.reduce(
      (best, s) => (Math.abs(s - expected) < Math.abs(best - expected) ? s : best),
      Infinity
    );
    assert.ok(
      Math.abs(closest - expected) <= 0.02,
      `expected an onset within +-20ms of ${expected}s, closest detected was ${closest}s`
    );
  }
});

test('detectOnsets: higher sensitivity finds at least as many onsets as lower sensitivity', () => {
  const sampleRate = 48000;
  const onsetSeconds = [0.5, 1.5, 2.5, 3.5];
  const lowData = buildClickSignal({
    sampleRate,
    totalSeconds: 4,
    onsetSeconds,
    decaySeconds: 0.02,
    amplitude: 0.8,
  });
  const highData = new Float32Array(lowData); // detectOnsets mutates in place, use separate copies

  const lowSensitivitySlices = detectOnsets(lowData, sampleRate, { sensitivity: 0.2 });
  const highSensitivitySlices = detectOnsets(highData, sampleRate, { sensitivity: 0.9 });

  assert.ok(highSensitivitySlices.length >= lowSensitivitySlices.length);
});

test('detectOnsets: reports monotonic progress from 0 to 1', () => {
  const sampleRate = 48000;
  const data = buildClickSignal({
    sampleRate,
    totalSeconds: 1,
    onsetSeconds: [0.3],
    decaySeconds: 0.02,
    amplitude: 0.8,
  });

  const values = [];
  detectOnsets(data, sampleRate, {
    sensitivity: 0.5,
    onProgress: (v) => values.push(v),
  });

  assert.ok(values.length > 0);
  assert.equal(values[values.length - 1], 1);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1]);
  }
});

test('detectOnsets: empty input returns no slices', () => {
  assert.deepEqual(detectOnsets(new Float32Array(0), 48000), []);
});

test('detectOnsets: a tone starting at sample 0 does not register a spurious onset at t~=0', () => {
  const sampleRate = 48000;
  const totalSeconds = 2;
  const totalSamples = Math.round(sampleRate * totalSeconds);
  const data = new Float32Array(totalSamples);
  // A continuous tone starting right at sample 0: frame 0's magnitude is
  // nonzero while prevMagnitude starts all-zero, which used to be scored as
  // a huge rise (a fake ~10ms first slice) before frame 0's flux was forced
  // to 0.
  for (let i = 0; i < totalSamples; i++) {
    data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  // A real, louder onset later on, so the pipeline still has something to
  // legitimately detect.
  const rand = mulberry32(99);
  const decaySamples = Math.round(sampleRate * 0.02 * 8);
  const onsetSample = Math.round(sampleRate * 1.0);
  for (let i = 0; i < decaySamples && onsetSample + i < totalSamples; i++) {
    const envelope = Math.exp(-i / sampleRate / 0.02);
    data[onsetSample + i] += (rand() * 2 - 1) * 0.9 * envelope;
  }

  const slices = detectOnsets(data, sampleRate, { sensitivity: 0.5 });

  // The very first slice must start at 0 and extend well past t=0 -- no
  // spurious near-zero boundary from frame 0's would-be fake onset.
  assert.equal(slices[0].start, 0);
  assert.ok(
    slices[0].end > 0.05,
    `expected the first slice to extend past 50ms with no spurious onset near t=0, got end=${slices[0].end}`
  );
});

test('detectOnsets: progress reaches 1 even for a single-frame (tiny) buffer', () => {
  const sampleRate = 48000;
  // Within [1024, 1535] samples this is exactly one analysis frame
  // (numFrames === 1), where frame / (numFrames - 1 || 1) used to always
  // evaluate to 0 and progress never reached 1.
  const totalSamples = 1200;
  const data = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    data[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }

  const values = [];
  detectOnsets(data, sampleRate, {
    sensitivity: 0.5,
    onProgress: (v) => values.push(v),
  });

  assert.ok(values.length > 0);
  assert.equal(values[values.length - 1], 1);
});
