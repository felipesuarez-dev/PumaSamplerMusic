import { spawn } from 'node:child_process';
import { stat, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractYouTubeId } from '../utils/validation.js';
import * as videoStore from './video-store.js';
import { config } from '../utils/config.js';
import { getYtDlpBin } from './ytdlp-updater.js';

const STATUS = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  EXTRACTING: 'extracting',
  RETRYING: 'retrying',
  READY: 'ready',
  ERROR: 'error',
};

// Ordered by live evidence, not preference: YouTube rotates which client it
// blocks every few weeks, so a single hardcoded player_client is structurally
// fragile. `clientArg: null` means "no player_client override" — this rung
// inherits whatever combination yt-dlp currently ships as its best default,
// which keeps the ladder future-proof as YouTube's blocking pattern shifts.
const CLIENT_LADDER = [
  { label: 'mweb', clientArg: 'mweb' },
  { label: 'tv,web', clientArg: 'tv,web' },
  { label: 'web_safari', clientArg: 'web_safari' },
  { label: 'default', clientArg: null },
];

// Explicit muxed fallback: a 360p video is better than no video for a sampler.
const FORMAT_STRING = 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/18/best';

const MAX_LADDER_PASSES = 2;
const INTER_RUNG_MS = 2_000;
const RATE_LIMIT_BASE_MS = 15_000;
const RATE_LIMIT_CAP_MS = 45_000;

const activeDownloads = new Map();
const queue = [];
let runningCount = 0;

export function getStatus(videoId) {
  return activeDownloads.get(videoId) || null;
}

export function listActive() {
  // Completed downloads linger in activeDownloads for 30s (see the finally
  // block in runDownload) purely so the UI can read their terminal status;
  // they're no longer "active" and the store already has the real entry, so
  // exclude READY here to avoid a duplicate/ghost row on the client.
  return Array.from(activeDownloads.values()).filter((s) => s.status !== STATUS.READY);
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

  // The has()-check-and-set() below happens synchronously, before any await,
  // so two near-simultaneous calls for the same videoId can't both pass the
  // dedupe check and race each other against the same tempDir.
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

  const existing = await videoStore.exists(videoId);
  if (existing) {
    activeDownloads.delete(videoId);
    const info = await videoStore.getInfo(videoId);
    return { videoId, status: STATUS.READY, info };
  }

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
  let lastErr = null;

  try {
    for (let pass = 0; pass < MAX_LADDER_PASSES; pass++) {
      for (const rung of CLIENT_LADDER) {
        if (!activeDownloads.has(videoId)) return;

        // Fragments left over from a previously failed rung (video.f399.mp4,
        // video.mp4.part, a partial video.info.json) must not survive into
        // the next rung: readdir order on ext4 is not deterministic, and
        // findTempVideoFile could otherwise promote a stale fragment as if
        // it were this rung's successful result.
        await rm(tempDir, { recursive: true, force: true });
        await mkdir(tempDir, { recursive: true });

        // cancelDownload() may have removed this videoId while rm/mkdir ran;
        // resuming the mutations below would resurrect a cancelled download.
        if (!activeDownloads.has(videoId)) return;

        state.status = STATUS.DOWNLOADING;
        state.progress = 0;
        state.source = rung.label;

        try {
          // Step 1: download video to temp directory (mapped to 0-90% of
          // overall progress, leaving room for the audio extraction phase).
          await runYtDlpDownload(url, tempDir, rung, (progress) => {
            state.progress = Math.round(progress * 0.9);
            notify(callbacks, 'download:progress', { videoId, progress: state.progress });
          }, state);

          // cancelDownload() may have removed this videoId while yt-dlp ran.
          if (!activeDownloads.has(videoId)) return;

          let videoFile = await videoStore.findTempVideoFile(videoId);
          if (!videoFile) {
            throw new Error('Downloaded video file not found');
          }

          // Everything from here on is purely local post-processing: yt-dlp
          // already succeeded, so a failure in this block is not something
          // another rung/client can fix. Tag it so the catch below routes
          // straight to a terminal error instead of burning through up to
          // 8 full re-downloads for a local ffmpeg/filesystem problem.
          try {
            state.status = STATUS.EXTRACTING;
            notify(callbacks, 'download:extracting', { videoId });

            // Step 2: extract audio locally with ffmpeg (mapped to 90-100% of
            // overall progress). Zero additional network requests.
            await runFfmpegExtractAudio(videoFile, tempDir, (progress) => {
              state.progress = 90 + Math.round(progress / 10);
              notify(callbacks, 'download:progress', { videoId, progress: state.progress });
            }, state);

            if (!videoFile.endsWith('.mp4')) {
              // Incompatible merges (e.g. VP9/AV1 video + opus audio) fall
              // back to .mkv despite --merge-output-format mp4 on degraded
              // rungs; remux (no re-encode, cheap) so we never serve an mkv
              // file labeled as mp4.
              videoFile = await remuxToMp4(videoFile, tempDir, state);
            }

            const tempAudio = await videoStore.getTempAudioPath(videoId);
            const metadata = await extractMetadata(videoId);

            // Step 3: move files to final location
            await videoStore.finalizeVideo(videoId, videoFile, tempAudio);

            // Step 4: save metadata
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
            err.stage = 'postprocess';
            throw err;
          }
        } catch (err) {
          if (!activeDownloads.has(videoId)) return;

          if (err.stage === 'postprocess') {
            // Local failure after yt-dlp already succeeded: no rung/client
            // variation would fix this, so fail immediately instead of
            // classifying and advancing the ladder.
            terminalError(state, callbacks, videoId, undefined, err.message);
            return;
          }

          lastErr = err;
          const errorClass = classifyError(err.message);

          if (errorClass === 'unavailable') {
            terminalError(state, callbacks, videoId, 'UNAVAILABLE', err.message);
            return;
          }

          if (errorClass === 'rate_limit') {
            // Break to the between-pass backoff instead of burning through
            // the remaining rungs against an IP that is already throttled.
            console.warn(`Rung "${rung.label}" rate-limited for ${videoId}:`, err.message);
            break;
          }

          // client_gated or unknown: give YouTube's edge a moment, then try
          // the next rung in the ladder.
          console.warn(`Rung "${rung.label}" failed for ${videoId} (${errorClass}):`, err.message);
          await cancellableSleep(state, videoId, INTER_RUNG_MS);
          if (!activeDownloads.has(videoId)) return;
        }
      }

      if (pass < MAX_LADDER_PASSES - 1) {
        const delay = Math.round(
          RATE_LIMIT_BASE_MS + Math.random() * (RATE_LIMIT_CAP_MS - RATE_LIMIT_BASE_MS),
        );
        state.status = STATUS.RETRYING;
        state.progress = 0;
        state.retryAttempt = pass + 1;
        state.retryMax = MAX_LADDER_PASSES - 1;
        notify(callbacks, 'download:retrying', {
          videoId, attempt: pass + 1, max: MAX_LADDER_PASSES - 1, delayMs: delay,
        });
        console.warn(
          `Retrying download for ${videoId} (pass ${pass + 1}/${MAX_LADDER_PASSES - 1}) in ${delay}ms`,
        );

        await cancellableSleep(state, videoId, delay);

        // cancelDownload() may have removed this videoId while we slept.
        if (!activeDownloads.has(videoId)) return;
      }
    }

    // Ladder exhausted across all passes: fail with an honest, machine-
    // readable reason instead of spinning forever.
    const lastClass = classifyError(lastErr ? lastErr.message : '');
    if (lastClass === 'rate_limit') {
      terminalError(
        state, callbacks, videoId, 'RATE_LIMIT',
        'YouTube is rate-limiting downloads. Try again in a few minutes.',
      );
    } else {
      terminalError(
        state, callbacks, videoId, 'BLOCKED',
        'Could not fetch this video from YouTube right now. Try again in a few minutes.',
      );
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

// Classifies a yt-dlp/ffmpeg error message into a bucket that determines how
// runDownload reacts. Order matters: `rate_limit` MUST be checked before
// `client_gated` — a fatal 429 often drags incidental format-selection
// tokens (`nsig`, `have been skipped`) into stderr, and misclassifying it as
// client_gated would fire up to 8 extractions in seconds against an
// already-limited IP with no backoff (the opposite of the intended effect).
// The cost is asymmetric: an unnecessary backoff costs seconds; a skipped
// backoff prolongs the throttle.
function classifyError(message) {
  if (/Private video|video is private|Video unavailable|has been removed|account (has been )?terminated|not available in your country|blocked it in your country|members-only|join this channel|This live (event|stream) will begin|Premieres in|confirm your age|age-restricted/i.test(message)) {
    return 'unavailable';
  }
  if (/HTTP Error 429|Too Many Requests|confirm you.?re not a bot/i.test(message)) {
    return 'rate_limit';
  }
  if (/DRM protected|Requested format is not available|Only images are available|requires a GVS PO Token|have been skipped|SABR|missing a URL|nsig|Unable to extract (yt initial data|player)/i.test(message)) {
    return 'client_gated';
  }
  return 'unknown';
}

// Sets the terminal error state + payload. No cookies references: the
// user-facing cookies flow is gone entirely; `code` is the machine-readable
// bucket the client prefers over regex matching on `error`.
function terminalError(state, callbacks, videoId, code, message) {
  state.status = STATUS.ERROR;
  state.error = message;
  state.code = code;
  console.error(`Download failed for ${videoId} [${code}]:`, message);
  notify(callbacks, 'download:error', { videoId, error: message, code });
}

// Cancellable sleep used both for the inter-rung pause and the between-pass
// backoff. Non-enumerable retryTimer/retryResolve, same rationale as
// currentProcess: keeps state JSON-serializable for GET /api/videos while
// remaining cancellable. retryResolve lets cancelDownload settle this
// promise — clearing the timer alone would leave it pending forever, hanging
// runDownload and leaking its concurrency slot (runningCount is only
// decremented via processQueue's .finally()).
function cancellableSleep(state, videoId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Object.defineProperty(state, 'retryTimer', {
      value: timer, writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(state, 'retryResolve', {
      value: resolve, writable: true, configurable: true, enumerable: false,
    });
  });
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

function runYtDlpDownload(url, tempDir, rung, onProgress, state) {
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
      '--sleep-requests', '2',
      '--extractor-retries', '2',
      // Only override player_client when this rung specifies one; the
      // `default` rung intentionally omits it to inherit yt-dlp's own
      // best-current-client selection.
      ...(rung.clientArg ? ['--extractor-args', `youtube:player_client=${rung.clientArg}`] : []),
      '--write-info-json',
      '-f', FORMAT_STRING,
      '--merge-output-format', 'mp4',
      '-o', 'video.%(ext)s',
      '-P', tempDir,
      url,
    ];

    const proc = spawn(getYtDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function runFfmpegExtractAudio(videoFile, tempDir, onProgress, state) {
  const duration = await readTempDuration(tempDir);
  const audioFile = join(tempDir, 'audio.opus');

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoFile,
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '160k',
      '-f', 'opus',
      audioFile,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Non-enumerable: state objects are JSON-serialized by GET /api/videos,
    // and a ChildProcess holds circular references that would break res.json.
    if (state) {
      Object.defineProperty(state, 'currentProcess', {
        value: proc, writable: true, configurable: true, enumerable: false,
      });
    }
    let stderr = '';
    let lastProgress = 0;

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      // ffmpeg does not emit percentage output; parse elapsed encode time
      // instead and scale it against the source duration from info.json.
      if (duration > 0) {
        const match = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (match) {
          const seconds = (
            parseInt(match[1], 10) * 3600
            + parseInt(match[2], 10) * 60
            + parseInt(match[3], 10)
            + parseInt(match[4], 10) / 100
          );
          const progress = Math.min(100, Math.round((seconds / duration) * 100));
          if (progress > lastProgress) {
            lastProgress = progress;
            onProgress(progress);
          }
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // No duration known: jump straight from whatever was last reported
        // (possibly nothing) to 100 — ffmpeg gives us nothing better here.
        onProgress(100);
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

async function readTempDuration(tempDir) {
  try {
    const entries = await readdir(tempDir);
    const infoFile = entries.find((e) => e.endsWith('.info.json'));
    if (!infoFile) return 0;
    const content = await readFile(join(tempDir, infoFile), 'utf8');
    const info = JSON.parse(content);
    return typeof info.duration === 'number' ? info.duration : 0;
  } catch {
    return 0;
  }
}

async function remuxToMp4(videoFile, tempDir, state) {
  const mp4File = join(tempDir, 'video.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-i', videoFile, '-c', 'copy', mp4File], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Non-enumerable: state objects are JSON-serialized by GET /api/videos,
    // and a ChildProcess holds circular references that would break res.json.
    if (state) {
      Object.defineProperty(state, 'currentProcess', {
        value: proc, writable: true, configurable: true, enumerable: false,
      });
    }
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg remux exited with code ${code}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
  return mp4File;
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
