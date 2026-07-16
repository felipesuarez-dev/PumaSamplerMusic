import { Router } from 'express';
import archiver from 'archiver';
import { validateSession, sanitizeFilename } from '../utils/validation.js';
import * as sessionStore from '../services/session-store.js';
import * as videoStore from '../services/video-store.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const sessions = await sessionStore.list();
    res.json({ sessions });
  } catch (err) {
    console.error('Failed to list sessions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const session = req.body || {};

  if (!session.name || typeof session.name !== 'string') {
    return res.status(400).json({ error: 'Session name is required' });
  }

  const errors = validateSession(session);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  try {
    const saved = await sessionStore.save(session);
    res.status(201).json(saved);
  } catch (err) {
    console.error('Failed to save session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const session = await sessionStore.load(name);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  } catch (err) {
    console.error('Failed to load session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name/export', async (req, res) => {
  const { name } = req.params;
  try {
    const session = await sessionStore.load(name);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const filename = `${sanitizeFilename(name)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Failed to export session:', err.message);
      res.status(500).end();
    });
    archive.pipe(res);

    archive.append(JSON.stringify(session, null, 2), { name: 'session.json' });

    const videoIds = [...new Set((session.pads || []).map((pad) => pad.videoId).filter(Boolean))];
    for (const videoId of videoIds) {
      if (await videoStore.exists(videoId)) {
        archive.file(videoStore.getAudioFilePath(videoId), { name: `audio/${videoId}.opus` });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('Failed to export session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const removed = await sessionStore.remove(name);
    if (!removed) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
