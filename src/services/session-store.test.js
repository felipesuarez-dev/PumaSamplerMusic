import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// session-store.js resolves its storage location from ../utils/config.js,
// which reads process.env.DATA_DIR (defaulting to '/data') at MODULE LOAD
// TIME (it calls mkdirSync synchronously as a side effect of import). To
// keep this test isolated from the real data/ directory, we set DATA_DIR to
// a throwaway temp dir *before* dynamically importing config.js/session-store.js.
// Static `import` statements are hoisted above any code in this file, so a
// static import would already run config.js with the wrong DATA_DIR — hence
// the dynamic `import()` calls inside `before()`.
let tmpDataDir;
let config;
let sessionStore;

before(async () => {
  tmpDataDir = await mkdtemp(join(tmpdir(), 'puma-sessions-'));
  process.env.DATA_DIR = tmpDataDir;

  ({ config } = await import('../utils/config.js'));
  sessionStore = await import('./session-store.js');
});

after(async () => {
  await rm(tmpDataDir, { recursive: true, force: true });
});

test('save/load round-trip preserves pads and stamps schemaVersion 2', async () => {
  const pads = [
    { id: 1, videoId: 'abc123', start: 0.5, end: 2.5 },
    { id: 2, videoId: 'def456', start: 0, end: 1 },
  ];

  const saved = await sessionStore.save({ name: 'roundtrip-session', pads });
  assert.equal(saved.schemaVersion, 2);

  const loaded = await sessionStore.load('roundtrip-session');
  assert.deepEqual(loaded.pads, pads);
  assert.equal(loaded.schemaVersion, 2);
});

test('load migrates a schemaVersion 1 session with no masterFx to a full default masterFx', async () => {
  const legacyPath = join(config.sessionsDir, 'legacy-session.json');
  const legacySession = {
    name: 'legacy-session',
    pads: [],
    schemaVersion: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    // no masterFx field on purpose
  };
  await writeFile(legacyPath, JSON.stringify(legacySession), 'utf8');

  const loaded = await sessionStore.load('legacy-session');

  assert.deepEqual(loaded.masterFx, {
    volume: 1,
    cutoff: 100,
    resonance: 0.1,
    reverb: 0,
    delayTime: 250,
    delayFeedback: 0,
  });
});
