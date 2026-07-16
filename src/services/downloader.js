import { spawn } from 'node:child_process';
import { stat, mkdir, readFile } from 'node:fs/promises';
import { extractYouTubeId } from '../utils/validation.js';
import * as videoStore from './video-store.js';

const STATUS = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  EXTRACTING: 'extracting',
  READY: 'ready',
  ERROR: 'error',
};

const activeDownloads = new Map();
const queue = [];
let runningCount = 0;

export function getStatus(videoId) {
  return activeDownloads.get(videoId) || null;
}

export function listActive() {
  return Array.from(activeDownloads.values());
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
    await mkdir(tempDir, { recursive: true });

    // Step 1: Download video to temp directory (mapped to the lower half of the
    // overall progress range so it doesn't visually jump from 100% back to 0%
    // when the audio extraction phase starts)
    await runYtDlp(url, tempDir, (progress) => {
      state.progress = Math.round(progress / 2);
      notify(callbacks, 'download:progress', { videoId, progress: state.progress });
    });

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
    });
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
  } catch (err) {
    state.status = STATUS.ERROR;
    state.error = err.message;
    console.error(`Download failed for ${videoId}:`, err.message);
    notify(callbacks, 'download:error', { videoId, error: err.message });
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

function runYtDlp(url, tempDir, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--write-info-json',
      '-f', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=1080]',
      '--merge-output-format', 'mp4',
      '-o', 'video.%(ext)s',
      '-P', tempDir,
      url,
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

function runYtDlpAudio(url, tempDir, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'opus',
      '--audio-quality', '160K',
      '--no-playlist',
      '--no-warnings',
      '-o', 'audio.%(ext)s',
      '-P', tempDir,
      url,
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

function notify(callbacks, event, payload) {
  if (typeof callbacks.onEvent === 'function') {
    callbacks.onEvent(event, payload);
  }
  if (typeof callbacks[event] === 'function') {
    callbacks[event](payload);
  }
}
