import { readdir, stat, unlink, rename, access, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
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
    ready: true,
    updatedAt: Date.now(),
  };
  await writeFile(infoPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
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
  let freed = 0;

  for (const video of [...videos].reverse()) {
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
    const videoFile = entries.find((e) => !e.startsWith('audio') && !e.endsWith('.info.json') && !e.endsWith('.json'));
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
