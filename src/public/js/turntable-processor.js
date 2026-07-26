import { TurntableDeck } from './turntable-core.js';

// Thin AudioWorklet wrapper around TurntableDeck — the DSP itself lives in
// turntable-core.js so it can be unit tested outside the worklet sandbox
// (same split as pitch-shifter-processor.js / pitch-shifter-core.js).
//
// Unlike the pitch shifter this is a SOURCE, not an insert: it has no inputs
// and generates from a transferred slab of the track's samples.

// Position is posted back every this many quanta. 16 x 128 / 48000 = ~42.7ms,
// i.e. ~23Hz — plenty for the tonearm and the seek-on-release, and cheap enough
// that the audio thread never notices.
const POS_REPORT_QUANTA = 16;

class TurntableProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // NEGATIVE minValue is the entire point: it is what AudioBufferSourceNode's
    // playbackRate cannot deliver in any shipping engine. a-rate so a fast hand
    // movement is sampled per frame instead of once per 128-frame quantum, and
    // so the main thread can de-zipper with setTargetAtTime rather than the DSP
    // needing its own slew. A negative minValue is legal per spec (the default
    // minValue is in fact the most-negative float).
    return [{ name: 'rate', defaultValue: 0, minValue: -4, maxValue: 4, automationRate: 'a-rate' }];
  }

  constructor() {
    super();
    this.deck = null;
    this.dead = false;
    this.quantaSincePost = 0;
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (!msg) return;
    if (msg.type === 'load') {
      this.deck = new TurntableDeck({
        channels: msg.channels,
        sampleRate: msg.sampleRate || sampleRate,
        offsetSeconds: msg.offsetSeconds || 0,
      });
      if (typeof msg.startSeconds === 'number') this.deck.setPosition(msg.startSeconds);
      this.dead = false;
      return;
    }
    if (msg.type === 'seek') {
      if (this.deck) this.deck.setPosition(msg.mediaSeconds);
      return;
    }
    if (msg.type === 'free') {
      // Drop the slab AND arrange for the next process() to return false.
      // Returning true forever is what keeps a source node alive, so without
      // the flag the processor and its (up to a few hundred MB of) channel
      // arrays would never be released, even after the node is disconnected.
      this.deck = null;
      this.dead = true;
    }
  }

  process(_inputs, outputs, parameters) {
    if (this.dead) return false;
    const output = outputs[0];
    if (!output || !output.length) return true;
    if (!this.deck) return true; // armed but not loaded yet: output stays silent

    this.deck.process(output, parameters.rate);

    this.quantaSincePost++;
    if (this.quantaSincePost >= POS_REPORT_QUANTA) {
      this.quantaSincePost = 0;
      // `frame` lets the main thread age-correct this reading: it is up to a
      // full report interval stale, and it is a render-time position while the
      // user hears it outputLatency later. getVoiceTime() already does the same
      // correction for pad voices, so the two must agree.
      this.port.postMessage({ type: 'pos', mediaSeconds: this.deck.getPosition(), frame: currentFrame });
    }

    return true;
  }
}

registerProcessor('turntable-processor', TurntableProcessor);
