import { spawn } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import * as videoStore from './video-store.js';

// Thrown when ffprobe finds no audio stream in the uploaded file. Everything
// downstream (audio-engine, slicer, export) assumes the opus file exists, so
// an audio-less upload (e.g. an image mislabeled with a video extension)
// must be rejected before any transcoding is attempted. The route maps this
// to a 400.
export class NoAudioStreamError extends Error {
  constructor(message = 'Uploaded file has no audio stream') {
    super(message);
    this.name = 'NoAudioStreamError';
  }
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => resolve({ code, stderr }));
    proc.on('error', (err) => reject(err));
  });
}

// Probes an arbitrary media file for the facts processUpload/restore-audio
// need: whether it carries audio/video streams and its duration. Exported so
// the restore-audio route (which receives an already-encoded opus, no
// transcoding needed) can still get a real duration instead of defaulting.
export async function ffprobeMediaInfo(filePath) {
  const probe = await runFfprobe(filePath);
  const streams = probe.streams || [];
  return {
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    duration: parseFloat(probe.format?.duration) || 0,
  };
}

async function extractOpus(sourceFile, destFile) {
  const { code, stderr } = await runFfmpeg([
    '-y', '-i', sourceFile, '-vn', '-c:a', 'libopus', '-b:a', '160k', '-f', 'opus', destFile,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `ffmpeg audio extraction exited with code ${code}`);
  }
}

async function remuxVideo(sourceFile, destFile) {
  const copyResult = await runFfmpeg(['-y', '-i', sourceFile, '-c', 'copy', destFile]);
  if (copyResult.code === 0) return;

  // Plain stream-copy remux fails when the source codecs aren't mp4-valid
  // (e.g. some webm/vp9 uploads) — fall back to a full re-encode rather than
  // rejecting the upload outright.
  const reencodeResult = await runFfmpeg(['-y', '-i', sourceFile, '-c:v', 'libx264', '-c:a', 'aac', destFile]);
  if (reencodeResult.code !== 0) {
    throw new Error(reencodeResult.stderr.trim() || `ffmpeg re-encode exited with code ${reencodeResult.code}`);
  }
}

function stripExtension(name) {
  const ext = extname(name);
  return ext ? basename(name, ext) : name;
}

// Transcodes an opus file to WAV for DAW/tracker compatibility (used by the
// session export route). Never throws — returns false on ffmpeg failure so
// the caller can skip that one wav while the opus in the archive is
// unaffected.
export function ffmpegToWav(inputPath, outputPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-y', '-i', inputPath, outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`ffmpeg wav transcode failed for ${inputPath}:`, stderr.trim());
      }
      resolve(code === 0);
    });
    proc.on('error', (err) => {
      console.error(`ffmpeg wav transcode failed for ${inputPath}:`, err.message);
      resolve(false);
    });
  });
}

// Pipeline for a freshly uploaded file: probe -> (remux+extract | transcode)
// -> finalize -> saveInfo. On any failure the temp dir is wiped and the
// error rethrown so the route can map it to the right status code.
export async function processUpload({ videoId, tempFilePath, originalName }) {
  const tempDir = videoStore.getTempDirectory(videoId);

  try {
    const { hasAudio, hasVideo, duration } = await ffprobeMediaInfo(tempFilePath);

    if (!hasAudio) {
      throw new NoAudioStreamError();
    }

    const mediaKind = hasVideo ? 'video' : 'audio';
    const opusPath = join(tempDir, 'audio.opus');
    await extractOpus(tempFilePath, opusPath);

    if (mediaKind === 'video') {
      const mp4Path = join(tempDir, 'video.mp4');
      await remuxVideo(tempFilePath, mp4Path);
      await videoStore.finalizeVideo(videoId, mp4Path, opusPath);
    } else {
      await videoStore.finalizeAudioOnly(videoId, opusPath);
    }

    const sizeBytes = (await stat(videoStore.getAudioFilePath(videoId))).size;

    // info.json is written LAST, on purpose: everything above this line can
    // fail and leave only orphaned temp/final media files (no info.json),
    // which list()/exists() simply won't surface as ready. Writing info
    // first and failing after would instead leave a phantom "ready" entry.
    const info = await videoStore.saveInfo(videoId, {
      title: stripExtension(originalName || videoId),
      duration,
      sizeBytes,
      source: 'local',
      mediaKind,
    });

    await videoStore.removeOldestIfNeeded(0);

    return info;
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
