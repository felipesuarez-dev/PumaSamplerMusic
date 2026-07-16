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

  function updateOverlay() {
    overlay.textContent = formatTime(video.currentTime || 0);
  }

  function load(videoId, url) {
    if (currentVideoId === videoId) return;
    video.src = url;
    video.load();
    currentVideoId = videoId;
  }

  function unload() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    currentVideoId = null;
    clearStopTimer();
    video.removeEventListener('timeupdate', updateOverlay);
    overlay.textContent = '00:00.000';
  }

  function clearStopTimer() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  async function playSegment({ videoId, url, start, end }) {
    load(videoId, url);
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
    } catch (err) {
      console.warn('Video play failed:', err);
    }

    const duration = (end - start) * 1000;
    stopTimer = setTimeout(() => {
      video.pause();
      stopTimer = null;
      video.removeEventListener('timeupdate', updateOverlay);
      onStop();
    }, Math.max(duration, 50));
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
    stop,
    getVideo: () => video,
  };
}
