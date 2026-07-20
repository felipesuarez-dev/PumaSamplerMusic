import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidMediaId } from '../utils/validation.js';

// video-store.js resolves its storage location from ../utils/config.js,
// which reads process.env.DATA_DIR at MODULE LOAD TIME (mkdirSync side
// effect on import). Same isolation pattern as session-store.test.js: set
// DATA_DIR before dynamically importing config.js/video-store.js, since a
// static import would already run with the wrong DATA_DIR.
let tmpDataDir;
let videoStore;

before(async () => {
  tmpDataDir = await mkdtemp(join(tmpdir(), 'puma-videostore-'));
  process.env.DATA_DIR = tmpDataDir;

  videoStore = await import('./video-store.js');
});

after(async () => {
  await rm(tmpDataDir, { recursive: true, force: true });
});

test('generateLocalId returns an 11-char id matching isValidMediaId', async () => {
  const id = await videoStore.generateLocalId();
  assert.equal(typeof id, 'string');
  assert.equal(id.length, 11);
  assert.equal(isValidMediaId(id), true);
});

test('generateLocalId returns distinct ids across repeated calls', async () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    ids.add(await videoStore.generateLocalId());
  }
  assert.equal(ids.size, 20);
});

test('saveInfo passes through source/mediaKind when provided', async () => {
  const info = await videoStore.saveInfo('localAudio1', {
    title: 'My Upload',
    duration: 12.5,
    sizeBytes: 4096,
    source: 'local',
    mediaKind: 'audio',
  });

  assert.equal(info.source, 'local');
  assert.equal(info.mediaKind, 'audio');

  const reloaded = await videoStore.getInfo('localAudio1');
  assert.equal(reloaded.source, 'local');
  assert.equal(reloaded.mediaKind, 'audio');
});

test('saveInfo defaults source to youtube and mediaKind to video when omitted', async () => {
  const info = await videoStore.saveInfo('ytVideoId1', {
    title: 'A YouTube video',
    duration: 30,
    sizeBytes: 1024,
  });

  assert.equal(info.source, 'youtube');
  assert.equal(info.mediaKind, 'video');
});
