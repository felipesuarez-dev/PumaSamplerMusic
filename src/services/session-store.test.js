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
  assert.deepEqual(loaded.pads, pads.map((p) => ({
    pitch: 0, cutoff: 100, resonance: 0.1, reverbSend: 0, delaySend: 0,
    pitchShiftOn: true, stretchOn: false, speed: 100, ...p,
  })));
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

test('load fills PAD_FX_DEFAULTS on a legacy pad with no FX fields', async () => {
  const legacyPath = join(config.sessionsDir, 'legacy-pad-session.json');
  const legacySession = {
    name: 'legacy-pad-session',
    pads: [{ position: 1, videoId: 'abc12345678', start: 0, end: 1 }],
    schemaVersion: 2,
  };
  await writeFile(legacyPath, JSON.stringify(legacySession), 'utf8');

  const loaded = await sessionStore.load('legacy-pad-session');

  assert.deepEqual(loaded.pads[0], {
    position: 1,
    videoId: 'abc12345678',
    start: 0,
    end: 1,
    pitch: 0,
    cutoff: 100,
    resonance: 0.1,
    reverbSend: 0,
    delaySend: 0,
    pitchShiftOn: true,
    stretchOn: false,
    speed: 100,
  });
});

test('load preserves an already-saved per-pad FX value instead of overwriting it', async () => {
  const path = join(config.sessionsDir, 'pad-fx-saved-session.json');
  const session = {
    name: 'pad-fx-saved-session',
    pads: [{ position: 1, videoId: 'abc12345678', start: 0, end: 1, pitch: 5 }],
    schemaVersion: 2,
  };
  await writeFile(path, JSON.stringify(session), 'utf8');

  const loaded = await sessionStore.load('pad-fx-saved-session');

  assert.equal(loaded.pads[0].pitch, 5);
});

test('load fills pitchShiftOn/stretchOn/speed defaults on a legacy pad with no stretch fields', async () => {
  const legacyPath = join(config.sessionsDir, 'legacy-stretch-session.json');
  const legacySession = {
    name: 'legacy-stretch-session',
    pads: [{ position: 1, videoId: 'abc12345678', start: 0, end: 1 }],
    schemaVersion: 2,
  };
  await writeFile(legacyPath, JSON.stringify(legacySession), 'utf8');

  const loaded = await sessionStore.load('legacy-stretch-session');

  assert.equal(loaded.pads[0].pitchShiftOn, true);
  assert.equal(loaded.pads[0].stretchOn, false);
  assert.equal(loaded.pads[0].speed, 100);
});

test('load preserves already-saved pitchShiftOn/stretchOn/speed values instead of overwriting them', async () => {
  const path = join(config.sessionsDir, 'stretch-saved-session.json');
  const session = {
    name: 'stretch-saved-session',
    pads: [{
      position: 1, videoId: 'abc12345678', start: 0, end: 1,
      pitchShiftOn: false, stretchOn: true, speed: 150,
    }],
    schemaVersion: 2,
  };
  await writeFile(path, JSON.stringify(session), 'utf8');

  const loaded = await sessionStore.load('stretch-saved-session');

  assert.equal(loaded.pads[0].pitchShiftOn, false);
  assert.equal(loaded.pads[0].stretchOn, true);
  assert.equal(loaded.pads[0].speed, 150);
});
