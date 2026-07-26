import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catmullRom,
  clampRate,
  dcBlockArray,
  RPM_33_RAD_PER_SEC,
  TurntableDeck,
} from './turntable-core.js';

const SR = 48000;

function sine(length, freq, sampleRate = SR) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return data;
}

function deckOf(channels, offsetSeconds = 0) {
  return new TurntableDeck({ channels, sampleRate: SR, offsetSeconds });
}

// Runs the deck for `frames` frames at a constant rate, returning per-channel output.
function run(deck, frames, rate, channelCount = 1) {
  const outputs = Array.from({ length: channelCount }, () => new Float32Array(frames));
  deck.process(outputs, rate);
  return outputs;
}

// Zero-crossing frequency estimate, same technique pitch-shifter-core.test.js uses.
function estimateFreq(data, sampleRate = SR) {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  }
  return (crossings / 2) * (sampleRate / data.length);
}

test('catmullRom: passes through its inner control points', () => {
  // t=0 is bit-exact by construction (the polynomial's constant term IS y1),
  // which is what makes an integral-position 1x read reproduce the source.
  assert.equal(catmullRom(0.1, 0.2, 0.3, 0.4, 0), 0.2);
  // t=1 is exact in real arithmetic (the y0/y1/y3 coefficients cancel and y2's
  // sum to 1) but not in floating point -- the summation order leaves ~5e-17.
  assert.ok(Math.abs(catmullRom(0.1, 0.2, 0.3, 0.4, 1) - 0.3) < 1e-15);
});

test('catmullRom: reproduces a linear ramp at the midpoint', () => {
  // A cubic through equally spaced collinear points is that same line.
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 0.5) - 1.5) < 1e-12);
});

test('catmullRom: overshoot peaks at exactly 1.25 for full-scale input', () => {
  // Weights at t=0.5 are (-1/16, 9/16, 9/16, -1/16) -> Sum|w| = 1.25, reached by
  // the alternating pattern. This is why the deck needs output headroom.
  assert.ok(Math.abs(catmullRom(-1, 1, 1, -1, 0.5) - 1.25) < 1e-12);
});

test('clampRate: clamps both directions and rejects non-finite input', () => {
  assert.equal(clampRate(9), 4);
  assert.equal(clampRate(-9), -4);
  assert.equal(clampRate(1.5), 1.5);
  assert.equal(clampRate(-1.5), -1.5);
  // NaN has no direction worth keeping, so it stops the deck; an infinity does,
  // so it clamps like any other over-range value.
  assert.equal(clampRate(NaN), 0);
  assert.equal(clampRate(Infinity), 4);
  assert.equal(clampRate(-Infinity), -4);
  assert.equal(clampRate(9, 2), 2);
});

test('RPM_33_RAD_PER_SEC: one hand-turn per ~1.8s is 1x', () => {
  const secondsPerTurn = (2 * Math.PI) / RPM_33_RAD_PER_SEC;
  assert.ok(Math.abs(secondsPerTurn - 1.8) < 0.01, `${secondsPerTurn}s per turn`);
});

test('deck at rate 1 is a pass-through of the source', () => {
  const src = sine(4096, 440);
  const deck = deckOf([src]);
  // Start clear of the edge margin so the gate opens and no edge clamp applies.
  deck.setPosition(64 / SR);
  const [out] = run(deck, 2048, 1);
  // Compared against the source through the deck's own DC blocker: that filter
  // is part of the output path, so this asserts the READ is sample-exact rather
  // than hiding interpolation error inside a loose tolerance.
  const expected = dcBlockArray(src.subarray(64, 64 + 2048));
  // Skip the gate's ramp-in; after it settles the two must agree tightly.
  for (let i = 600; i < 2048; i++) {
    assert.ok(Math.abs(out[i] - expected[i]) < 2e-3, `frame ${i}: ${out[i]} vs ${expected[i]}`);
  }
});

test('deck at rate -1 reads the source backwards', () => {
  const src = sine(4096, 440);
  const deck = deckOf([src]);
  const startSample = 3000;
  deck.setPosition(startSample / SR);
  const frames = 1500;
  const [out] = run(deck, frames, -1);
  // At rate -1 the head reads source[start - i], so the expected signal is that
  // reversed sequence through the deck's own DC blocker -- same construction as
  // the rate-1 test, so this asserts the reversed read is sample-exact.
  const reversed = new Float32Array(frames);
  for (let i = 0; i < frames; i++) reversed[i] = src[startSample - i];
  const expected = dcBlockArray(reversed);
  for (let i = 600; i < frames; i++) {
    assert.ok(Math.abs(out[i] - expected[i]) < 2e-3, `frame ${i}: ${out[i]} vs ${expected[i]}`);
  }
  // And the head must have travelled backwards by the frame count.
  assert.ok(Math.abs(deck.getPosition() - (startSample - 1500) / SR) < 1e-9);
});

test('deck at rate 2 doubles the pitch', () => {
  const src = sine(48000, 440);
  const deck = deckOf([src]);
  deck.setPosition(64 / SR);
  const [out] = run(deck, 8192, 2);
  // 8192 frames at 2x covers 16384 source samples, so measure against that span.
  const measured = estimateFreq(out.subarray(1000), SR);
  assert.ok(Math.abs(measured - 880) < 40, `expected ~880Hz, got ${measured}`);
});

test('deck position arithmetic holds across frames and honours offsetSeconds', () => {
  const src = sine(20000, 200);
  const offset = 12.5;
  const deck = deckOf([src], offset);
  deck.setPosition(offset + 5000 / SR);
  assert.ok(Math.abs(deck.getPosition() - (offset + 5000 / SR)) < 1e-12);
  run(deck, 1024, 1.5);
  const expected = offset + (5000 + 1024 * 1.5) / SR;
  assert.ok(Math.abs(deck.getPosition() - expected) < 1e-9, `${deck.getPosition()} vs ${expected}`);
});

test('deck clamps the head at the slab end and goes silent instead of holding DC', () => {
  const src = sine(4096, 440);
  const deck = deckOf([src]);
  deck.setPosition(4000 / SR);
  const [out] = run(deck, 2048, 4);
  // The head stops at the last sample rather than running off into nowhere --
  // otherwise the hand would travel back through silence before anything sounded.
  assert.ok(Math.abs(deck.getPosition() - 4095 / SR) < 1e-9);
  assert.ok(out.every(Number.isFinite));
  // Tail is silent: isAtEdge() forces the gate shut before the clamp repeats a
  // sample, so there is no DC step.
  const tail = out.subarray(1500);
  const peak = tail.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak < 1e-3, `edge tail should be silent, peak ${peak}`);
});

test('deck goes silent with no DC offset when the head is parked', () => {
  // Constant input: a stationary head would otherwise output that constant
  // forever, which is a DC thump into the master compressor and soft-clip.
  const src = new Float32Array(8192).fill(0.7);
  const deck = deckOf([src]);
  deck.setPosition(2000 / SR);
  const [out] = run(deck, 960, 0); // 20ms at 48k
  const settled = out.subarray(480); // after ~10ms
  const peak = settled.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak < 1e-3, `parked head should be silent, peak ${peak}`);
  const mean = settled.reduce((s, v) => s + v, 0) / settled.length;
  assert.ok(Math.abs(mean) < 1e-4, `parked head must not hold DC, mean ${mean}`);
});

test('deck reversing direction produces no amplitude discontinuity', () => {
  // pos is continuous and Catmull-Rom is C1, so a turnaround has no step to
  // begin with. This guards the gate: an earlier design silenced anything under
  // 6% speed and punched a hole into every direction change.
  const src = sine(8192, 300);
  const deck = deckOf([src]);
  deck.setPosition(4000 / SR);
  const frames = 2400;
  const rates = new Float32Array(frames);
  for (let i = 0; i < frames; i++) rates[i] = 1 - (2 * i) / (frames - 1); // +1 -> -1
  const outputs = [new Float32Array(frames)];
  // Open the gate first so the sweep is measured on a running deck.
  deck.process([new Float32Array(256)], 1);
  deck.process(outputs, rates);
  const out = outputs[0];
  let maxStep = 0;
  for (let i = 1; i < frames; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  let srcStep = 0;
  for (let i = 1; i < src.length; i++) srcStep = Math.max(srcStep, Math.abs(src[i] - src[i - 1]));
  assert.ok(maxStep < srcStep * 3, `turnaround step ${maxStep} vs source step ${srcStep}`);
  // And it must not have muted through the turnaround.
  const mid = out.subarray(frames / 2 - 60, frames / 2 + 60);
  assert.ok(mid.some((v) => Math.abs(v) > 1e-3), 'must not punch a hole at the reversal');
});

test('deck keeps channels independent and phase-locked', () => {
  // Sources long enough that 8192 frames at 1x never reach the edge -- otherwise
  // the edge gate would silence channel B and the test would pass for the wrong
  // reason.
  const a = sine(24000, 440);
  const b = new Float32Array(24000).fill(0.5);
  const deck = deckOf([a, b]);
  deck.setPosition(1000 / SR);
  const [outA, outB] = run(deck, 8192, 1, 2);
  // Channel B is constant, so the DC blocker drives it to zero as 0.999^n while
  // channel A keeps oscillating -- proving the two reads carry separate state.
  // Measured from 6000 because that decay needs ~6 time constants to clear 5e-3.
  const peakA = outA.subarray(6000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const peakB = outB.subarray(6000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peakA > 0.1, `channel A should be audible, peak ${peakA}`);
  assert.ok(peakB < 5e-3, `channel B is DC and must be blocked, peak ${peakB}`);
});

test('deck survives a random rate walk without going non-finite or out of range', () => {
  const src = sine(48000, 440);
  const deck = deckOf([src]);
  deck.setPosition(24000 / SR);
  // Deterministic pseudo-random walk (no Math.random, so failures reproduce).
  let seed = 12345;
  const nextRand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  const frames = 4096;
  const rates = new Float32Array(frames);
  for (let i = 0; i < frames; i++) rates[i] = nextRand() * 4;
  const outputs = [new Float32Array(frames)];
  for (let q = 0; q < 12; q++) deck.process(outputs, rates);
  assert.ok(outputs[0].every(Number.isFinite), 'output must stay finite');
  // Bounded well clear of runaway, but deliberately NOT at the interpolator's
  // static 1.25: a per-frame random rate teleports the head, and the DC blocker
  // is a differentiator with memory, so its transient response to that
  // discontinuous input measures ~1.50. Real use smooths the rate, where the
  // measured end-to-end peak on full-scale audio is ~1.06.
  const peak = outputs[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak <= 2, `peak ${peak} suggests a runaway, not a transient`);
  assert.ok(Number.isFinite(deck.getPosition()));
});

test('deck tolerates a degenerate slab without throwing', () => {
  const tiny = new TurntableDeck({ channels: [new Float32Array(3)], sampleRate: SR });
  assert.equal(tiny.isAtEdge(), true);
  const outputs = [new Float32Array(128)];
  assert.equal(tiny.process(outputs, 1), 128);
  assert.ok(outputs[0].every((v) => v === 0));

  const empty = new TurntableDeck({ channels: [new Float32Array(0)], sampleRate: SR });
  assert.equal(empty.process([new Float32Array(128)], 1), 0);
});
