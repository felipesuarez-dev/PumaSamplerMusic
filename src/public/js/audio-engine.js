export function createAudioEngine() {
  let audioContext = null;
  const buffers = new Map(); // videoId -> AudioBuffer
  const activeSources = new Map(); // position -> { sourceNode, gainNode, videoId, startTime, endTime }

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
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    source.start(now, startTime, duration);

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
  };
}
