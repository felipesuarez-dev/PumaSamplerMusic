import { Router } from 'express';
import { access } from 'node:fs/promises';
import { isValidYouTubeUrl, extractYouTubeId } from '../utils/validation.js';
import * as downloader from '../services/downloader.js';
import * as videoStore from '../services/video-store.js';
import * as sessionStore from '../services/session-store.js';

const router = Router();

function getBroadcast(req) {
  return req.app.locals.broadcast || (() => {});
}

router.get('/', async (_req, res) => {
  const videos = await videoStore.list();
  const active = downloader.listActive();
  res.json({ videos, active });
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

router.delete('/:id', async (req, res) => {
  const videoId = req.params.id;
  const exists = await videoStore.exists(videoId);
  if (!exists) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const affectedSessions = await sessionStore.findByVideoId(videoId);
  await videoStore.remove(videoId);

  const broadcast = getBroadcast(req);
  broadcast('video:removed', { videoId, affectedSessions });

  res.json({ videoId, removed: true, affectedSessions });
});

export default router;
