import express, { Router } from 'express';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { extname, join } from 'node:path';
import Busboy from 'busboy';
import { isValidYouTubeUrl, extractYouTubeId, isValidMediaId } from '../utils/validation.js';
import { config } from '../utils/config.js';
import * as downloader from '../services/downloader.js';
import * as videoStore from '../services/video-store.js';
import * as sessionStore from '../services/session-store.js';
import * as localMedia from '../services/local-media.js';

const router = Router();

// Mirrors downloader's MAX_CONCURRENT_DOWNLOADS pattern: without a cap, N
// simultaneous uploads means N concurrent ffmpeg processes with no ceiling.
const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;

// Runs before ANY /:id* route handler builds a filesystem path. Closes the
// preexisting traversal where Express decodes `..%2F` sequences into
// req.params.id (e.g. GET /api/videos/..%2F..%2Fetc%2Fpasswd/file) before
// video-store.js joins it into a path unvalidated.
router.param('id', (req, res, next, id) => {
  if (!isValidMediaId(id)) {
    return res.status(400).json({ error: 'Invalid media id' });
  }
  next();
});

function getBroadcast(req) {
  return req.app.locals.broadcast || (() => {});
}

async function removeVideoAndNotify(videoId, broadcast) {
  const affectedSessions = await sessionStore.findByVideoId(videoId);
  await videoStore.remove(videoId);
  broadcast('video:removed', { videoId, affectedSessions });
  return affectedSessions;
}

router.get('/', async (_req, res) => {
  const videos = await videoStore.list();
  const active = downloader.listActive();
  res.json({ videos, active, maxCacheGb: config.maxCacheGb });
});

router.post('/', async (req, res) => {
  const { url } = req.body || {};

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID' });
  }

  try {
    const broadcast = getBroadcast(req);
    const result = await downloader.queueDownload(url, {
      onEvent: (event, payload) => broadcast(event, payload),
    });

    if (result.status === 'ready') {
      return res.status(200).json({ videoId, status: result.status, info: result.info });
    }

    res.status(202).json({ videoId, status: result.status });
  } catch (err) {
    console.error('Failed to queue download:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', async (req, res) => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({ error: 'Too many concurrent uploads, please retry shortly' });
  }
  activeUploads++;

  // Both the slot counter and the response must only ever be settled once —
  // busboy's 'close'/'error' and the request's 'aborted' event can each fire
  // in overlapping orders depending on how/when the client disconnects.
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    activeUploads--;
  };

  let responded = false;
  const respond = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  let videoId;
  try {
    videoId = await videoStore.generateLocalId();
  } catch (err) {
    releaseSlot();
    return respond(500, { error: err.message });
  }

  const tempDir = videoStore.getTempDirectory(videoId);
  try {
    await mkdir(tempDir, { recursive: true });
  } catch (err) {
    releaseSlot();
    return respond(500, { error: err.message });
  }

  req.on('aborted', () => {
    if (responded) return;
    responded = true;
    releaseSlot();
    videoStore.removeTempOnly(videoId).catch(() => {});
  });

  let tempFilePath = null;
  let originalName = null;
  let sizeLimitHit = false;
  let bb;
  // Resolves once the write stream has actually flushed to disk (busboy's
  // 'close' only means the readable side ended, not that 'finish' fired on
  // `out`) -- 'close' awaits this before processUpload reads the file, so
  // ffprobe never sees a truncated file.
  let writeDone = Promise.resolve();

  try {
    bb = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: config.maxUploadMb * 1024 * 1024 },
    });
  } catch {
    releaseSlot();
    return respond(400, { error: 'Invalid upload request' });
  }

  bb.on('file', (_field, stream, info) => {
    originalName = info.filename || 'upload';
    tempFilePath = join(tempDir, `source${extname(originalName)}`);
    const out = createWriteStream(tempFilePath);
    writeDone = new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    stream.on('limit', () => {
      sizeLimitHit = true;
    });
    // .pipe() does not forward destination errors -- without this, an
    // ENOSPC/EACCES on `out` (e.g. disk full) emits an unhandled 'error' on
    // the write stream and crashes the process.
    out.on('error', (err) => {
      if (responded) return;
      releaseSlot();
      respond(500, { error: err.message });
      stream.unpipe(out);
      videoStore.removeTempOnly(videoId).catch(() => {});
    });
    stream.pipe(out);
  });

  bb.on('error', (err) => {
    if (responded) return;
    releaseSlot();
    respond(500, { error: err.message });
    videoStore.removeTempOnly(videoId).catch(() => {});
  });

  bb.on('close', async () => {
    if (responded) {
      releaseSlot();
      return;
    }

    if (sizeLimitHit) {
      releaseSlot();
      await videoStore.removeTempOnly(videoId).catch(() => {});
      return respond(413, { error: `File exceeds the ${config.maxUploadMb}MB upload limit` });
    }

    if (!tempFilePath) {
      releaseSlot();
      await videoStore.removeTempOnly(videoId).catch(() => {});
      return respond(400, { error: 'No file provided' });
    }

    try {
      // busboy's 'close' only means the readable side ended, not that the
      // write stream flushed to disk -- await it first so ffprobe never
      // reads a truncated file.
      await writeDone;
      const info = await localMedia.processUpload({ videoId, tempFilePath, originalName });
      releaseSlot();
      respond(201, { videoId, ...info });
    } catch (err) {
      releaseSlot();
      const status = err instanceof localMedia.NoAudioStreamError ? 400 : 500;
      if (status === 500) console.error('Upload processing failed:', err.message);
      respond(status, { error: err.message });
    }
  });

  req.pipe(bb);
});

router.get('/:id', async (req, res) => {
  const videoId = req.params.id;
  const exists = await videoStore.exists(videoId);
  if (!exists) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const info = await videoStore.getInfo(videoId);
  res.json({
    videoId,
    title: info.title || videoId,
    duration: info.duration || 0,
    ...info,
  });
});

router.get('/:id/file', async (req, res) => {
  const videoId = req.params.id;
  const path = videoStore.getVideoFilePath(videoId);

  try {
    await access(path);
  } catch {
    return res.status(404).json({ error: 'Video file not found' });
  }

  res.sendFile(path);
});

router.get('/:id/audio', async (req, res) => {
  const videoId = req.params.id;
  const path = videoStore.getAudioFilePath(videoId);

  try {
    await access(path);
  } catch {
    return res.status(404).json({ error: 'Audio file not found' });
  }

  res.sendFile(path);
});

router.post(
  '/:id/restore-audio',
  // Explicit type + limit: the app-wide express.json() default (10mb) does
  // not apply to raw bodies, and body-parser's own raw default limit is
  // 100kb — far too small for a real opus file pulled from an export ZIP.
  express.raw({ type: 'application/octet-stream', limit: `${config.maxUploadMb}mb` }),
  async (req, res) => {
    const videoId = req.params.id;
    const title = typeof req.query.title === 'string' ? req.query.title : undefined;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Missing audio body' });
    }

    const existingInfo = await videoStore.getInfo(videoId);
    // Guards against overwriting a YouTube (or non-audio-local) item's opus
    // and leaving its other files (or the local video's now-orphaned mp4)
    // inconsistent with the JSON that describes them.
    if (existingInfo && !(existingInfo.source === 'local' && existingInfo.mediaKind === 'audio')) {
      return res.status(409).json({ error: 'Existing media is not a restorable local audio item' });
    }

    const tempDir = videoStore.getTempDirectory(videoId);
    try {
      await mkdir(tempDir, { recursive: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    const tempOpusPath = join(tempDir, 'audio.opus');

    try {
      await writeFile(tempOpusPath, req.body);
      const { duration } = await localMedia.ffprobeMediaInfo(tempOpusPath).catch(() => ({ duration: existingInfo?.duration || 0 }));
      await videoStore.finalizeAudioOnly(videoId, tempOpusPath);

      // info.json written last, same rationale as processUpload: never
      // leave a "ready" entry pointing at a file that isn't actually there.
      const info = await videoStore.saveInfo(videoId, {
        title: title || existingInfo?.title || videoId,
        duration,
        sizeBytes: req.body.length,
        source: 'local',
        mediaKind: 'audio',
      });
      res.status(200).json({ videoId, ...info });
    } catch (err) {
      await videoStore.removeTempOnly(videoId).catch(() => {});
      console.error('Failed to restore local audio:', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

router.delete('/:id', async (req, res) => {
  const videoId = req.params.id;
  const exists = await videoStore.exists(videoId);
  // A stuck/errored/in-progress download never reaches videoStore (only
  // downloader's in-memory activeDownloads has it) — without this, the
  // remove button 404s on it and it lingers forever with no way to clear it.
  const cancelled = downloader.cancelDownload(videoId);

  if (!exists && !cancelled) {
    return res.status(404).json({ error: 'Video not found' });
  }

  if (!exists) {
    // A stuck/errored download can leave an orphaned .tmp_<id>/ scratch dir
    // behind (it never reached videoStore, so the removed-path cleanup
    // below never runs for it) — purge it here so Retry (delete->add) never
    // accumulates leaked temp directories.
    await videoStore.removeTempOnly(videoId);
    getBroadcast(req)('video:removed', { videoId, affectedSessions: [] });
    return res.json({ videoId, removed: true, affectedSessions: [] });
  }

  const affectedSessions = await removeVideoAndNotify(videoId, getBroadcast(req));
  res.json({ videoId, removed: true, affectedSessions });
});

router.delete('/', async (req, res) => {
  const videos = await videoStore.list();
  const broadcast = getBroadcast(req);
  const removed = [];
  for (const video of videos) {
    try {
      await removeVideoAndNotify(video.videoId, broadcast);
      removed.push(video.videoId);
    } catch (err) {
      console.error(`Bulk delete failed for ${video.videoId}:`, err.message);
    }
  }
  res.json({ removed: removed.length, videoIds: removed });
});

export default router;
