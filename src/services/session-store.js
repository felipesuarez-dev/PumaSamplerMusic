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

const DEFAULT_MASTER_FX = {
  volume: 1,
  cutoff: 100,
  resonance: 0.1,
  reverb: 0,
  delayTime: 250,
  delayFeedback: 0,
};

const PAD_FX_DEFAULTS = {
  pitch: 0,
  cutoff: 100,
  resonance: 0.1,
  reverbSend: 0,
  delaySend: 0,
  pitchShiftOn: true,
  stretchOn: false,
  speed: 100,
  pan: 0,
  drive: 0,
};

export async function load(name) {
  const path = getSessionPath(name);
  try {
    await access(path);
    const content = await readFile(path, 'utf8');
    const session = JSON.parse(content);

    if (!session.masterFx || (session.schemaVersion || 1) < 2) {
      session.masterFx = { ...DEFAULT_MASTER_FX, ...session.masterFx };
    }

    session.pads = (session.pads || []).map((pad) => ({ ...PAD_FX_DEFAULTS, ...pad }));

    return session;
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
    ...session,
    createdAt: session.createdAt || now,
    updatedAt: now,
    schemaVersion: 2,
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
