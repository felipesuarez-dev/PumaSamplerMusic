import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSliceTimes, semitonesToRatio, reverseSliceTimes, computeReleaseSchedule, clampAttackSeconds } from './audio-engine.js';

const MIN_DURATION = 0.01;

test('computeSliceTimes: negative start clamps to 0', () => {
  const { startTime } = computeSliceTimes(-5, 3, 10);
  assert.equal(startTime, 0);
});

test('computeSliceTimes: end greater than buffer duration clamps to duration', () => {
  const bufferDuration = 5;
  const { endTime } = computeSliceTimes(0, 100, bufferDuration);
  assert.equal(endTime, bufferDuration);
});

test('computeSliceTimes: start > end never produces a negative duration (respects minimum clamp)', () => {
  const { startTime, endTime, duration } = computeSliceTimes(4, 1, 10);
  assert.equal(startTime, 4);
  assert.equal(endTime, 1);
  assert.equal(duration, MIN_DURATION);
  assert.ok(duration >= 0);
});

test('computeSliceTimes: normal case start=1, end=3, duration=5', () => {
  const result = computeSliceTimes(1, 3, 5);
  assert.deepEqual(result, { startTime: 1, endTime: 3, duration: 2 });
});

test('semitonesToRatio: 0 semitones is unchanged ratio', () => {
  assert.equal(semitonesToRatio(0), 1);
});

test('semitonesToRatio: +12 semitones doubles the ratio (one octave up)', () => {
  assert.equal(semitonesToRatio(12), 2);
});

test('semitonesToRatio: -12 semitones halves the ratio (one octave down)', () => {
  assert.equal(semitonesToRatio(-12), 0.5);
});

test('reverseSliceTimes: mirrors start/end around the buffer duration', () => {
  const { start, end } = reverseSliceTimes(1, 3, 10);
  assert.equal(start, 7); // duration - end
  assert.equal(end, 9); // duration - start
});

test('reverseSliceTimes: preserves ordering even when the mapped range would invert', () => {
  const { start, end } = reverseSliceTimes(6, 2, 10);
  assert.ok(start <= end);
  assert.deepEqual({ start, end }, { start: 4, end: 8 });
});

test('reverseSliceTimes: clamps a negative start to the buffer bounds', () => {
  const { start, end } = reverseSliceTimes(-5, 3, 10);
  assert.equal(start, 7);
  assert.equal(end, 10);
});

test('reverseSliceTimes: clamps an end past the buffer duration', () => {
  const { start, end } = reverseSliceTimes(2, 100, 10);
  assert.equal(start, 0);
  assert.equal(end, 8);
});

test('reverseSliceTimes: degenerate start === end maps to a single point', () => {
  const { start, end } = reverseSliceTimes(4, 4, 10);
  assert.equal(start, end);
  assert.equal(start, 6);
});

test('computeReleaseSchedule: release fits well inside the slice, unaffected by attack', () => {
  const { fadeStartOffset, releaseEffSec } = computeReleaseSchedule(2, 0, 500);
  assert.equal(releaseEffSec, 0.5);
  assert.equal(fadeStartOffset, 1.5);
});

test('computeReleaseSchedule: release longer than the slice is floored to what remains', () => {
  const { fadeStartOffset, releaseEffSec } = computeReleaseSchedule(0.08, 0, 2000);
  assert.equal(releaseEffSec, 0.08);
  assert.equal(fadeStartOffset, 0);
});

test('computeReleaseSchedule: attack eats into the room left for release', () => {
  const { fadeStartOffset, releaseEffSec } = computeReleaseSchedule(1, 800, 500);
  assert.ok(Math.abs(releaseEffSec - 0.2) < 1e-9); // 1 - 0.8 (attack) available for release
  assert.ok(Math.abs(fadeStartOffset - 0.8) < 1e-9);
});

test('computeReleaseSchedule: attack alone already exceeds the slice, release is fully floored to 0', () => {
  const { fadeStartOffset, releaseEffSec } = computeReleaseSchedule(0.05, 2000, 100);
  assert.equal(releaseEffSec, 0);
  assert.equal(fadeStartOffset, 0.05);
});

test('clampAttackSeconds: attack shorter than the slice is unaffected', () => {
  assert.equal(clampAttackSeconds(200, 2), 0.2);
});

test('clampAttackSeconds: attack longer than the slice is floored to the slice duration', () => {
  // 2000ms attack on an 80ms slice would otherwise ramp to only ~4% of
  // volume before the one-shot's hard stop cuts it off.
  assert.equal(clampAttackSeconds(2000, 0.08), 0.08);
});

test('clampAttackSeconds: zero/negative attack clamps to 0', () => {
  assert.equal(clampAttackSeconds(0, 1), 0);
  assert.equal(clampAttackSeconds(-50, 1), 0);
});
