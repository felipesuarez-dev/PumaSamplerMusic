import { Router } from 'express';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '../utils/config.js';

const router = Router();

function isValidCookiesContent(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return false;
  }
  return content.startsWith('# Netscape') || /youtube\.com/.test(content);
}

router.get('/cookies', (_req, res) => {
  const configured = Boolean(config.cookiesFile) && existsSync(config.cookiesFile);
  res.json({ configured });
});

router.post('/cookies', async (req, res) => {
  const { content } = req.body || {};

  if (!isValidCookiesContent(content)) {
    return res.status(400).json({ error: 'Invalid cookies format. Paste the exported cookies.txt content.' });
  }

  if (!config.cookiesFile) {
    return res.status(500).json({ error: 'COOKIES_FILE is not configured on the server' });
  }

  try {
    await writeFile(config.cookiesFile, content, { mode: 0o600 });
    res.json({ configured: true });
  } catch (err) {
    console.error('Failed to save cookies file:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/cookies', async (_req, res) => {
  try {
    if (config.cookiesFile) {
      await unlink(config.cookiesFile);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to delete cookies file:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ configured: false });
});

export default router;
