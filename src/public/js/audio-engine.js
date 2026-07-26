export function computeSliceTimes(start, end, bufferDuration) {
  const startTime = Math.max(0, start || 0);
  const endTime = Math.min(bufferDuration, end || bufferDuration);
  const duration = Math.max(0.01, endTime - startTime);
  return { startTime, endTime, duration };
}

// Remaps a slice's [start, end] into the mirrored range that lines up with a
// time-reversed buffer of the given duration: what used to be `duration -
// end` seconds from the end is now that many seconds from the start. Inputs
// are clamped to [0, duration] first, then the mapped result is clamped again
// and reordered so `start <= end` always holds, even if the caller passed a
// reversed or degenerate (start === end) range.
export function reverseSliceTimes(start, end, duration) {
  const dur = Math.max(0, duration || 0);
  const clamp = (v) => Math.max(0, Math.min(dur, v || 0));
  const s = clamp(start);
  const e = clamp(end);
  let newStart = clamp(dur - e);
  let newEnd = clamp(dur - s);
  if (newStart > newEnd) {
    [newStart, newEnd] = [newEnd, newStart];
  }
  return { start: newStart, end: newEnd };
}

// Pure clamp logic for the Release envelope on a one-shot's natural end.
// A one-shot is started with source.start(now, startTime, durationSec) — a
// hard stop at now + durationSec that nothing else extends — so a release
// longer than the remaining slice (after Attack has already used part of it)
// would produce a negative fade-in time. This floors the effective release
// at 0 and never lets the fade start before the slice begins.
export function computeReleaseSchedule(durationSec, attackMs, releaseMs) {
  const duration = Math.max(0, durationSec || 0);
  const attackSec = Math.max(0, (attackMs || 0) / 1000);
  const releaseSec = Math.max(0, (releaseMs || 0) / 1000);
  const releaseEffSec = Math.max(0, Math.min(releaseSec, duration - attackSec));
  const fadeStartOffset = Math.max(0, duration - releaseEffSec);
  return { fadeStartOffset, releaseEffSec };
}

// Pure clamp for the Attack ramp on a one-shot: source.start(now, startTime,
// durationSec) hard-stops the voice at now + durationSec, so an Attack ramp
// longer than the slice itself would never finish -- the audible result
// would be much quieter than `volume` (e.g. an 80ms slice with a 2000ms
// Attack only ever reaches ~4% gain). Flooring attack to the slice duration
// means the ramp always reaches `volume` by the time the voice ends. Only
// meaningful for non-loop voices; loops have no hard stop to clamp against.
export function clampAttackSeconds(attackMs, durationSec) {
  const attackSec = Math.max(0, (attackMs || 0) / 1000);
  const duration = Math.max(0, durationSec || 0);
  return Math.min(attackSec, duration);
}

// Converts a semitone offset to the frequency ratio used to drive the
// pitch-shifter worklet's grain-read speed (2 semitones = a whole tone, 12 =
// one octave). Tempo/duration are unaffected — this only changes pitch (see
// pitch-shifter-processor.js), unlike AudioBufferSourceNode.playbackRate,
// which would also speed up/slow down playback.
export function semitonesToRatio(semitones) {
  return 2 ** ((semitones || 0) / 12);
}

// Races `promise` against `signal` aborting. Used by loadAudio's in-flight
// joiners: a joiner's signal only ever cancels ITS OWN wait, never the
// underlying fetch, which keeps running and still populates the cache for
// whoever asks next. That split is what lets a joiner's Cancel button feel
// instant without throwing away a download the app started on purpose.
export function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

export function createAudioEngine() {
  let audioContext = null;
  const buffers = new Map(); // videoId -> AudioBuffer
  const reversedBuffers = new Map(); // videoId -> reversed AudioBuffer (lazy, cached alongside `buffers`)
  // videoId -> { promise, listeners: Set<{onProgress, onPhase}>, lastFraction }
  const inflight = new Map();
  const activeSources = new Map(); // position -> { sourceNode, gainNode, videoId, startTime, endTime }

  let masterChain = null;
  let workletReady = null;
  let deckWorkletReady = null;
  let fallbackWarned = false;

  // Turntable deck (the vinyl skin's scratch). Named deck, not scratch: audio
  // position 0 is already "the scratch voice", the Slicer/Trim preview channel.
  // { node, gain, rateParam, videoId, lastPos, lastFrame, lastRate, ... }
  let deck = null;
  let armToken = 0;

  let desiredMasterVolume = 1;
  let desiredDelayTime = 0.25;
  let desiredDelayFeedback = 0;
  // Sampler-wide (per-session) controls: a target BPM that time-stretches every
  // pad that carries a source `bpm` (pitch-neutral, like STRETCH), and a global
  // tune offset in semitones added on top of each pad's pitch. 0 BPM = "no
  // global stretch".
  let desiredMasterBpm = 0;
  let desiredMasterTune = 0;

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  async function init() {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    return audioContext;
  }

  function ensureWorklet(ctx) {
    if (!ctx.audioWorklet) return Promise.resolve(false);
    if (!workletReady) {
      workletReady = ctx.audioWorklet.addModule('/js/pitch-shifter-processor.js')
        .then(() => true)
        .catch((err) => {
          console.warn('AudioWorklet unavailable, falling back to playbackRate pitch:', err);
          return false;
        });
    }
    return workletReady;
  }

  // Mirrors ensureWorklet's posture (one cached promise, warn-and-return-false,
  // never throws into the caller) but needs its OWN promise and its own
  // addModule call -- workletReady is specific to the pitch module. Both resolve
  // into the same AudioWorkletGlobalScope; the two registerProcessor names don't
  // collide.
  //
  // There is deliberately no degraded fallback. Unlike pitch, where
  // playbackRate is a usable if tempo-coupled approximation, scratching needs a
  // negative rate at sample accuracy, which is exactly what a buffer source
  // won't do -- so without the worklet the feature is simply unavailable.
  function ensureDeckWorklet(ctx) {
    if (!ctx.audioWorklet) return Promise.resolve(false);
    if (!deckWorkletReady) {
      deckWorkletReady = ctx.audioWorklet.addModule('/js/turntable-processor.js')
        .then(() => true)
        .catch((err) => {
          console.warn('AudioWorklet unavailable, turntable scratch disabled:', err);
          return false;
        });
    }
    return deckWorkletReady;
  }

  function generateImpulseResponse(ctx, sampleRate, lengthSeconds, decaySeconds) {
    const length = Math.pow(2, Math.ceil(Math.log2(sampleRate * lengthSeconds)));
    const buffer = ctx.createBuffer(2, length, sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const noise = Math.random() * 2 - 1;
        data[i] = noise * Math.exp(-t / decaySeconds);
      }
    }

    // Normalize to peak amplitude ~0.99 to avoid cross-browser gain differences.
    let peak = 0;
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }
    if (peak > 0) {
      const scale = 0.99 / peak;
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) {
          data[i] *= scale;
        }
      }
    }

    return buffer;
  }

  function makeSoftClipCurve(amount = 0.7) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + amount * 4));
    }
    return curve;
  }

  // Per-PAD Drive curve. amount is 0..100. Cross-fades the identity line with a
  // tanh-shaped curve by t=amount/100, so at 0 the curve is bit-transparent
  // (curve[i] === x) — an untouched Drive knob never colors the sound.
  function makeDistortionCurve(amount) {
    const t = Math.max(0, Math.min(100, amount || 0)) / 100;
    const samples = 1024;
    const curve = new Float32Array(samples);
    const pregain = 1 + t * 9;
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1)) * 2 - 1;
      curve[i] = (1 - t) * x + t * Math.tanh(x * pregain);
    }
    return curve;
  }

  function ensureMasterChain(ctx) {
    if (masterChain) return masterChain;

    // Solo lo que es genuinamente compartido vive acá: el reverb y el delay
    // son buses únicos (uno por app, no uno por pad, sería un desperdicio de
    // CPU), y el volumen/compresor/soft-clip son la etapa final de salida.
    // El filtro, el pitch y cuánto manda cada pad a estos buses son por-voz
    // (ver play()) — así es como funciona un sampler tipo AKAI MPC: cada pad
    // tiene su propio tono/filtro, pero comparte el reverb/delay del equipo.
    const convolver = ctx.createConvolver();
    convolver.buffer = generateImpulseResponse(ctx, ctx.sampleRate, 1.5, 0.6);

    const delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.25;

    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0;

    const delayWet = ctx.createGain();
    delayWet.gain.value = 1;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;

    // Limiter suave: protege de clipping con polifonía (varios pads en loop
    // más reverb/delay pueden sumar bastante señal) sin comerse el carácter
    // de los efectos como lo harían los defaults agresivos del navegador
    // (threshold -24dB, ratio 12:1).
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    // El compresor no tiene lookahead, así que transitorios más rápidos que
    // su attack igual pueden pasar por encima de 0dBFS — este soft-clip es
    // la red de seguridad real contra clipping digital audible, sin colorear
    // la señal en niveles normales.
    const softClip = ctx.createWaveShaper();
    softClip.curve = makeSoftClipCurve();
    softClip.oversample = '2x';

    // Routing del bus compartido
    convolver.connect(masterGain);

    delayNode.connect(delayWet);
    delayWet.connect(masterGain);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);

    masterGain.connect(compressor);
    compressor.connect(softClip);
    softClip.connect(ctx.destination);

    // Read-only analysis tap on the post-limiter signal (what the user hears),
    // for the central visualizer skins. An AnalyserNode is a pure sink -- it
    // does not need to connect onward, and tapping softClip additively leaves
    // the audible voice routing untouched.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    softClip.connect(analyser);

    masterChain = {
      ctx,
      convolver,
      delayNode,
      delayFeedback,
      delayWet,
      masterGain,
      compressor,
      softClip,
      analyser,
    };

    // Apply any values that were set before the chain existed.
    applyMasterValues();

    return masterChain;
  }

  function applyMasterValues() {
    if (!masterChain) return;
    masterChain.masterGain.gain.value = desiredMasterVolume;
    masterChain.delayNode.delayTime.value = desiredDelayTime;
    masterChain.delayFeedback.gain.value = desiredDelayFeedback;
  }

  function getMasterChain() {
    return masterChain;
  }

  function setMasterVolume(value) {
    desiredMasterVolume = value;
    if (masterChain) masterChain.masterGain.gain.value = value;
  }

  function setMasterDelay({ time, feedback }) {
    if (typeof time === 'number') {
      desiredDelayTime = Math.max(0.05, Math.min(1.0, time));
      if (masterChain) masterChain.delayNode.delayTime.value = desiredDelayTime;
    }
    if (typeof feedback === 'number') {
      desiredDelayFeedback = Math.max(0, Math.min(0.9, feedback));
      if (masterChain) masterChain.delayFeedback.gain.value = desiredDelayFeedback;
    }
  }

  // onProgress(fraction 0..1) is optional and only reports the DOWNLOAD phase
  // (the only phase with measurable progress -- decodeAudioData is atomic).
  // onPhase(phase) is optional and reports 'fetch' (right before the network
  // request starts) and 'decode' (right before decodeAudioData), so a caller
  // can show a state-aware caption instead of one generic label for the whole
  // call. A cache hit returns instantly without reporting either. signal is an
  // optional AbortSignal so a caller (the slicer's load overlay) can cancel
  // its own wait.
  //
  // Concurrent callers for the SAME videoId never start a second fetch. The
  // first caller for a cold id becomes its OWNER: only the owner's `signal`
  // reaches fetch(), and only the owner drives readWithProgress/decodeAudioData.
  // Every later caller for that id JOINS the same in-flight request instead --
  // its {onProgress, onPhase} is added to the owner's listener set (replaying
  // the owner's lastFraction immediately, so a late joiner's progress bar
  // doesn't appear to jump from 0 to wherever the download already is), and if
  // the joiner passed its own signal, its wait races that signal via
  // raceAbort() rather than touching the owner's fetch. This inverts an
  // assumption worth stating explicitly: a prefetch is the OWNER of a request
  // with no signal at all. If a joining slicer could hard-abort someone else's
  // in-flight fetch, cancelling the slicer would throw away work the app
  // started on purpose, and the next open would just re-download from
  // scratch. Decoupling "abort my wait" from "cancel the transfer" is what
  // makes Cancel feel instant AND keeps the download landing in the cache.
  async function loadAudio(videoId, url, onProgress, signal, onPhase) {
    if (buffers.has(videoId)) {
      return buffers.get(videoId);
    }

    const existing = inflight.get(videoId);
    if (existing) {
      const listener = { onProgress, onPhase };
      existing.listeners.add(listener);
      // Replay the owner's progress AND its current phase, so a joiner that
      // arrives mid-download lands on the caption the transfer is actually in
      // rather than sitting on the opening one. Without the phase replay, the
      // flagship path this feature creates -- hover a scissors button (the
      // prefetch owns the request), then click it once decoding has already
      // started -- would silently skip the decode caption entirely.
      if (onProgress) onProgress(existing.lastFraction);
      if (onPhase && existing.phase) onPhase(existing.phase);
      if (!signal) return existing.promise;
      // Drop this joiner's callbacks once it abandons its own wait, so a
      // cancelled slicer stops driving an overlay it no longer owns while the
      // shared download keeps running for everyone else. Handle the
      // already-aborted signal inline: addEventListener never replays an abort
      // that fired before it was attached, so without this branch an
      // abandoned joiner would keep driving the UI -- exactly what this is
      // here to prevent.
      if (signal.aborted) existing.listeners.delete(listener);
      else signal.addEventListener('abort', () => existing.listeners.delete(listener), { once: true });
      return raceAbort(existing.promise, signal);
    }

    const entry = {
      promise: null,
      listeners: new Set([{ onProgress, onPhase }]),
      lastFraction: 0,
      phase: null,
      stale: false,
    };
    entry.promise = (async () => {
      // `finally` (not a catch) so a rejected fetch can never poison this id
      // forever -- the next caller for the same videoId must get a fresh
      // attempt, not a permanently-broken cache entry.
      // Records the phase on the entry as well as broadcasting it, so a later
      // joiner can be caught up (see the join branch above).
      const emitPhase = (phase) => {
        entry.phase = phase;
        for (const listener of entry.listeners) listener.onPhase?.(phase);
      };
      try {
        const ctx = await init();
        emitPhase('fetch');
        const response = await fetch(url, signal ? { signal } : undefined);
        if (!response.ok) {
          throw new Error(`Failed to load audio: ${response.status}`);
        }
        const arrayBuffer = await readWithProgress(response, (f) => {
          entry.lastFraction = f;
          for (const listener of entry.listeners) listener.onProgress?.(f);
        });
        emitPhase('decode');
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        // Skip the cache write if unload() ran while this was in flight (the
        // user deleted the video mid-download). Whoever awaited still gets
        // their buffer -- they asked for it -- but caching it here would
        // resurrect a deleted video: isLoaded() would report true for media
        // that no longer exists, and the memory would never be reclaimed.
        if (!entry.stale) buffers.set(videoId, audioBuffer);
        return audioBuffer;
      } finally {
        inflight.delete(videoId);
      }
    })();
    inflight.set(videoId, entry);
    return entry.promise;
  }

  // Streams the response body so download progress is measurable against
  // Content-Length. Falls back to response.arrayBuffer() (indeterminate) when
  // the body isn't readable or the length is unknown -- same decoded result
  // either way, so existing callers that pass no onProgress are unaffected.
  async function readWithProgress(response, onProgress) {
    const total = Number(response.headers.get('Content-Length')) || 0;
    if (!onProgress || !total || !response.body || !response.body.getReader) {
      return response.arrayBuffer();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(1, received / total));
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged.buffer;
  }

  // Reverse playback needs its own AudioBuffer (AudioBufferSourceNode has no
  // native "play backwards" option) — built lazily on first use per video and
  // cached so repeatedly triggering a Reverse pad doesn't re-copy/reverse the
  // whole buffer every time. Cleared alongside the forward buffer in unload().
  function getReversedBuffer(videoId) {
    if (reversedBuffers.has(videoId)) return reversedBuffers.get(videoId);
    const audioBuffer = buffers.get(videoId);
    if (!audioBuffer || !audioContext) return null;

    const reversed = audioContext.createBuffer(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate,
    );
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      const source = audioBuffer.getChannelData(channel).slice();
      source.reverse();
      reversed.getChannelData(channel).set(source);
    }

    reversedBuffers.set(videoId, reversed);
    return reversed;
  }

  // Single source of truth for a voice's playbackRate + pitch-shifter ratio,
  // folding in BOTH the per-pad pitch/speed/stretch AND the sampler-wide global
  // BPM stretch + tune offset. `stretchTotal` = per-pad STRETCH × global BPM
  // factor; both are pitch-neutral (the worklet ratio divides them back out when
  // P.SHIFT is on). `effTuneRatio` folds the global tune into the pad's pitch.
  function computeVoiceRates({ pitch, stretchOn, speed, bpm, pitchShiftOn }) {
    const effTuneRatio = semitonesToRatio((pitch || 0) + desiredMasterTune);
    const stretchPad = stretchOn ? Math.max(0.25, Math.min(4, speed / 100)) : 1;
    const bpmFactor = (bpm > 0 && desiredMasterBpm > 0) ? desiredMasterBpm / bpm : 1;
    const stretchTotal = Math.max(0.25, Math.min(4, stretchPad * bpmFactor));
    return {
      // Worklet path: rate carries the (pitch-neutral) stretch, the shifter
      // ratio carries the tune and divides the stretch back out.
      playbackRate: stretchTotal * (pitchShiftOn ? 1 : effTuneRatio),
      pitchRatio: (pitchShiftOn ? effTuneRatio : 1) / stretchTotal,
      // Fallback (no pitch-shifter): tempo and pitch are coupled.
      coupledRate: stretchTotal * effTuneRatio,
    };
  }

  // Ramps a live voice's rate/pitch to its current merged state (incl. the
  // global BPM/tune). Shared by updateVoiceFx and the master BPM/tune setters.
  const RATE_RAMP = 0.02;
  function rampVoiceRates(active, now) {
    const rates = computeVoiceRates(active);
    if (active.pitchShifterNode) {
      active.source.playbackRate.setTargetAtTime(rates.playbackRate, now, RATE_RAMP);
      active.pitchShifterNode.parameters.get('pitchRatio').setTargetAtTime(rates.pitchRatio, now, RATE_RAMP);
    } else {
      active.source.playbackRate.setTargetAtTime(rates.coupledRate, now, RATE_RAMP);
    }
  }

  // Re-applies the global BPM/tune to every sounding voice so a knob move is
  // heard immediately on active pads (not only on the next trigger).
  function reapplyMasterToVoices() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    for (const active of activeSources.values()) {
      rampVoiceRates(active, now);
    }
  }

  function setMasterBpm(value) {
    desiredMasterBpm = Math.max(0, Number(value) || 0);
    reapplyMasterToVoices();
  }

  function setMasterTune(value) {
    desiredMasterTune = Math.max(-24, Math.min(24, Number(value) || 0));
    reapplyMasterToVoices();
  }

  async function play(position, {
    videoId, start, end, volume = 1, loop = false, triggerMode = 'oneshot',
    pitch = 0, cutoff = 20000, resonance = 0.1, reverbSend = 0, delaySend = 0,
    pitchShiftOn = true, stretchOn = false, speed = 100, pan = 0, drive = 0,
    attack = 0, release = 0, reverse = false, bpm = 0,
  }) {
    const ctx = await init();
    const workletOk = await ensureWorklet(ctx);
    if (!workletOk && !fallbackWarned) {
      fallbackWarned = true;
      emit('audioworkletfallback', {});
    }
    const chain = ensureMasterChain(ctx);
    const audioBuffer = buffers.get(videoId);
    if (!audioBuffer) return false;

    // Reverse only swaps which buffer/slice we read from — everything
    // downstream (filter, drive, pan, sends, attack/release envelope) is
    // unaffected, so it's applied here, before computeSliceTimes, rather than
    // threaded through the rest of the voice chain.
    let playbackBuffer = audioBuffer;
    let sliceStart = start;
    let sliceEnd = end;
    if (reverse) {
      const reversedBuffer = getReversedBuffer(videoId);
      if (reversedBuffer) {
        playbackBuffer = reversedBuffer;
        const remapped = reverseSliceTimes(start, end, audioBuffer.duration);
        sliceStart = remapped.start;
        sliceEnd = remapped.end;
      }
    }

    const { startTime, endTime, duration } = computeSliceTimes(sliceStart, sliceEnd, playbackBuffer.duration);

    // Stop any existing playback on this pad
    stop(position);

    // One-shot voices don't layer with each other: any new trigger cuts
    // whatever one-shots are currently playing. Loops are left alone so
    // they can keep sounding as a background layer. Position 0 is the
    // reserved scratch voice used for Auto-Slicer slice preview (see
    // slicer.js) -- previews are transient and must not kill a real pad,
    // and triggering a real pad must not kill an in-progress preview
    // either, so the cross-cut is skipped entirely whenever either side
    // is position 0.
    if (position !== 0) {
      activeSources.forEach((active, pos) => {
        if (pos !== position && pos !== 0 && !active.source.loop) {
          stop(pos);
        }
      });
    }

    const source = ctx.createBufferSource();
    source.buffer = playbackBuffer;
    source.loop = loop;
    source.loopStart = startTime;
    source.loopEnd = endTime;
    // Normally tempo is never touched by Tune — pitch is handled downstream
    // by pitchNode instead of playbackRate. Only when the AudioWorklet is
    // unavailable (non-secure context) does source.playbackRate get set
    // below, as a degraded fallback that also changes speed.

    const gain = ctx.createGain();
    gain.gain.value = volume;

    // Cadena por-voz: cada pad tiene su propio pitch-shift, filtro, y sus
    // propios envíos a los buses compartidos de reverb/delay (ver
    // ensureMasterChain).
    // Net rule covering all P.SHIFT/STRETCH combinations: playbackRate carries
    // the STRETCH-driven speed change plus (when P.SHIFT is off) the classic
    // tune-coupled speed change; the worklet ratio carries the P.SHIFT-driven
    // pitch change and compensates STRETCH's pitch side-effect so time-stretch
    // stays pitch-neutral. With defaults (P.SHIFT on, STRETCH off) this
    // degenerates to today's behavior: playbackRate 1, worklet ratio tuneRatio.
    const rates = computeVoiceRates({ pitch, stretchOn, speed, bpm, pitchShiftOn });

    const channelCount = audioBuffer.numberOfChannels;
    let pitchNode = null;
    if (workletOk) {
      pitchNode = new AudioWorkletNode(ctx, 'pitch-shifter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount,
        channelCountMode: 'explicit',
        outputChannelCount: [channelCount],
      });
      source.playbackRate.value = rates.playbackRate;
      pitchNode.parameters.get('pitchRatio').value = rates.pitchRatio;
    } else {
      source.playbackRate.value = rates.coupledRate;
    }

    const filterNode = ctx.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = Math.max(20, Math.min(20000, cutoff));
    filterNode.Q.value = Math.max(0.1, Math.min(20, resonance));

    // Drive (harmonic saturation) then Pan, in series after the filter and
    // before the fan-out to dry/reverb/delay — so the sends hear the driven,
    // panned signal (standard post-pan send routing).
    const driveNode = ctx.createWaveShaper();
    driveNode.curve = makeDistortionCurve(drive);
    driveNode.oversample = '2x';

    const panNode = ctx.createStereoPanner();
    panNode.pan.value = Math.max(-1, Math.min(1, pan));

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;

    const reverbSendGain = ctx.createGain();
    reverbSendGain.gain.value = Math.max(0, Math.min(1, reverbSend));

    const delaySendGain = ctx.createGain();
    delaySendGain.gain.value = Math.max(0, Math.min(1, delaySend));

    source.connect(gain);
    if (pitchNode) {
      gain.connect(pitchNode);
      pitchNode.connect(filterNode);
    } else {
      gain.connect(filterNode);
    }
    filterNode.connect(driveNode);
    driveNode.connect(panNode);
    panNode.connect(dryGain);
    dryGain.connect(chain.masterGain);
    panNode.connect(reverbSendGain);
    reverbSendGain.connect(chain.convolver);
    panNode.connect(delaySendGain);
    delaySendGain.connect(chain.delayNode);

    const now = ctx.currentTime;
    // Non-loop voices hard-stop at now + duration (source.start's duration
    // arg, below), so Attack is clamped to the slice length -- otherwise an
    // 80ms slice with a 2000ms Attack would only ever ramp to ~4% gain
    // before being cut off. Loops have no hard stop, so their Attack is left
    // unclamped.
    const attackSec = loop
      ? Math.max(0, (attack || 0) / 1000)
      : clampAttackSeconds(attack, duration);
    const releaseSec = Math.max(0, (release || 0) / 1000);

    // Attack: ramp up from silence instead of jumping straight to `volume`.
    // With attack <= 0 the gain node keeps the `gain.gain.value = volume`
    // assignment made right after it was created — today's exact behavior.
    if (attackSec > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + attackSec);
    }

    // Release on a one-shot's natural end: the hard stop at now + duration
    // (from source.start's duration arg, below) would otherwise cut the
    // sample with a click. computeReleaseSchedule floors the effective
    // release so it never eats into the Attack ramp or starts before the
    // slice does (e.g. an 80ms slice with a 2s release). fadeStartOffset is
    // always <= duration and >= attackSec, so this ramp starts after the
    // attack ramp has already reached `volume` — no automation conflict.
    // attackSec is already clamped above, so it's fed in (converted back to
    // ms) instead of the raw `attack` param.
    let releaseEffSec = 0;
    if (!loop) {
      const schedule = computeReleaseSchedule(duration, attackSec * 1000, release);
      releaseEffSec = schedule.releaseEffSec;
      if (releaseEffSec > 0) {
        const fadeStart = Math.max(now, now + schedule.fadeStartOffset);
        gain.gain.setValueAtTime(volume, fadeStart);
        gain.gain.linearRampToValueAtTime(0, fadeStart + releaseEffSec);
      }
    }

    if (loop) {
      source.start(now, startTime);
    } else {
      source.start(now, startTime, duration);
    }

    const sourceRef = {
      source, gain, pitchShifterNode: pitchNode, filterNode, driveNode, panNode, dryGain, reverbSendGain, delaySendGain,
      videoId, startTime, endTime, position, duration,
      pitch, pitchShiftOn, stretchOn, speed, bpm,
      releaseSec,
      // AudioContext time this voice started, so getVoiceTime() can map elapsed
      // context time back to a buffer position for an accurate playhead.
      startedAtCtx: now,
      // Absolute AudioContext time this voice will hard-stop on its own
      // (source.start's duration arg, below) -- Infinity for loops, which
      // have no such cutoff. stop()'s release fade must never schedule
      // past this: source.stop() does NOT push an already-scheduled hard
      // stop back, so a longer fade would just get silently cut off
      // mid-ramp (see stop()).
      hardStopTime: loop ? Infinity : now + duration,
    };
    activeSources.set(position, sourceRef);
    emit('audiosourcestart', { position, videoId });

    source.onended = () => {
      if (activeSources.get(position) === sourceRef) {
        activeSources.delete(position);
        emit('audiosourcestop', { position, videoId });
      }
    };

    return true;
  }

  function stop(position) {
    const active = activeSources.get(position);
    if (!active) return;

    const releaseSec = active.releaseSec || 0;

    // A stop()-triggered release fade can never outlive a voice's own
    // already-scheduled hard stop (non-loop voices are started with
    // source.start(now, startTime, duration), below in play()) --
    // source.stop() does NOT push that earlier cutoff back, so scheduling a
    // longer fade would just have the source die at the original time,
    // mid-ramp (an audible click on gate release / retrigger). Clamp to
    // whatever time is actually left before hardStopTime (Infinity for
    // loops, so they're unaffected).
    const now = audioContext ? audioContext.currentTime : 0;
    const hardStopTime = active.hardStopTime ?? Infinity;
    const releaseEffSec = releaseSec > 0 && audioContext
      ? Math.min(releaseSec, Math.max(0, hardStopTime - now))
      : 0;

    if (releaseEffSec > 0) {
      // Release turns the hard stop into a fade-out. The voice is removed
      // from activeSources right away — not after the fade — so a retrigger
      // of this same pad, a manual stop() called again mid-fade, or the
      // cross-one-shot cut logic in play() all see the pad as free instead
      // of trying to stop this (already fading) source a second time. Node
      // disconnects and the audiosourcestop emit are deferred to
      // source.onended, once the fade actually completes.
      activeSources.delete(position);

      const { gain, source } = active;
      // Capture the live gain value BEFORE cancelScheduledValues clears any
      // in-flight automation (e.g. an Attack ramp still in progress) --
      // reading gain.value after cancelling would already reflect the
      // cancellation and could return a stale/incorrect starting point.
      const currentValue = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(currentValue, now);
      gain.gain.linearRampToValueAtTime(0, now + releaseEffSec);

      source.onended = () => {
        [active.source, active.gain, active.pitchShifterNode, active.filterNode, active.driveNode, active.panNode, active.dryGain, active.reverbSendGain, active.delaySendGain]
          .filter(Boolean)
          .forEach((node) => {
            try {
              node.disconnect();
            } catch {
              // already disconnected
            }
          });
        emit('audiosourcestop', { position, videoId: active.videoId });
      };

      try {
        source.stop(now + releaseEffSec);
      } catch {
        // Already stopped/scheduled
      }
      return;
    }

    try {
      active.source.stop();
    } catch {
      // Already stopped
    }
    [active.source, active.gain, active.pitchShifterNode, active.filterNode, active.driveNode, active.panNode, active.dryGain, active.reverbSendGain, active.delaySendGain]
      .filter(Boolean)
      .forEach((node) => {
        try {
          node.disconnect();
        } catch {
          // already disconnected
        }
      });
    activeSources.delete(position);
    emit('audiosourcestop', { position, videoId: active.videoId });
  }

  function stopAll() {
    for (const position of [...activeSources.keys()]) {
      stop(position);
    }
  }

  // Applies FX changes to a pad that's currently sounding, in real time —
  // used when the user tweaks a knob while the pad is playing/looping,
  // rather than only taking effect on the next trigger. No-ops if the pad
  // isn't currently active (its stored values still apply next time it's
  // triggered via play()). setTargetAtTime ramps smoothly to avoid clicks.
  function updateVoiceFx(position, { pitch, cutoff, resonance, reverbSend, delaySend, pitchShiftOn, stretchOn, speed, pan, drive, release } = {}) {
    const active = activeSources.get(position);
    if (!active || !audioContext) return;

    const now = audioContext.currentTime;
    const RAMP = 0.02;

    // Pitch/P.SHIFT/STRETCH/Speed are coupled (see play()'s formula) — any
    // change to one requires recomputing BOTH targets from the merged state,
    // then ramping BOTH AudioParams together so "warp" (live ramping while a
    // loop plays) stays consistent instead of drifting the two apart.
    if (pitch !== undefined || pitchShiftOn !== undefined || stretchOn !== undefined || speed !== undefined) {
      if (pitch !== undefined) active.pitch = pitch;
      if (pitchShiftOn !== undefined) active.pitchShiftOn = pitchShiftOn;
      if (stretchOn !== undefined) active.stretchOn = stretchOn;
      if (speed !== undefined) active.speed = speed;
      rampVoiceRates(active, now);
    }
    if (cutoff !== undefined) {
      active.filterNode.frequency.setTargetAtTime(Math.max(20, Math.min(20000, cutoff)), now, RAMP);
    }
    if (resonance !== undefined) {
      active.filterNode.Q.setTargetAtTime(Math.max(0.1, Math.min(20, resonance)), now, RAMP);
    }
    if (reverbSend !== undefined) {
      active.reverbSendGain.gain.setTargetAtTime(Math.max(0, Math.min(1, reverbSend)), now, RAMP);
    }
    if (delaySend !== undefined) {
      active.delaySendGain.gain.setTargetAtTime(Math.max(0, Math.min(1, delaySend)), now, RAMP);
    }
    if (pan !== undefined) {
      active.panNode.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, RAMP);
    }
    // Release has no AudioParam to ramp live (it only takes effect the next
    // time stop() is called on this voice, e.g. gate-off) -- just update the
    // stored value stop() reads at that time. Attack and Reverse are left
    // out: both are baked into the voice at trigger time (the Attack ramp
    // already ran; Reverse picked the source buffer) and physically can't be
    // retroactively applied to an in-flight voice.
    if (release !== undefined) {
      active.releaseSec = Math.max(0, release) / 1000;
    }
    // WaveShaper.curve isn't an AudioParam (can't ramp), so rebuild it. Throttle
    // to ~25 Hz: a knob drag fires input dozens of times/sec, and reallocating
    // a 1024-sample curve each tick would churn GC and risk zipper clicks.
    if (drive !== undefined) {
      const ms = performance.now();
      if (ms - (active.lastDriveUpdateMs || 0) > 40) {
        active.driveNode.curve = makeDistortionCurve(drive);
        active.lastDriveUpdateMs = ms;
      }
    }
  }

  // Live-updates a currently-playing voice's gain (e.g. slicer preview volume
  // slider). Deliberately separate from updateVoiceFx, which never touches
  // volume. A voice that's mid-release-fade is already removed from
  // activeSources (see stop()), so the lookup below naturally skips it
  // instead of fighting the fade-out ramp.
  function setVoiceVolume(position, volume) {
    const active = activeSources.get(position);
    if (!active || !audioContext) return;
    const clamped = Math.max(0, Math.min(2, volume));
    active.gain.gain.setTargetAtTime(clamped, audioContext.currentTime, 0.01);
  }

  // ---- turntable deck -------------------------------------------------------

  // A slab beyond this never gets transferred whole; a window around the grab
  // point is sent instead. Budgeted in BYTES rather than seconds on purpose: a
  // seconds threshold silently means wildly different memory for mono vs stereo
  // and 44.1k vs 48k. 128MB is ~5.8 min stereo at 48k, ~11.6 min mono. The
  // still-cached original sits alongside it, and the copy below briefly doubles
  // the peak, so a seconds-based 15-minute cap would have meant ~330MB of slab
  // plus ~330MB of original plus the transient -- near a gigabyte for one track.
  const DECK_MAX_BYTES = 128 * 1024 * 1024;
  const DECK_WINDOW_SECONDS = 120;
  // Full-scale audio through a realistically smoothed scratch peaks at ~1.06
  // (see turntable-core.js), and this lands on the master bus alongside running
  // pad voices, ahead of a compressor at -10dB and a tanh soft-clip that is
  // already saturating at low level. 0.75 keeps the deck from pumping the pads
  // harder than a DJ mixer would.
  const DECK_GAIN = 0.75;
  const DECK_RAMP_SECONDS = 0.015;

  function isDeckArmed() {
    return Boolean(deck);
  }

  // Copies one channel's samples for transfer to the worklet.
  //
  // NEVER transfer getChannelData(ch).buffer: that array is a live view onto the
  // AudioBuffer's internal data, and per spec a detached ArrayBuffer makes
  // "acquire the contents" hand back a ZERO-LENGTH channel. Every pad still
  // holding that videoId would then play silence -- with no exception and
  // nothing in the console, which is what makes it undebuggable. copyFromChannel
  // is the spec-recommended read and removes any chance of someone later
  // deleting a defensive .slice().
  function copyDeckChannels(buffer, startFrame, frameCount) {
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const copy = new Float32Array(frameCount);
      buffer.copyFromChannel(copy, ch, startFrame);
      channels.push(copy);
    }
    return channels;
  }

  // Arms the deck on `videoId`, loading and decoding the track first if it isn't
  // cached yet. Returns false when the worklet is unavailable or the load fails,
  // so the caller can leave the disc decorative instead of half-working.
  // Live rate of the deck, so callers can tell "the deck is the thing currently
  // playing the centre track" apart from "nothing is playing". Null when the
  // deck isn't armed at all, which is a different answer from rate 0.
  function getDeckRate() {
    return deck ? deck.lastRate : null;
  }

  // startRate matters on a RE-arm: a fresh AudioWorkletNode's rate param starts
  // at its declared default of 0, and the skin only pushes a rate while a
  // gesture or its coast is live. Arming after that has finished -- a windowed
  // slab re-arming during resumed playback, or a slow decode landing after the
  // user already let go -- would otherwise leave the new node silently parked.
  async function armDeck(videoId, url, startSeconds = 0, startRate = 0) {
    if (!videoId) return false;
    // Arming is async (it may have to download and decode), so a second call --
    // switching skins or tracks quickly -- can overtake the first. The token
    // lets a stale arm bail instead of clobbering the newer deck.
    const token = ++armToken;
    const buffer = buffers.get(videoId) || await loadAudio(videoId, url);
    const ctx = await init();
    if (!await ensureDeckWorklet(ctx)) return false;
    if (token !== armToken) return false;

    // ensureMasterChain is otherwise only ever called from play(), so the chain
    // is still null until the first pad trigger -- going straight to the vinyl
    // skin would throw on chain.masterGain without this.
    const chain = ensureMasterChain(ctx);

    if (deck) disarmDeck();

    const rate = buffer.sampleRate;
    const bytesPerFrame = buffer.numberOfChannels * 4;
    const maxFrames = Math.floor(DECK_MAX_BYTES / bytesPerFrame);
    let startFrame = 0;
    let frameCount = buffer.length;
    if (frameCount > maxFrames) {
      // Window around the grab point. A gesture clamped at 4x for a generous
      // 10s travels at most 40s, so the hand cannot reach a +/-120s edge; only
      // post-release 1x playback can, and it re-arms while still far from it.
      const windowFrames = Math.min(maxFrames, Math.floor(DECK_WINDOW_SECONDS * rate) * 2);
      startFrame = Math.max(0, Math.min(buffer.length - windowFrames,
        Math.floor(startSeconds * rate) - Math.floor(windowFrames / 2)));
      frameCount = windowFrames;
    }

    let channels;
    try {
      channels = copyDeckChannels(buffer, startFrame, frameCount);
    } catch (err) {
      // A very large Float32Array can fail to allocate under memory pressure
      // (reliably so on iOS). Better to report the deck unavailable than to
      // take the tab down.
      console.warn('Turntable deck slab allocation failed:', err);
      return false;
    }

    const node = new AudioWorkletNode(ctx, 'turntable-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [buffer.numberOfChannels],
    });
    const gain = ctx.createGain();
    // Ramped rather than switched: a bare connect/disconnect at full gain is an
    // audible click at both ends.
    gain.gain.value = 0;
    // A source, not an insert: no per-voice filter/drive/pan/sends. It joins at
    // masterGain so it runs through the same compressor and soft-clip the pads
    // do and, crucially, reaches the post-limiter analyser -- which is what lets
    // the vinyl skin's loudness bloom react to the scratch itself.
    node.connect(gain);
    gain.connect(chain.masterGain);

    deck = {
      node,
      gain,
      // Cached: setDeckRate runs on every pointer move, and parameters.get() is
      // a map lookup we'd rather not repeat at that rate.
      rateParam: node.parameters.get('rate'),
      videoId,
      channelCount: buffer.numberOfChannels,
      offsetSeconds: startFrame / rate,
      windowEndSeconds: (startFrame + frameCount) / rate,
      fullDuration: buffer.duration,
      windowed: frameCount < buffer.length,
      lastPos: startSeconds,
      lastFrame: null,
      lastRate: startRate,
    };

    node.port.onmessage = (e) => {
      if (!deck || !e.data || e.data.type !== 'pos') return;
      deck.lastPos = e.data.mediaSeconds;
      deck.lastFrame = e.data.frame;
    };

    node.port.postMessage(
      {
        type: 'load',
        channels,
        sampleRate: rate,
        offsetSeconds: deck.offsetSeconds,
        startSeconds,
      },
      channels.map((c) => c.buffer),
    );

    if (startRate !== 0 && deck.rateParam) deck.rateParam.setValueAtTime(startRate, ctx.currentTime);
    gain.gain.setTargetAtTime(DECK_GAIN, ctx.currentTime, DECK_RAMP_SECONDS);
    return true;
  }

  // De-zippered per pointer move. Chaining setTargetAtTime is correct here (each
  // one starts from the param's current value, so the result is a continuous
  // chain of one-pole segments) and matches rampVoiceRates/updateVoiceFx.
  //
  // The snap matters: setTargetAtTime is asymptotic, so "back to 1x" would sit
  // at ~0.998 forever -- a permanent 0.2% detune and ~0.4s of drift over a
  // 3-minute track. When the caller says it has settled, land exactly.
  function setDeckRate(rate, settled = false) {
    if (!deck || !audioContext) return;
    const param = deck.rateParam;
    if (!param) return;
    const now = audioContext.currentTime;
    if (settled) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(rate, now);
    } else {
      // Skip a move too small to hear, so a resting hand stops emitting events.
      if (Math.abs(rate - deck.lastRate) < 1e-3) return;
      param.setTargetAtTime(rate, now, 0.008);
    }
    deck.lastRate = rate;
  }

  // Age-corrects the worklet's last report: it can be a full report interval
  // stale AND it is a render-time position, while the user hears it
  // outputLatency later. Same correction getVoiceTime applies to pad voices, so
  // the tonearm and the editor playhead agree.
  function getDeckTime() {
    if (!deck) return null;
    if (deck.lastFrame == null || !audioContext) return deck.lastPos;
    const latency = audioContext.outputLatency || audioContext.baseLatency || 0;
    const reportedAt = deck.lastFrame / audioContext.sampleRate;
    const elapsed = audioContext.currentTime - reportedAt - latency;
    const projected = deck.lastPos + elapsed * deck.lastRate;
    return Math.max(0, Math.min(deck.fullDuration, projected));
  }

  function seekDeck(mediaSeconds) {
    if (!deck) return;
    deck.lastPos = mediaSeconds;
    deck.lastFrame = null;
    deck.node.port.postMessage({ type: 'seek', mediaSeconds });
  }

  // True when the head has drifted near the edge of a windowed slab, so the
  // caller can re-arm while it is still far from running out.
  function deckNeedsRearm() {
    if (!deck || !deck.windowed) return false;
    const pos = getDeckTime();
    if (pos == null) return false;
    const margin = DECK_WINDOW_SECONDS * 0.25;
    return pos < deck.offsetSeconds + margin || pos > deck.windowEndSeconds - margin;
  }

  function disarmDeck() {
    if (!deck) return;
    const current = deck;
    deck = null;
    if (audioContext) {
      current.gain.gain.cancelScheduledValues(audioContext.currentTime);
      current.gain.gain.setTargetAtTime(0, audioContext.currentTime, DECK_RAMP_SECONDS);
    }
    current.node.port.onmessage = null;
    // Disconnect only AFTER the fade has actually played -- cutting it short is
    // the click the ramp exists to avoid. 'free' drops the slab and makes the
    // processor's next process() return false so it can be collected.
    const holdMs = Math.ceil(DECK_RAMP_SECONDS * 1000) * 4;
    setTimeout(() => {
      current.node.port.postMessage({ type: 'free' });
      try { current.node.disconnect(); } catch { /* already torn down */ }
    }, holdMs);
  }

  function getActivePositions() {
    return Array.from(activeSources.keys());
  }

  function isLoaded(videoId) {
    return buffers.has(videoId);
  }

  // Fire-and-forget cache warm: returns early (does nothing) when the buffer
  // is already cached or already being fetched by someone else, so hovering
  // the same library row twice -- or hovering a track that's already open in
  // the slicer -- costs nothing. Never throws: it's meant to run from a
  // pointerenter/pointerdown handler that has nowhere to surface an error, and
  // a failed prefetch just means the eventual real loadAudio() call retries.
  function prefetchAudio(videoId, url) {
    if (buffers.has(videoId) || inflight.has(videoId)) return;
    loadAudio(videoId, url).catch(() => {});
  }

  function unload(videoId) {
    buffers.delete(videoId);
    reversedBuffers.delete(videoId);
    // The deck holds its own copy of the samples, so it would keep playing a
    // track the user just deleted -- and keep that memory alive with it.
    if (deck && deck.videoId === videoId) disarmDeck();
    // A load/prefetch for this id may still be in flight. Flag it so its
    // decode doesn't write the buffer back into the cache after the delete --
    // see the cache-write guard in loadAudio.
    const entry = inflight.get(videoId);
    if (entry) entry.stale = true;
  }

  // Current buffer-time (seconds) of the voice at `position`, for an accurate
  // playhead driven by the audio clock instead of wall-clock. Maps elapsed
  // context time through the voice's live playbackRate (which already folds in
  // speed/stretch/tune), clamped to the slice. Returns null when no voice is
  // active there (caller falls back to a wall-clock estimate).
  function getVoiceTime(position) {
    const ref = activeSources.get(position);
    if (!ref || !audioContext) return null;
    const rate = ref.source.playbackRate ? ref.source.playbackRate.value : 1;
    // Subtract output latency: ctx.currentTime advances when audio is scheduled,
    // but what the user HEARS lags it by the device output latency. Without this
    // the playhead runs ahead of the sound and reaches the slice end early. The
    // low clamp below holds it at startTime during the initial ~latency window
    // (nothing audible yet), so no negative time leaks out.
    const latency = audioContext.outputLatency || audioContext.baseLatency || 0;
    const elapsed = (audioContext.currentTime - ref.startedAtCtx - latency) * rate;
    const t = ref.startTime + elapsed;
    return Math.max(ref.startTime, Math.min(ref.endTime, t));
  }

  return {
    init,
    loadAudio,
    play,
    stop,
    stopAll,
    updateVoiceFx,
    setVoiceVolume,
    getActivePositions,
    getVoiceTime,
    isLoaded,
    prefetchAudio,
    armDeck,
    setDeckRate,
    getDeckTime,
    seekDeck,
    getDeckRate,
    deckNeedsRearm,
    disarmDeck,
    isDeckArmed,
    unload,
    getAudioContext: () => audioContext,
    getMasterChain,
    // Null until the master chain is built (first init/play). The visualizer
    // treats null as "no signal yet" and degrades gracefully.
    getAnalyser: () => (masterChain ? masterChain.analyser : null),
    setMasterVolume,
    setMasterDelay,
    setMasterBpm,
    setMasterTune,
  };
}
