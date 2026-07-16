import { readFile, writeFile, readdir, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../utils/config.js';

const SESSION_EXT = '.json';

function getSessionPath(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(config.sessionsDir, `${safeName}${SESSION_EXT}`);
}

export async function list() {
  try {
    const entries = await readdir(config.sessionsDir);
    const sessions = [];

    for (const entry of entries) {
      if (!entry.endsWith(SESSION_EXT)) continue;
      const name = entry.slice(0, -SESSION_EXT.length);
      const content = await readFile(join(config.sessionsDir, entry), 'utf8');
      try {
        const session = JSON.parse(content);
        sessions.push({
          name,
          createdAt: session.createdAt || null,
          updatedAt: session.updatedAt || null,
          padCount: Array.isArray(session.pads) ? session.pads.length : 0,
        });
      } catch {
        sessions.push({ name, invalid: true });
      }
    }

    return sessions.sort((a, b) => {
      const aTime = b.updatedAt || b.createdAt || '';
      const bTime = a.updatedAt || a.createdAt || '';
      return aTime.localeCompare(bTime);
    });
  } catch (err) {
    console.error('Failed to list sessions:', err.message);
    return [];
  }
}

export async function load(name) {
  const path = getSessionPath(name);
  try {
    await access(path);
    const content = await readFile(path, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function save(session) {
  const path = getSessionPath(session.name);
  const now = new Date().toISOString();

  const normalized = {
    schemaVersion: 1,
    ...session,
    createdAt: session.createdAt || now,
    updatedAt: now,
  };

  await writeFile(path, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export async function remove(name) {
  const path = getSessionPath(name);
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

export async function findByVideoId(videoId) {
  const sessions = await list();
  const affected = [];

  for (const { name } of sessions) {
    const session = await load(name);
    if (!session) continue;
    const hasReference = (session.pads || []).some((pad) => pad.videoId === videoId);
    if (hasReference) {
      affected.push(name);
    }
  }

  return affected;
}
