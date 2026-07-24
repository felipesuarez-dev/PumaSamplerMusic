import { Router } from 'express';
import archiver from 'archiver';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSession, sanitizeFilename } from '../utils/validation.js';
import * as sessionStore from '../services/session-store.js';
import { getExporter, DEFAULT_EXPORTER } from '../services/exporters/registry.js';
import { cutPadSlices, fullTrackWavs, EXPORT_SAMPLE_RATE } from '../services/exporters/slice-cutter.js';

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
  const format = typeof req.query.format === 'string' ? req.query.format : DEFAULT_EXPORTER;
  const exporter = getExporter(format);
  if (!exporter) {
    return res.status(400).json({ error: `Unknown export format: ${format}` });
  }

  try {
    const session = await sessionStore.load(name);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const ext = exporter.ext || 'zip';
    const filename = `${sanitizeFilename(name)}.${ext}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Failed to export session:', err.message);
      res.status(500).end();
    });
    archive.pipe(res);

    // Response headers already went out with archive.pipe(res)'s first flush,
    // so a mid-stream error can't be turned into a clean error response — the
    // finally below is what guarantees the temp dir is cleaned up regardless
    // (throw, client abort, or normal completion).
    const tmpDir = await mkdtemp(join(tmpdir(), 'puma-export-'));
    let aborted = false;
    res.on('close', () => { aborted = true; });
    const isAborted = () => aborted;

    // The per-slice cuts and full-track WAV transcodes are the expensive shared
    // inputs. Each format only pulls the one it needs, and both are memoized so
    // repeated getSlices()/getFullWavs() calls within one build never re-run
    // ffmpeg.
    let slicesPromise = null;
    let fullWavsPromise = null;
    const getSlices = () => (slicesPromise ??= cutPadSlices(session, tmpDir, { sampleRate: EXPORT_SAMPLE_RATE, isAborted }));
    const getFullWavs = () => (fullWavsPromise ??= fullTrackWavs(session, tmpDir, { sampleRate: EXPORT_SAMPLE_RATE, isAborted }));

    try {
      await exporter.build({
        session,
        archive,
        tmpDir,
        sampleRate: EXPORT_SAMPLE_RATE,
        isAborted,
        getSlices,
        getFullWavs,
      });
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
