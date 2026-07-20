import { Router } from 'express';
import archiver from 'archiver';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSession, sanitizeFilename } from '../utils/validation.js';
import * as sessionStore from '../services/session-store.js';
import * as videoStore from '../services/video-store.js';
import { ffmpegToWav } from '../services/local-media.js';

const router = Router();

// Small hand-rolled concurrency pool: runs `worker` over `items` with at
// most `limit` in flight at once. No new dependency needed for this.
async function runPool(items, limit, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

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

    // Response headers already went out with archive.pipe(res)'s first
    // flush, so a mid-stream error can't be turned into a clean error
    // response — the finally below is what guarantees the temp dir is
    // cleaned up regardless (throw, client abort, or normal completion).
    const tmpDir = await mkdtemp(join(tmpdir(), 'puma-export-'));
    let aborted = false;
    res.on('close', () => { aborted = true; });

    try {
      const manifest = [];
      const exportable = [];
      for (const videoId of videoIds) {
        if (aborted) break;
        if (!(await videoStore.exists(videoId))) continue;

        const info = await videoStore.getInfo(videoId);
        manifest.push({
          videoId,
          title: info?.title,
          source: info?.source || 'youtube',
          mediaKind: info?.mediaKind || 'video',
          duration: info?.duration,
        });

        const opusPath = videoStore.getAudioFilePath(videoId);
        archive.file(opusPath, { name: `audio/${videoId}.opus` });

        exportable.push({ videoId, opusPath });
      }

      // Bounded-concurrency WAV transcodes: entries land in the zip in
      // completion order rather than strict sequential order, which is
      // harmless since zip entry order isn't semantic.
      await runPool(exportable, 2, async ({ videoId, opusPath }) => {
        if (aborted) return;
        const wavPath = join(tmpDir, `${videoId}.wav`);
        const ok = await ffmpegToWav(opusPath, wavPath);
        if (ok && !aborted) {
          archive.file(wavPath, { name: `audio/${videoId}.wav` });
        }
      });

      archive.append(JSON.stringify(manifest, null, 2), { name: 'media.json' });
      await archive.finalize();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to export session:', err.message);
    // archive.pipe(res) may have already flushed headers before this throws
    // (e.g. mkdtemp failing mid-stream) -- calling res.json() at that point
    // would throw ERR_HTTP_HEADERS_SENT as an unhandled rejection.
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.destroy(err);
    }
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
