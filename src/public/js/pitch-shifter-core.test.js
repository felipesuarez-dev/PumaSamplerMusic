import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GranularPitchShifter } from './pitch-shifter-core.js';

const SAMPLE_RATE = 44100;

function generateSine(freq, durationSeconds, sampleRate = SAMPLE_RATE) {
  const n = Math.round(durationSeconds * sampleRate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return samples;
}

function runShifter(inputSamples, pitchRatio) {
  const shifter = new GranularPitchShifter(1);
  const output = new Float32Array(inputSamples.length);
  for (let i = 0; i < inputSamples.length; i++) {
    output[i] = shifter.processSample([inputSamples[i]], pitchRatio)[0];
  }
  return output;
}

// Estimates dominant frequency via zero-crossing rate. The grain onset
// (silence mixed into the first ~2 grain lifetimes) is skipped so it doesn't
// skew the measurement.
function estimateFrequency(samples, sampleRate, skip) {
  let crossings = 0;
  for (let i = skip + 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
      crossings++;
    }
  }
  const durationSeconds = (samples.length - skip) / sampleRate;
  return crossings / 2 / durationSeconds;
}

const GRAIN_SIZE = 2048;
const SKIP = GRAIN_SIZE * 4; // let a few grain cycles pass before measuring

test('GranularPitchShifter: pitchRatio=1 leaves frequency unchanged', () => {
  const input = generateSine(440, 1.0);
  const output = runShifter(input, 1);
  const freq = estimateFrequency(output, SAMPLE_RATE, SKIP);
  assert.ok(Math.abs(freq - 440) < 20, `expected ~440Hz, got ${freq.toFixed(1)}Hz`);
});

test('GranularPitchShifter: pitchRatio=2 shifts frequency up one octave', () => {
  const input = generateSine(440, 1.0);
  const output = runShifter(input, 2);
  const freq = estimateFrequency(output, SAMPLE_RATE, SKIP);
  assert.ok(Math.abs(freq - 880) < 60, `expected ~880Hz, got ${freq.toFixed(1)}Hz`);
});

test('GranularPitchShifter: pitchRatio=0.5 shifts frequency down one octave', () => {
  const input = generateSine(440, 1.0);
  const output = runShifter(input, 0.5);
  const freq = estimateFrequency(output, SAMPLE_RATE, SKIP);
  assert.ok(Math.abs(freq - 220) < 30, `expected ~220Hz, got ${freq.toFixed(1)}Hz`);
});

test('GranularPitchShifter: output stays bounded (no runaway/NaN) over a longer run', () => {
  const input = generateSine(220, 2.0);
  const output = runShifter(input, 1.5);
  for (const sample of output) {
    assert.ok(Number.isFinite(sample), 'output sample must be finite');
    assert.ok(Math.abs(sample) <= 1.01, `output sample out of expected amplitude range: ${sample}`);
  }
});
