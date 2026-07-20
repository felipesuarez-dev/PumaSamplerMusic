import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import express from 'express';

// sessions.js -> session-store.js/video-store.js -> config.js reads
// process.env.DATA_DIR at MODULE LOAD TIME. Same isolation pattern as the
// other *.test.js files in this repo: set DATA_DIR before dynamically
// importing config.js and everything downstream of it.
let tmpDataDir;
let workDir;
let videoStore;
let sessionStore;
let server;
let baseUrl;

const VIDEO_ID = 'fixtureOpus'; // 11 chars, matches isValidMediaId shape

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

before(async () => {
  tmpDataDir = await mkdtemp(join(tmpdir(), 'puma-export-test-'));
  process.env.DATA_DIR = tmpDataDir;

  videoStore = await import('../services/video-store.js');
  sessionStore = await import('../services/session-store.js');
  const { default: sessionsRouter } = await import('./sessions.js');

  const opusPath = videoStore.getAudioFilePath(VIDEO_ID);
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.3', '-c:a', 'libopus', opusPath]);
  const sizeBytes = (await stat(opusPath)).size;

  await videoStore.saveInfo(VIDEO_ID, {
    title: 'Fixture Track',
    duration: 0.3,
    sizeBytes,
    source: 'local',
    mediaKind: 'audio',
  });

  await sessionStore.save({
    name: 'export-test-session',
    pads: [{ position: 1, key: 'a', start: 0, end: 0.3, videoId: VIDEO_ID }],
  });

  const app = express();
  app.use('/api/sessions', sessionsRouter);
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  workDir = await mkdtemp(join(tmpdir(), 'puma-export-test-work-'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tmpDataDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

test('GET /:name/export produces a zip with session.json, media.json, opus and wav', async () => {
  const res = await fetch(`${baseUrl}/api/sessions/export-test-session/export`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const zipPath = join(workDir, 'export.zip');
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(zipPath, buffer);

  const listing = await run('unzip', ['-l', zipPath]);
  assert.match(listing, /session\.json/);
  assert.match(listing, /media\.json/);
  assert.match(listing, new RegExp(`audio/${VIDEO_ID}\\.opus`));
  assert.match(listing, new RegExp(`audio/${VIDEO_ID}\\.wav`));

  const manifestRaw = await run('unzip', ['-p', zipPath, 'media.json']);
  const manifest = JSON.parse(manifestRaw);
  assert.deepEqual(manifest, [{
    videoId: VIDEO_ID,
    title: 'Fixture Track',
    source: 'local',
    mediaKind: 'audio',
    duration: 0.3,
  }]);
});
