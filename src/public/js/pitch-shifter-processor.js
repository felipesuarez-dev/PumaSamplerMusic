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
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true;

    const channelCount = input.length;
    if (!this.shifter) {
      this.shifter = new GranularPitchShifter(channelCount);
    }

    const pitchParam = parameters.pitchRatio;
    const frameCount = input[0].length;

    for (let i = 0; i < frameCount; i++) {
      const pitchRatio = pitchParam.length > 1 ? pitchParam[i] : pitchParam[0];
      const inputSample = new Array(channelCount);
      for (let ch = 0; ch < channelCount; ch++) inputSample[ch] = input[ch][i];

      const outputSample = this.shifter.processSample(inputSample, pitchRatio);
      for (let ch = 0; ch < channelCount; ch++) {
        if (output[ch]) output[ch][i] = outputSample[ch];
      }
    }

    return true;
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
