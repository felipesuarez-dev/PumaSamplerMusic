import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSliceTimes } from './audio-engine.js';

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
