export function createAudioEngine() {
  let audioContext = null;
  const buffers = new Map(); // videoId -> AudioBuffer
  const activeSources = new Map(); // position -> { sourceNode, gainNode, videoId, startTime, endTime }

  let masterChain = null;

  let desiredMasterVolume = 1;
  let desiredFilterCutoff = 20000;
  let desiredFilterResonance = 0.1;
  let desiredReverbMix = 0;
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

  function ensureMasterChain(ctx) {
    if (masterChain) return masterChain;

    const masterInput = ctx.createGain();
    masterInput.gain.value = 1;

    const masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = 20000;
    masterFilter.Q.value = 0.1;

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;

    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0;

    const convolver = ctx.createConvolver();
    convolver.buffer = generateImpulseResponse(ctx, ctx.sampleRate, 1.5, 0.6);

    const delaySend = ctx.createGain();
    delaySend.gain.value = 0;

    const delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.25;

    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0;

    const delayWet = ctx.createGain();
    delayWet.gain.value = 1;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;

    // Routing
    masterInput.connect(masterFilter);
    masterFilter.connect(dryGain);
    dryGain.connect(masterGain);

    masterFilter.connect(reverbSend);
    reverbSend.connect(convolver);
    convolver.connect(masterGain);

    masterFilter.connect(delaySend);
    delaySend.connect(delayNode);
    delayNode.connect(delayWet);
    delayWet.connect(masterGain);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);

    masterGain.connect(ctx.destination);

    masterChain = {
      ctx,
      masterInput,
      masterFilter,
      dryGain,
      reverbSend,
      convolver,
      delaySend,
      delayNode,
      delayFeedback,
      delayWet,
      masterGain,
    };

    // Apply any values that were set before the chain existed.
    applyMasterValues();

    return masterChain;
  }

  function applyMasterValues() {
    if (!masterChain) return;
    masterChain.masterGain.gain.value = desiredMasterVolume;
    masterChain.masterFilter.frequency.value = desiredFilterCutoff;
    masterChain.masterFilter.Q.value = desiredFilterResonance;
    masterChain.reverbSend.gain.value = desiredReverbMix;
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

  function setMasterFilter({ cutoff, resonance }) {
    if (typeof cutoff === 'number') {
      desiredFilterCutoff = Math.max(20, Math.min(20000, cutoff));
      if (masterChain) masterChain.masterFilter.frequency.value = desiredFilterCutoff;
    }
    if (typeof resonance === 'number') {
      desiredFilterResonance = Math.max(0.1, Math.min(20, resonance));
      if (masterChain) masterChain.masterFilter.Q.value = desiredFilterResonance;
    }
  }

  function setMasterReverb(mix) {
    desiredReverbMix = Math.max(0, Math.min(1, mix));
    if (masterChain) masterChain.reverbSend.gain.value = desiredReverbMix;
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

  async function play(position, { videoId, start, end, volume = 1, loop = false, triggerMode = 'oneshot' }) {
    const ctx = await init();
    const chain = ensureMasterChain(ctx);
    const audioBuffer = buffers.get(videoId);
    if (!audioBuffer) return false;

    const startTime = Math.max(0, start || 0);
    const endTime = Math.min(audioBuffer.duration, end || audioBuffer.duration);
    const duration = Math.max(0.01, endTime - startTime);

    // Stop any existing playback on this pad
    stop(position);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = loop;
    source.loopStart = startTime;
    source.loopEnd = endTime;

    const gain = ctx.createGain();
    gain.gain.value = volume;

    source.connect(gain);
    gain.connect(chain.masterInput);

    const now = ctx.currentTime;
    if (loop) {
      source.start(now, startTime);
    } else {
      source.start(now, startTime, duration);
    }

    const sourceRef = { source, gain, videoId, startTime, endTime, position, duration };
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
      try {
        active.gain.disconnect();
      } catch {
        // ignore
      }
      activeSources.delete(position);
      emit('audiosourcestop', { position, videoId: active.videoId });
    }
  }

  function stopAll() {
    activeSources.forEach((active) => {
      try {
        active.source.stop();
      } catch {
        // ignore
      }
      try {
        active.gain.disconnect();
      } catch {
        // ignore
      }
      emit('audiosourcestop', { position: active.position, videoId: active.videoId });
    });
    activeSources.clear();
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
    getActivePositions,
    isLoaded,
    unload,
    getAudioContext: () => audioContext,
    getMasterChain,
    setMasterVolume,
    setMasterFilter,
    setMasterReverb,
    setMasterDelay,
  };
}
