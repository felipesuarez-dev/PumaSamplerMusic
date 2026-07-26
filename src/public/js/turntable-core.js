// Core DSP for the turntable deck (the vinyl skin's scratch), separated from
// turntable-processor.js so it can run under node:test — same split as
// pitch-shifter-core.js / pitch-shifter-processor.js, and for the same reason
// (AudioWorkletProcessor only exists inside a real AudioWorkletGlobalScope).
//
// Naming note: "scratch" is already taken in this codebase — audio position 0
// is the reserved *scratch voice*, the Slicer/Trim preview channel. This module
// is the DJ turntable, so everything here says deck/turntable instead.
//
// Why a worklet at all, rather than AudioBufferSourceNode.playbackRate:
//   1. No browser engine implements reverse playback on a buffer source, and a
//      scratch is half reverse.
//   2. playbackRate is k-rate only, so it changes at most once per 128-frame
//      quantum (~2.7ms) — it physically cannot follow a hand sample-accurately.
//   3. There is no continuous position readout, which the tonearm and the
//      seek-on-release both need.
// A worklet AudioParam has none of those limits and may legally go negative.

// Nominal 33⅓ RPM in rad/s. Hand speed is measured against this, so one full
// turn of the disc in ~1.8s is exactly 1x — the feel is calibrated to a real
// turntable instead of to the skin's arbitrary free-spin constant.
export const RPM_33_RAD_PER_SEC = ((33 + 1 / 3) / 60) * Math.PI * 2;

// One-pole DC blocker pole. ~7.6Hz at 48kHz: inaudible at any real playback
// rate, but it keeps a near-stationary stylus from feeding a DC step into the
// master chain's compressor and soft-clip.
export const DC_BLOCK_R = 0.999;

// Rest gate. A stylus at rest is SILENT, not a held DC sample. These are
// deliberately tiny with hysteresis between them: an earlier design gated
// anything under 6% speed, which punched a hole of silence into every single
// direction change — the loudest, most characteristic moment of a scratch.
// A turnaround passes |rate| through zero for only a sample or two, so it never
// reaches MUTE_BELOW_RATE, while a genuinely parked hand does.
const MUTE_BELOW_RATE = 0.003;
const UNMUTE_ABOVE_RATE = 0.01;
// ~1.5ms time constant, so a mute reaches -60dB in ~10ms.
const GATE_TAU_SECONDS = 0.0015;

// The 4-tap kernel reads pos-1 .. pos+2, so this much room is needed at each
// end before the index clamp would start repeating samples.
const EDGE_MARGIN_SAMPLES = 2;

// Catmull-Rom (cubic Hermite with Catmull tangents, the Keys a = -1/2 form).
// Chosen over linear because a scratch sweeps the read head at arbitrary
// fractional speeds, and over other cubics because it passes exactly through
// y1 and y2 — so at t=0 it returns y1 bit-for-bit, which is what makes an
// integral-position 1x read reproduce the source sample for sample.
//
// NOT range-preserving: at t=0.5 the weights are (-1/16, 9/16, 9/16, -1/16),
// so Sum|w| = 1.25 and full-scale input can overshoot to +/-1.25 (worst case
// -1, 1, 1, -1). Callers must leave headroom for that. Measured end-to-end on
// full-scale audio through a realistically smoothed +/-2.5x scratch, the deck's
// actual output peak is ~1.06 — the anti-alias averaging is a lowpass, so it
// attenuates exactly the alternating content that provokes the 1.25 worst case.
export function catmullRom(y0, y1, y2, y3, t) {
  const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
  const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c = -0.5 * y0 + 0.5 * y2;
  return ((a * t + b) * t + c) * t + y1;
}

// NaN has no direction to preserve, so it becomes a stop; an infinity does, so
// it clamps like any other over-range value.
export function clampRate(rate, maxAbs = 4) {
  if (Number.isNaN(rate)) return 0;
  if (rate > maxAbs) return maxAbs;
  if (rate < -maxAbs) return -maxAbs;
  return rate;
}

// Applies the deck's own DC blocker to a whole array. Exported so tests can
// state "at 1x the deck is a pass-through" against the real output path rather
// than against a tolerance pulled out of the air.
export function dcBlockArray(input, r = DC_BLOCK_R) {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = x - x1 + r * y1;
    out[i] = y;
    x1 = x;
    y1 = y;
  }
  return out;
}

export class TurntableDeck {
  // channels: Array<Float32Array>, one per channel, all the same length.
  // sampleRate: the AudioContext's rate (decodeAudioData already resampled the
  //   buffer to it, so no conversion is needed here).
  // offsetSeconds: media time of channels[*][0], so a windowed slab still
  //   reports absolute media positions.
  constructor({ channels, sampleRate, offsetSeconds = 0 }) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.offsetSeconds = offsetSeconds;
    this.length = channels.length && channels[0] ? channels[0].length : 0;

    // Fractional read head, in samples, local to the slab. A plain double: it
    // stays exact for integral increments far past any real track length, and
    // must never be narrowed to Float32 or the position would visibly drift.
    this.pos = 0;

    // One gain shared by every channel (they must stay phase- and
    // amplitude-locked), one DC-blocker state pair per channel. Preallocated:
    // process() runs on the audio thread and must not allocate.
    this.gain = 0;
    this.gateOpen = false;
    this.gateCoef = 1 - Math.exp(-1 / Math.max(1, GATE_TAU_SECONDS * sampleRate));
    this.dcX1 = new Float64Array(channels.length);
    this.dcY1 = new Float64Array(channels.length);
  }

  setPosition(mediaSeconds) {
    const local = (mediaSeconds - this.offsetSeconds) * this.sampleRate;
    this.pos = Math.min(Math.max(local, 0), Math.max(0, this.length - 1));
  }

  getPosition() {
    return this.offsetSeconds + this.pos / this.sampleRate;
  }

  // True while the head sits where the 4-tap kernel would have to repeat an
  // edge sample. Deliberately true BEFORE the clamp bites, so the gate has
  // already closed by the time the read would go flat — a held edge sample is
  // exactly the DC step the gate exists to suppress.
  isAtEdge() {
    if (this.length < EDGE_MARGIN_SAMPLES * 2 + 2) return true;
    return this.pos < EDGE_MARGIN_SAMPLES || this.pos > this.length - 1 - EDGE_MARGIN_SAMPLES;
  }

  // 4-tap read at a fractional position, with every index clamped into the
  // slab so the edges degrade to a repeated sample instead of reading garbage.
  readAt(channelIndex, position) {
    const data = this.channels[channelIndex];
    const last = this.length - 1;
    const base = Math.floor(position);
    const frac = position - base;
    const i1 = base < 0 ? 0 : (base > last ? last : base);
    const i0 = i1 - 1 < 0 ? 0 : i1 - 1;
    const i2 = i1 + 1 > last ? last : i1 + 1;
    const i3 = i1 + 2 > last ? last : i1 + 2;
    return catmullRom(data[i0], data[i1], data[i2], data[i3], frac);
  }

  // Anti-aliased read. Above 1x the head decimates, folding everything above
  // the new Nyquist back into the audible band — broadband and inharmonic,
  // which is the "cheap digital scratch" sound and is clearly audible by 4x.
  // A post-node filter cannot fix it: the fold happens here, at the read.
  // Averaging ceil(|rate|) taps across the span the head traverses this frame
  // is a moving-average lowpass whose null lands on the new Nyquist, and it
  // collapses to a single plain read at |rate| <= 1 — so the 1x path, and its
  // sample-exact identity, is untouched.
  readAveraged(channelIndex, position, rate) {
    const taps = Math.max(1, Math.ceil(Math.abs(rate)));
    if (taps === 1) return this.readAt(channelIndex, position);
    const step = rate / taps;
    let sum = 0;
    for (let i = 0; i < taps; i++) sum += this.readAt(channelIndex, position + i * step);
    return sum / taps;
  }

  // Fills one render quantum. `rate` is either a number (constant across the
  // quantum) or a Float32Array of per-frame values. Returns frames written.
  process(outputs, rate) {
    if (!outputs.length || !outputs[0] || !this.length) return 0;
    const frames = outputs[0].length;
    const channelCount = Math.min(outputs.length, this.channels.length);
    const rateIsArray = typeof rate !== 'number';
    const last = this.length - 1;

    for (let i = 0; i < frames; i++) {
      // Mirrors pitch-shifter-processor's a-rate guard: the spec says an
      // unautomated AudioParam MAY hand back a length-1 array, so neither
      // length can be assumed.
      const r = rateIsArray ? (rate.length > 1 ? rate[i] : rate[0]) : rate;
      const speed = Math.abs(r);

      // Hysteresis: only a sustained rest closes the gate, and only a clear
      // movement reopens it, so a zero-crossing mid-turnaround does neither.
      if (this.gateOpen) {
        if (speed < MUTE_BELOW_RATE) this.gateOpen = false;
      } else if (speed > UNMUTE_ABOVE_RATE) {
        this.gateOpen = true;
      }
      const target = this.gateOpen && !this.isAtEdge() ? 1 : 0;
      this.gain += (target - this.gain) * this.gateCoef;

      for (let ch = 0; ch < channelCount; ch++) {
        const x = this.readAveraged(ch, this.pos, r);
        const y = x - this.dcX1[ch] + DC_BLOCK_R * this.dcY1[ch];
        this.dcX1[ch] = x;
        this.dcY1[ch] = y;
        outputs[ch][i] = y * this.gain;
      }

      // Clamp the HEAD, not just the read index: a 4x shove near the end would
      // otherwise let pos run far past the slab, and the hand would then have
      // to travel back through dead silence before anything sounded again.
      this.pos += r;
      if (this.pos < 0) this.pos = 0;
      else if (this.pos > last) this.pos = last;
    }

    return frames;
  }
}
