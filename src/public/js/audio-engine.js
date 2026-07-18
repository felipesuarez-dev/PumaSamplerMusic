export function computeSliceTimes(start, end, bufferDuration) {
  const startTime = Math.max(0, start || 0);
  const endTime = Math.min(bufferDuration, end || bufferDuration);
  const duration = Math.max(0.01, endTime - startTime);
  return { startTime, endTime, duration };
}

// Converts a semitone offset to the frequency ratio used to drive the
// pitch-shifter worklet's grain-read speed (2 semitones = a whole tone, 12 =
// one octave). Tempo/duration are unaffected — this only changes pitch (see
// pitch-shifter-processor.js), unlike AudioBufferSourceNode.playbackRate,
// which would also speed up/slow down playback.
export function semitonesToRatio(semitones) {
  return 2 ** ((semitones || 0) / 12);
}

export function createAudioEngine() {
  let audioContext = null;
  const buffers = new Map(); // videoId -> AudioBuffer
  const activeSources = new Map(); // position -> { sourceNode, gainNode, videoId, startTime, endTime }

  let masterChain = null;
  let workletReady = null;
  let fallbackWarned = false;

  let desiredMasterVolume = 1;
  let desiredDelayTime = 0.25;
  let desiredDelayFeedback = 0;

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

    masterChain = {
      ctx,
      convolver,
      delayNode,
      delayFeedback,
      delayWet,
      masterGain,
      compressor,
      softClip,
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

  async function loadAudio(videoId, url) {
    if (buffers.has(videoId)) {
      return buffers.get(videoId);
    }

    const ctx = await init();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load audio: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    buffers.set(videoId, audioBuffer);
    return audioBuffer;
  }

  async function play(position, {
    videoId, start, end, volume = 1, loop = false, triggerMode = 'oneshot',
    pitch = 0, cutoff = 20000, resonance = 0.1, reverbSend = 0, delaySend = 0,
    pitchShiftOn = true, stretchOn = false, speed = 100, pan = 0, drive = 0,
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

    const { startTime, endTime, duration } = computeSliceTimes(start, end, audioBuffer.duration);

    // Stop any existing playback on this pad
    stop(position);

    // One-shot voices don't layer with each other: any new trigger cuts
    // whatever one-shots are currently playing. Loops are left alone so
    // they can keep sounding as a background layer.
    activeSources.forEach((active, pos) => {
      if (pos !== position && !active.source.loop) {
        stop(pos);
      }
    });

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
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
    const tuneRatio = semitonesToRatio(pitch);
    const stretch = stretchOn ? Math.max(0.25, Math.min(4, speed / 100)) : 1;

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
      source.playbackRate.value = stretch * (pitchShiftOn ? 1 : tuneRatio);
      pitchNode.parameters.get('pitchRatio').value = (pitchShiftOn ? tuneRatio : 1) / stretch;
    } else {
      source.playbackRate.value = stretch * tuneRatio;
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
    if (loop) {
      source.start(now, startTime);
    } else {
      source.start(now, startTime, duration);
    }

    const sourceRef = {
      source, gain, pitchShifterNode: pitchNode, filterNode, driveNode, panNode, dryGain, reverbSendGain, delaySendGain,
      videoId, startTime, endTime, position, duration,
      pitch, pitchShiftOn, stretchOn, speed,
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
    if (active) {
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
  function updateVoiceFx(position, { pitch, cutoff, resonance, reverbSend, delaySend, pitchShiftOn, stretchOn, speed, pan, drive } = {}) {
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

      const tuneRatio = semitonesToRatio(active.pitch);
      const stretch = active.stretchOn ? Math.max(0.25, Math.min(4, active.speed / 100)) : 1;

      if (active.pitchShifterNode) {
        active.source.playbackRate.setTargetAtTime(stretch * (active.pitchShiftOn ? 1 : tuneRatio), now, RAMP);
        active.pitchShifterNode.parameters.get('pitchRatio').setTargetAtTime((active.pitchShiftOn ? tuneRatio : 1) / stretch, now, RAMP);
      } else {
        active.source.playbackRate.setTargetAtTime(stretch * tuneRatio, now, RAMP);
      }
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

  function getActivePositions() {
    return Array.from(activeSources.keys());
  }

  function isLoaded(videoId) {
    return buffers.has(videoId);
  }

  function unload(videoId) {
    buffers.delete(videoId);
  }

  return {
    init,
    loadAudio,
    play,
    stop,
    stopAll,
    updateVoiceFx,
    getActivePositions,
    isLoaded,
    unload,
    getAudioContext: () => audioContext,
    getMasterChain,
    setMasterVolume,
    setMasterDelay,
  };
}
