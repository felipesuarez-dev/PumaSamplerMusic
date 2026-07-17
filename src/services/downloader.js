import { spawn } from 'node:child_process';
import { stat, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extractYouTubeId } from '../utils/validation.js';
import * as videoStore from './video-store.js';
import { config } from '../utils/config.js';

const STATUS = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  EXTRACTING: 'extracting',
  RETRYING: 'retrying',
  READY: 'ready',
  ERROR: 'error',
};

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 60_000;

const activeDownloads = new Map();
const queue = [];
let runningCount = 0;

export function getStatus(videoId) {
  return activeDownloads.get(videoId) || null;
}

export function listActive() {
  return Array.from(activeDownloads.values());
}

// Cancels a queued/in-flight/errored download so the UI's remove button can
// clear entries that never reached videoStore (see DELETE /api/videos/:id).
// Returns false when the videoId has no active download state.
export function cancelDownload(videoId) {
  const state = activeDownloads.get(videoId);
  if (!state) return false;

  const queuedIndex = queue.findIndex((item) => item.videoId === videoId);
  if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1);
  }

  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
  }
  if (state.retryResolve) {
    // Settle the pending backoff sleep so runDownload can observe the
    // deletion and exit, freeing its concurrency slot.
    state.retryResolve();
  }

  if (state.currentProcess && state.currentProcess.exitCode === null) {
    try {
      state.currentProcess.kill('SIGTERM');
    } catch {
      // Process already gone
    }
  }

  activeDownloads.delete(videoId);
  return true;
}

export async function queueDownload(url, callbacks = {}) {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  const existing = await videoStore.exists(videoId);
  if (existing) {
    const info = await videoStore.getInfo(videoId);
    return { videoId, status: STATUS.READY, info };
  }

  if (activeDownloads.has(videoId)) {
    return { videoId, status: activeDownloads.get(videoId).status };
  }

  const downloadState = {
    videoId,
    url,
    status: STATUS.QUEUED,
    progress: 0,
    error: null,
    startedAt: Date.now(),
  };

  activeDownloads.set(videoId, downloadState);
  queue.push({ videoId, url, callbacks });
  processQueue();

  return { videoId, status: STATUS.QUEUED };
}

async function processQueue() {
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2', 10);

  while (runningCount < maxConcurrent && queue.length > 0) {
    const item = queue.shift();
    runningCount++;
    runDownload(item).finally(() => {
      runningCount--;
      processQueue();
    });
  }
}

async function runDownload({ videoId, url, callbacks }) {
  const state = activeDownloads.get(videoId);
  if (!state) return;

  state.status = STATUS.DOWNLOADING;
  state.progress = 0;
  notify(callbacks, 'download:start', { videoId });

  const tempDir = videoStore.getTempDirectory(videoId);

  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        // Retries re-enter DOWNLOADING; the RETRYING -> DOWNLOADING transition
        // is communicated via the progress notifications below, not a fresh
        // download:start (that event fires once per queued item).
        state.status = STATUS.DOWNLOADING;
        state.progress = 0;
      }

      try {
        await mkdir(tempDir, { recursive: true });

        // Step 1: Download video to temp directory (mapped to the lower half of the
        // overall progress range so it doesn't visually jump from 100% back to 0%
        // when the audio extraction phase starts)
        await runYtDlp(url, tempDir, (progress) => {
          state.progress = Math.round(progress / 2);
          notify(callbacks, 'download:progress', { videoId, progress: state.progress });
        }, state);

        const videoFile = await videoStore.findTempVideoFile(videoId);
        if (!videoFile) {
          throw new Error('Downloaded video file not found');
        }

        state.status = STATUS.EXTRACTING;
        notify(callbacks, 'download:extracting', { videoId });

        // Step 2: Extract audio (mapped to the upper half of the overall progress range
        // so it doesn't visually jump from 100% back to 0% after the video phase)
        await runYtDlpAudio(url, tempDir, (progress) => {
          state.progress = 50 + Math.round(progress / 2);
          notify(callbacks, 'download:progress', { videoId, progress: state.progress });
        }, state);
        const tempAudio = await videoStore.getTempAudioPath(videoId);

        // Step 3: Extract metadata from info.json sidecar
        const metadata = await extractMetadata(videoId);

        // Step 4: Move files to final location
        await videoStore.finalizeVideo(videoId, videoFile, tempAudio);

        // Step 5: Save metadata
        const audioStats = await stat(videoStore.getAudioFilePath(videoId));
        const info = {
          videoId,
          url,
          title: metadata.title,
          duration: metadata.duration,
          sizeBytes: audioStats.size,
          ready: true,
          updatedAt: Date.now(),
        };
        await videoStore.saveInfo(videoId, info);

        state.status = STATUS.READY;
        state.progress = 100;
        notify(callbacks, 'download:ready', { videoId, info });
        return;
      } catch (err) {
        const retryable = /429|Too Many Requests|Sign in to confirm/i.test(err.message);

        if (!retryable || attempt >= MAX_RETRIES) {
          // Rotated/expired cookies get their own hint: the remedy is
          // re-exporting, not configuring from scratch.
          const errorMessage = /cookies are no longer valid/i.test(err.message)
            ? `YouTube cookies expired. Re-export them via the Videos panel guide. Original: ${err.message}`
            : /Sign in to confirm|DRM protected/.test(err.message)
              ? `YouTube bot-check triggered. Configure YouTube cookies in the Videos panel settings. Original: ${err.message}`
              : err.message;
          state.status = STATUS.ERROR;
          state.error = errorMessage;
          console.error(`Download failed for ${videoId}:`, err.message);
          notify(callbacks, 'download:error', { videoId, error: errorMessage });
          return;
        }

        const delay = Math.min(
          Math.round(RETRY_BASE_MS * 3 ** attempt * (0.75 + Math.random() * 0.5)),
          300_000,
        );
        state.status = STATUS.RETRYING;
        state.progress = 0;
        state.retryAttempt = attempt + 1;
        state.retryMax = MAX_RETRIES;
        notify(callbacks, 'download:retrying', {
          videoId, attempt: attempt + 1, max: MAX_RETRIES, delayMs: delay,
        });
        console.warn(
          `Retrying download for ${videoId} (attempt ${attempt + 1}/${MAX_RETRIES}) in ${delay}ms`,
        );

        await new Promise((resolve) => {
          // Non-enumerable, same rationale as currentProcess: keeps state
          // JSON-serializable for GET /api/videos while remaining cancellable.
          // retryResolve lets cancelDownload settle this promise — clearing
          // the timer alone would leave it pending forever, hanging
          // runDownload and leaking its concurrency slot (runningCount is
          // only decremented via processQueue's .finally()).
          const timer = setTimeout(resolve, delay);
          Object.defineProperty(state, 'retryTimer', {
            value: timer, writable: true, configurable: true, enumerable: false,
          });
          Object.defineProperty(state, 'retryResolve', {
            value: resolve, writable: true, configurable: true, enumerable: false,
          });
        });

        // cancelDownload() may have removed this videoId while we slept.
        if (!activeDownloads.has(videoId)) return;
      }
    }
  } finally {
    // Keep state around briefly so UI can read status, then clean up
    setTimeout(() => {
      if (activeDownloads.get(videoId)?.status === STATUS.READY) {
        activeDownloads.delete(videoId);
      }
    }, 30000);
  }
}

async function extractMetadata(videoId) {
  const defaultMeta = { title: videoId, duration: 0 };
  try {
    const infoPath = await videoStore.findTempInfoJsonFile(videoId);
    if (!infoPath) return defaultMeta;

    const content = await readFile(infoPath, 'utf8');
    const info = JSON.parse(content);
    return {
      title: info.title || videoId,
      duration: typeof info.duration === 'number' ? info.duration : 0,
    };
  } catch (err) {
    console.warn(`Failed to extract metadata for ${videoId}:`, err.message);
    return defaultMeta;
  }
}

function runYtDlp(url, tempDir, onProgress, state) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      ...cookiesArgs(),
      ...providerArgs(),
      '--js-runtimes', 'node',
      // yt-dlp 2026+ ships its JS signature/nsig challenge solver as an
      // opt-in remote component; without it every real A/V format is
      // silently dropped (storyboards only) regardless of client/cookies.
      '--remote-components', 'ejs:github',
      '--sleep-requests', '1.5',
      '--extractor-args', 'youtube:player_client=tv,web',
      '--write-info-json',
      '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '--merge-output-format', 'mp4',
      '-o', 'video.%(ext)s',
      '-P', tempDir,
      url,
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Non-enumerable: state objects are JSON-serialized by GET /api/videos,
    // and a ChildProcess holds circular references that would break res.json.
    if (state) {
      Object.defineProperty(state, 'currentProcess', {
        value: proc, writable: true, configurable: true, enumerable: false,
      });
    }
    let stderr = '';
    let lastProgress = 0;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/(\d{1,3}\.\d)%/);
      if (match) {
        const progress = parseFloat(match[1]);
        if (progress > lastProgress) {
          lastProgress = progress;
          onProgress(progress);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

function runYtDlpAudio(url, tempDir, onProgress, state) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'opus',
      '--audio-quality', '160K',
      '--no-playlist',
      ...cookiesArgs(),
      ...providerArgs(),
      '--js-runtimes', 'node',
      // See runYtDlp: required for signature solving on yt-dlp 2026+.
      '--remote-components', 'ejs:github',
      '--sleep-requests', '1.5',
      '--extractor-args', 'youtube:player_client=tv,web',
      '-o', 'audio.%(ext)s',
      '-P', tempDir,
      url,
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Non-enumerable: state objects are JSON-serialized by GET /api/videos,
    // and a ChildProcess holds circular references that would break res.json.
    if (state) {
      Object.defineProperty(state, 'currentProcess', {
        value: proc, writable: true, configurable: true, enumerable: false,
      });
    }
    let stderr = '';
    let lastProgress = 0;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/(\d{1,3}\.\d)%/);
      if (match) {
        const progress = parseFloat(match[1]);
        if (progress > lastProgress) {
          lastProgress = progress;
          onProgress(progress);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

function cookiesArgs() {
  return config.cookiesFile && existsSync(config.cookiesFile)
    ? ['--cookies', config.cookiesFile]
    : [];
}

function providerArgs() {
  return config.potProviderUrl
    ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`]
    : [];
}

function notify(callbacks, event, payload) {
  if (typeof callbacks.onEvent === 'function') {
    callbacks.onEvent(event, payload);
  }
  if (typeof callbacks[event] === 'function') {
    callbacks[event](payload);
  }
}
