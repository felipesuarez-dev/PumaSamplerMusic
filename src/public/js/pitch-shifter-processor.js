import { GranularPitchShifter } from './pitch-shifter-core.js';

// Real-time pitch shifter using the classic two-grain overlap-add (OLA)
// granular technique. Unlike AudioBufferSourceNode.playbackRate (which links
// pitch and speed together, the classic tape/turntable behavior), this keeps
// tempo/duration unchanged while shifting pitch — the source is always played
// at rate=1, and this node reshapes the resulting audio stream in real time.
// The DSP itself lives in pitch-shifter-core.js (see there for the algorithm
// explanation) so it can be unit-tested outside the AudioWorklet sandbox.
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitchRatio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'a-rate' }];
  }

  constructor() {
    super();
    this.shifter = null;
    // Reused input scratch: process() runs every 128 samples in the real-time
    // audio thread, so allocating a per-sample input array here was pure GC
    // pressure (the shifter's output is already a reused buffer — see
    // pitch-shifter-core.js).
    this.frameInput = null;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true;

    const channelCount = input.length;
    if (!this.shifter || this.frameInput.length !== channelCount) {
      // Recreate only if the bus width ever changes (the node is built with an
      // explicit channelCount, so this is defensive): a shorter scratch than
      // the buffers the shifter iterates would feed `undefined` into the DSP.
      this.shifter = new GranularPitchShifter(channelCount);
      this.frameInput = new Array(channelCount).fill(0);
    }

    const pitchParam = parameters.pitchRatio;
    const frameCount = input[0].length;
    const frameInput = this.frameInput;

    for (let i = 0; i < frameCount; i++) {
      const pitchRatio = pitchParam.length > 1 ? pitchParam[i] : pitchParam[0];
      for (let ch = 0; ch < channelCount; ch++) frameInput[ch] = input[ch][i];

      const outputSample = this.shifter.processSample(frameInput, pitchRatio);
      for (let ch = 0; ch < channelCount; ch++) {
        if (output[ch]) output[ch][i] = outputSample[ch];
      }
    }

    return true;
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
