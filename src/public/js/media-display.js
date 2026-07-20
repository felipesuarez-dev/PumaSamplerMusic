import { api } from './api.js';
import { createWaveform } from './waveform.js';
import { mediaKindOf } from './state.js';

// Facade that routes the shared center display between the <video> element
// (YouTube videos and local video uploads) and a waveform (local audio-only
// uploads, which have no video track), so every app.js call site can address
// one surface regardless of what kind of media is actually loaded. Wraps
// video-display.js instead of replacing it -- video routing still goes
// through the same element/overlay/spinner logic that lived there before.
//
// `getMediaInfo(videoId)` looks up the store's video/media list so this can
// tell `mediaKind` apart without needing its own copy of that state.
export function createMediaDisplay({ videoDisplay, audio, waveformCanvas, rulerCanvas, getMediaInfo }) {
  const video = videoDisplay.getVideo();
  const displayEl = video ? video.parentElement : null;

  // selectionEnabled: false -- this is a passive "now playing" preview, not
  // an editable segment (that's editorWaveform, in the Trim tab).
  const waveform = createWaveform(waveformCanvas, {
    rulerCanvas,
    selectionEnabled: false,
  });

  let currentMediaId = null;
  let currentKind = 'video'; // 'video' | 'audio'

  // Pure requestAnimationFrame playhead clock for audio-mode playback, since
  // there's no <video>.currentTime to poll. Used both for the audible Trim
  // preview (which also starts a real scratch voice) and for a muted pad
  // trigger (which must NOT start a second voice -- see playSegment below).
  let rafId = null;
  let clockStartedAt = 0;
  let clockStart = 0;
  let clockEnd = 0;
  let clockPlaying = false;

  function kindOf(videoId) {
    return mediaKindOf(getMediaInfo(videoId));
  }

  function stopClock() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    clockPlaying = false;
  }

  function tickClock() {
    const elapsed = (performance.now() - clockStartedAt) / 1000;
    const time = Math.min(clockEnd, clockStart + elapsed);
    waveform.setPlayhead(time);
    if (time >= clockEnd) {
      stopClock();
      return;
    }
    rafId = requestAnimationFrame(tickClock);
  }

  function startClock(start, end) {
    stopClock();
    clockStart = start;
    clockEnd = end;
    clockStartedAt = performance.now();
    clockPlaying = true;
    rafId = requestAnimationFrame(tickClock);
  }

  // Records which media/kind is "current" so getPlaybackState/getMediaId stay
  // accurate across every entry point (load/playSegment/showFrame), not just
  // load(). Returns whether the id or kind actually changed, so callers only
  // redo expensive work (decoding, waveform reset) when something did.
  function ensureMode(videoId, kind) {
    const changed = currentMediaId !== videoId || currentKind !== kind;
    currentMediaId = videoId;
    currentKind = kind;
    return changed;
  }

  // Canvas gotcha (already bitten twice in this repo -- app.js's
  // activateTab() and slicer.js's ensureWaveform()): a canvas built while its
  // container is display:none is measured at 1x1 by createWaveform's initial
  // resize() and stays that way until explicitly resized again once visible.
  function setAudioMode(on) {
    if (displayEl) displayEl.classList.toggle('audio-mode', on);
    if (on) {
      waveform.resize();
      waveform.draw();
    }
  }

  async function ensureLoadedForAudio(videoId, changed) {
    if (!changed) return;
    stopClock();
    try {
      const buffer = await audio.loadAudio(videoId, api.getAudioUrl(videoId));
      waveform.setAudioBuffer(buffer);
      waveform.setPlayhead(0);
    } catch (err) {
      console.error('Failed to load audio waveform:', err);
      waveform.setEmpty();
    }
  }

  async function load(videoId, url) {
    const kind = kindOf(videoId);
    const changed = ensureMode(videoId, kind);
    if (kind === 'video') {
      setAudioMode(false);
      videoDisplay.load(videoId, url);
      return;
    }
    setAudioMode(true);
    await ensureLoadedForAudio(videoId, changed);
  }

  function setLoading(on, token) {
    return videoDisplay.setLoading(on, token);
  }

  async function playSegment({ videoId, url, start, end, muted, volume, onStop, loadToken }) {
    const kind = kindOf(videoId);
    const changed = ensureMode(videoId, kind);
    if (kind === 'video') {
      setAudioMode(false);
      return videoDisplay.playSegment({ videoId, url, start, end, muted, volume, onStop, loadToken });
    }

    setAudioMode(true);
    await ensureLoadedForAudio(videoId, changed);
    // Mirrors videoDisplay.playSegment's success-clear -- without this the
    // spinner triggerPad turned on via setLoading(true) never comes down for
    // audio-kind pads (`.audio-mode` doesn't hide #video-loading).
    if (loadToken !== undefined) setLoading(false, loadToken);

    // Audible Trim-tab preview plays through the scratch voice (position 0),
    // same pattern as the Auto-Slicer's slice preview (slicer.js:521). A
    // muted pad trigger must NOT start a second voice here -- the real pad
    // voice is already sounding elsewhere (audio-engine.js's play()) -- so it
    // only gets the visual playhead animation below.
    if (!muted) {
      audio.play(0, { videoId, start, end, volume: volume ?? 1 }).catch(() => {});
    }
    startClock(start, end);

    if (typeof onStop === 'function') {
      const durationMs = Math.max(0, end - start) * 1000;
      setTimeout(() => onStop(), Math.max(durationMs, 50));
    }
    return true;
  }

  // Shows a static frame/waveform position instead of playing -- used for
  // Reverse pads (see app.js's triggerPad), which have no reversed video to
  // play, so a frozen point at the slice end is shown instead.
  async function showFrame({ videoId, url, time, loadToken }) {
    const kind = kindOf(videoId);
    const changed = ensureMode(videoId, kind);
    if (kind === 'video') {
      setAudioMode(false);
      return videoDisplay.showFrame({ videoId, url, time, loadToken });
    }
    setAudioMode(true);
    stopClock();
    await ensureLoadedForAudio(videoId, changed);
    waveform.setPlayhead(time);
    // Same success-clear as the video branch (videoDisplay.showFrame) -- the
    // audio path has no such call, so the spinner would otherwise stick.
    if (loadToken !== undefined) setLoading(false, loadToken);
    return true;
  }

  function seek(time) {
    if (currentKind === 'audio') {
      stopClock();
      clockStart = time;
      waveform.setPlayhead(time);
    } else {
      videoDisplay.seek(time);
    }
  }

  function pause() {
    stopClock();
    videoDisplay.pause();
  }

  function stop() {
    stopClock();
    videoDisplay.stop();
  }

  // Video mode: mirrors the old `previewVideo.volume = x` call sites. Audio
  // mode has no live element to set here -- the audio-mode scratch voice's
  // live volume is nudged directly by app.js via audio.setVoiceVolume(0, x),
  // which is a safe no-op when no such voice is currently playing.
  function setVolume(volume) {
    if (currentKind === 'audio') return;
    const el = videoDisplay.getVideo();
    if (el) el.volume = volume;
  }

  function getPlaybackState() {
    if (currentKind === 'audio') {
      const currentTime = clockPlaying
        ? Math.min(clockEnd, clockStart + (performance.now() - clockStartedAt) / 1000)
        : clockStart;
      return { currentTime, paused: !clockPlaying, duration: clockEnd };
    }
    const el = videoDisplay.getVideo();
    return {
      currentTime: el ? el.currentTime : 0,
      paused: el ? el.paused : true,
      duration: el && !Number.isNaN(el.duration) ? el.duration : 0,
    };
  }

  function getMediaId() {
    return currentMediaId;
  }

  // Re-measure the waveform on resize the same way it's re-measured when the
  // .audio-mode class first reveals it (same canvas gotcha as setAudioMode).
  window.addEventListener('resize', () => {
    if (currentKind === 'audio') {
      waveform.resize();
      waveform.draw();
    }
  });

  return {
    load,
    playSegment,
    showFrame,
    stop,
    pause,
    seek,
    setVolume,
    setLoading,
    getPlaybackState,
    getMediaId,
  };
}
