import { formatTime } from './state.js';

export function createVideoDisplay(element, options = {}) {
  const video = element;
  let currentVideoId = null;
  let stopTimer = null;
  const onStop = options.onStop || (() => {});

  // Create time overlay inside the video container
  const overlay = document.createElement('div');
  overlay.className = 'video-time-overlay';
  overlay.textContent = '00:00.000';
  if (video.parentElement) {
    video.parentElement.appendChild(overlay);
  }

  // Loading overlay (spinner) for slow/uncached media. A generation token
  // guards against two concurrent loads (e.g. a pad trigger + an editor
  // preview, which share this single video element) clearing each other's
  // spinner. A 150ms delay-gate means cached/instant loads never flash it.
  const loadingEl = document.getElementById('video-loading');
  const displayEl = video.parentElement;
  let loadGen = 0;
  let showTimer = null;

  function setLoading(on, token) {
    if (on) {
      loadGen += 1;
      const my = loadGen;
      clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        if (my === loadGen && loadingEl) loadingEl.classList.add('visible');
      }, 150);
      if (displayEl) displayEl.setAttribute('aria-busy', 'true');
      return my;
    }
    // Only the most recent load may clear the spinner — a superseded load's
    // late resolution must not extinguish a newer load's spinner.
    if (token !== undefined && token !== loadGen) return;
    clearTimeout(showTimer);
    if (loadingEl) loadingEl.classList.remove('visible');
    if (displayEl) displayEl.setAttribute('aria-busy', 'false');
  }

  function updateOverlay() {
    overlay.textContent = formatTime(video.currentTime || 0);
  }

  function load(videoId, url) {
    if (currentVideoId === videoId) return;
    video.src = url;
    video.load();
    currentVideoId = videoId;
    if (displayEl) displayEl.classList.add('has-media');
  }

  function unload() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    currentVideoId = null;
    clearStopTimer();
    video.removeEventListener('timeupdate', updateOverlay);
    overlay.textContent = '00:00.000';
    if (displayEl) displayEl.classList.remove('has-media');
  }

  function clearStopTimer() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  async function playSegment({ videoId, url, start, end, muted, volume, onStop: onSegmentStop, loadToken }) {
    // Reuse the caller's load token (e.g. a pad trigger that already showed the
    // spinner before its audio decode) or start our own (e.g. editor preview).
    const token = loadToken ?? setLoading(true);
    load(videoId, url);
    if (typeof muted === 'boolean') video.muted = muted;
    if (typeof volume === 'number') video.volume = volume;
    video.removeEventListener('timeupdate', updateOverlay);
    video.addEventListener('timeupdate', updateOverlay);

    if (video.readyState < 2) {
      await new Promise((resolve) => {
        const onReady = () => {
          video.removeEventListener('loadeddata', onReady);
          resolve();
        };
        video.addEventListener('loadeddata', onReady);
        video.play().catch(() => {});
      });
    }

    video.currentTime = start;
    updateOverlay();
    clearStopTimer();

    try {
      await video.play();
      setLoading(false, token);
    } catch (err) {
      console.warn('Video play failed:', err);
      setLoading(false, token);
      return false;
    }

    const duration = (end - start) * 1000;
    stopTimer = setTimeout(() => {
      video.pause();
      stopTimer = null;
      video.removeEventListener('timeupdate', updateOverlay);
      onStop();
      if (typeof onSegmentStop === 'function') onSegmentStop();
    }, Math.max(duration, 50));
    return true;
  }

  // Shows a single frozen frame at `time` instead of playing a segment — used
  // for Reverse pads, where the video has no reverse-playback counterpart to
  // the reversed audio, so a still frame at the slice start is shown instead.
  async function showFrame({ videoId, url, time, loadToken }) {
    const token = loadToken ?? setLoading(true);
    load(videoId, url);
    clearStopTimer();
    video.removeEventListener('timeupdate', updateOverlay);
    // Pad-triggered frames are always muted (matching playSegment's pad
    // usage) -- without this, a prior unmuted editor preview could leave
    // video.muted = false, and the play() kick below would leak the video
    // element's own audio track for the moment before it's paused again.
    video.muted = true;

    if (video.readyState < 2) {
      await new Promise((resolve) => {
        const onReady = () => {
          video.removeEventListener('loadeddata', onReady);
          resolve();
        };
        video.addEventListener('loadeddata', onReady);
        // Mirrors playSegment's kick-start: some browsers (notably mobile
        // Safari) only buffer beyond metadata once play() is called, even
        // with no `preload` attribute set. Immediately paused below once the
        // frame is available, so nothing is audibly/visibly played.
        video.play().catch(() => {});
      });
    }

    video.pause();
    video.currentTime = time;
    updateOverlay();
    setLoading(false, token);
    return true;
  }

  function seek(time) {
    video.currentTime = time;
    updateOverlay();
  }

  function pause() {
    video.pause();
    clearStopTimer();
  }

  function stop() {
    video.pause();
    clearStopTimer();
    video.removeEventListener('timeupdate', updateOverlay);
    onStop();
  }

  return {
    load,
    unload,
    playSegment,
    showFrame,
    setLoading,
    seek,
    pause,
    stop,
    getVideo: () => video,
  };
}
