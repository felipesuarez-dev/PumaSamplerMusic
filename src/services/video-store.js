import { readdir, stat, unlink, rename, access, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { config } from '../utils/config.js';

const VIDEO_EXT = '.mp4';
const AUDIO_EXT = '.opus';
const INFO_EXT = '.json';

function getVideoPath(videoId, ext = VIDEO_EXT) {
  return join(config.videosDir, `${videoId}${ext}`);
}

function getInfoPath(videoId) {
  return join(config.videosDir, `${videoId}${INFO_EXT}`);
}

function getTempDir(videoId) {
  return join(config.videosDir, `.tmp_${videoId}`);
}

export function getVideoInfoPath(videoId) {
  return getInfoPath(videoId);
}

export function getVideoFilePath(videoId) {
  return getVideoPath(videoId, VIDEO_EXT);
}

export function getAudioFilePath(videoId) {
  return getVideoPath(videoId, AUDIO_EXT);
}

export function getTempDirectory(videoId) {
  return getTempDir(videoId);
}

export async function exists(videoId) {
  const audioPath = getAudioFilePath(videoId);
  try {
    await access(audioPath);
    return true;
  } catch {
    return false;
  }
}

export async function getInfo(videoId) {
  const infoPath = getInfoPath(videoId);
  try {
    const content = await readFile(infoPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveInfo(videoId, info) {
  const infoPath = getInfoPath(videoId);
  const normalized = {
    videoId,
    url: info.url,
    title: info.title || videoId,
    duration: info.duration || 0,
    sizeBytes: info.sizeBytes || 0,
    // Defaults keep pre-existing YouTube-only sessions/entries readable:
    // an info.json written before this field existed has neither key, so
    // reads must resolve to the same 'youtube'/'video' behavior as before.
    source: info.source || 'youtube',
    mediaKind: info.mediaKind || 'video',
    ready: true,
    updatedAt: Date.now(),
  };
  await writeFile(infoPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

const LOCAL_ID_LENGTH = 11;
const LOCAL_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function randomLocalId() {
  const bytes = randomBytes(LOCAL_ID_LENGTH);
  let id = '';
  for (let i = 0; i < LOCAL_ID_LENGTH; i++) {
    id += LOCAL_ID_ALPHABET[bytes[i] % LOCAL_ID_ALPHABET.length];
  }
  return id;
}

// Generates an 11-char id matching isValidMediaId (same shape as a YouTube
// video id, on purpose — see validation.js), retrying against getInfo() on
// the astronomically unlikely on-disk collision.
export async function generateLocalId() {
  let id = randomLocalId();
  while (await getInfo(id)) {
    id = randomLocalId();
  }
  return id;
}

export async function list() {
  try {
    const entries = await readdir(config.videosDir);
    const infoFiles = entries.filter((entry) => entry.endsWith(INFO_EXT));
    const videos = [];

    for (const infoFile of infoFiles) {
      const videoId = infoFile.slice(0, -INFO_EXT.length);
      const info = await getInfo(videoId);
      if (info) {
        videos.push({
          videoId,
          title: info.title || videoId,
          duration: info.duration || 0,
          ...info,
        });
      }
    }

    return videos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (err) {
    console.error('Failed to list videos:', err.message);
    return [];
  }
}

export async function getTotalSizeBytes() {
  try {
    const entries = await readdir(config.videosDir);
    let total = 0;
    for (const entry of entries) {
      const entryPath = join(config.videosDir, entry);
      const stats = await stat(entryPath);
      if (stats.isFile()) {
        total += stats.size;
      } else if (stats.isDirectory()) {
        total += await getDirectorySize(entryPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function getDirectorySize(dir) {
  try {
    const entries = await readdir(dir);
    let total = 0;
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const stats = await stat(entryPath);
      total += stats.size;
    }
    return total;
  } catch {
    return 0;
  }
}

export async function remove(videoId) {
  const files = [
    getVideoPath(videoId),
    getAudioFilePath(videoId),
    getInfoPath(videoId),
  ];

  for (const file of files) {
    try {
      await unlink(file);
    } catch {
      // Ignore files that don't exist
    }
  }

  try {
    await rm(getTempDir(videoId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export async function removeOldestIfNeeded(requiredBytes) {
  const currentSize = await getTotalSizeBytes();
  const available = config.maxCacheBytes - currentSize;

  if (available >= requiredBytes) {
    return true;
  }

  const videos = await list();
  // Local uploads are never auto-evicted by the LRU cache — that cache
  // exists to reclaim space from re-downloadable YouTube content, not to
  // silently delete files the user explicitly uploaded.
  const evictable = videos.filter((video) => video.source !== 'local');
  let freed = 0;

  for (const video of [...evictable].reverse()) {
    if (currentSize - freed + requiredBytes <= config.maxCacheBytes) {
      break;
    }
    await remove(video.videoId);
    freed += (video.sizeBytes || 0);
  }

  return (currentSize - freed + requiredBytes) <= config.maxCacheBytes;
}

export async function getTempAudioPath(videoId) {
  return join(getTempDir(videoId), `audio${AUDIO_EXT}`);
}

export async function getTempInfoJsonPath(videoId) {
  return join(getTempDir(videoId), 'video.info.json');
}

export async function findTempVideoFile(videoId) {
  const tempDir = getTempDir(videoId);
  try {
    const entries = await readdir(tempDir);
    const candidates = entries.filter((e) => (
      !e.startsWith('audio')
      && !e.endsWith('.info.json')
      && !e.endsWith('.json')
      && !e.endsWith('.part')
      && !e.endsWith('.ytdl')
      && !/\.f\d+\./.test(e)
    ));

    // Prefer the exact "video.<ext>" name over any other leftover candidate
    // (readdir order on ext4 is not deterministic).
    const exactMatch = candidates.find((e) => /^video\.[^.]+$/.test(e));
    const videoFile = exactMatch || candidates[0];
    return videoFile ? join(tempDir, videoFile) : null;
  } catch {
    return null;
  }
}

export async function findTempInfoJsonFile(videoId) {
  const tempDir = getTempDir(videoId);
  try {
    const entries = await readdir(tempDir);
    const infoFile = entries.find((e) => e.endsWith('.info.json'));
    return infoFile ? join(tempDir, infoFile) : null;
  } catch {
    return null;
  }
}

// Purges only the temp working directory, leaving any finalized files (if
// present) untouched. Used by DELETE /:id when the video never made it to
// videoStore, so its .tmp_<id>/ scratch dir doesn't linger forever.
export async function removeTempOnly(videoId) {
  try {
    await rm(getTempDir(videoId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Removes leftover .tmp_<videoId> directories from crashes/interruptions
// that never reached finalizeVideo/removeTempOnly. Meant to run once at
// boot: by definition there are no legitimate in-flight downloads yet, so
// every .tmp_* entry found here is orphaned garbage. Benign race: if a
// download for the same videoId is queued right at boot while its orphaned
// .tmp_ dir is being swept, both operations are idempotent (worst case is a
// spurious failed attempt, not corruption).
export async function sweepOrphanTempDirs() {
  let removed = 0;
  try {
    const entries = await readdir(config.videosDir);
    const tempDirs = entries.filter((entry) => entry.startsWith('.tmp_'));

    for (const entry of tempDirs) {
      const videoId = entry.slice('.tmp_'.length);
      await removeTempOnly(videoId);
      removed++;
    }
  } catch {
    // ignore
  }
  return removed;
}

export async function finalizeVideo(videoId, videoSource, audioSource) {
  const finalVideo = getVideoPath(videoId);
  const finalAudio = getAudioFilePath(videoId);
  const tempDir = getTempDir(videoId);

  await rename(videoSource, finalVideo);
  await rename(audioSource, finalAudio);

  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Audio-only counterpart of finalizeVideo — a local audio upload (or a
// restored opus from a session-export ZIP) has no mp4 to move.
export async function finalizeAudioOnly(videoId, audioSourcePath) {
  const finalAudio = getAudioFilePath(videoId);
  const tempDir = getTempDir(videoId);

  await rename(audioSourcePath, finalAudio);

  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
