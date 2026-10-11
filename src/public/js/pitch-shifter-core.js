// Core DSP for the two-grain overlap-add (OLA) granular pitch shifter,
// separated from pitch-shifter-processor.js so it can run under node:test
// (AudioWorkletProcessor/registerProcessor only exist inside a real
// AudioWorkletGlobalScope, not in Node or a plain browser window).
export class GranularPitchShifter {
  constructor(channelCount, grainSize = 2048) {
    this.grainSize = grainSize;
    this.bufferSize = grainSize * 4; // headroom so grain read drift never wraps into unwritten/stale data
    this.channelBuffers = Array.from({ length: channelCount }, () => new Float32Array(this.bufferSize));
    this.samplesWritten = 0;
    this.grains = [
      { phase: 0, readPos: -grainSize },
      { phase: grainSize / 2, readPos: -grainSize / 2 },
    ];
    // Reused output scratch. processSample runs ~48000 times per second per
    // voice INSIDE the audio rendering thread, where per-sample allocations
    // (the previous `new Array(channelCount)` here, plus the caller's own
    // input array) put real GC pressure on the real-time thread and, under
    // heavy polyphony, degraded the whole context into silence until a
    // reload. Callers consume the values before the next call.
    this.outputSample = new Array(channelCount).fill(0);
  }

  readInterpolated(buffer, pos) {
    const size = buffer.length;
    const base = Math.floor(pos);
    const frac = pos - base;
    const i0 = ((base % size) + size) % size;
    const i1 = (i0 + 1) % size;
    return buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }

  // inputSample: array of per-channel values for one audio frame.
  // Returns a REUSED per-channel array (this.outputSample) — the contract is
  // "consume before the next call", which is what the AudioWorklet processor
  // does (it copies the values into the output bus immediately). Returning a
  // fresh array here was 48000 allocations/second/voice in the real-time
  // thread.
  processSample(inputSample, pitchRatio) {
    const channelCount = this.channelBuffers.length;
    const writeIdx = this.samplesWritten % this.bufferSize;

    for (let ch = 0; ch < channelCount; ch++) {
      this.channelBuffers[ch][writeIdx] = inputSample[ch];
    }

    const output = this.outputSample;
    for (let ch = 0; ch < channelCount; ch++) {
      let sample = 0;
      for (const grain of this.grains) {
        const windowPos = grain.phase / this.grainSize;
        const gain = 0.5 - 0.5 * Math.cos(2 * Math.PI * windowPos);
        sample += this.readInterpolated(this.channelBuffers[ch], grain.readPos) * gain;
      }
      output[ch] = sample;
    }

    this.samplesWritten++;

    for (const grain of this.grains) {
      grain.phase += 1;
      grain.readPos += pitchRatio;
      if (grain.phase >= this.grainSize) {
        grain.phase -= this.grainSize;
        // Reset back near the write head so this grain never drifts into
        // buffer regions that are stale or not yet written.
        grain.readPos = this.samplesWritten - this.grainSize;
      }
    }

    return output;
  }
}
