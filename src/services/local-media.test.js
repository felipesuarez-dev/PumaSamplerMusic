import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// local-media.js -> video-store.js -> config.js reads process.env.DATA_DIR
// at MODULE LOAD TIME. Same isolation pattern used by session-store.test.js
// and video-store.test.js: set DATA_DIR before dynamically importing.
let tmpDataDir;
let fixturesDir;
let localMedia;
let videoStore;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg fixture generation exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

before(async () => {
  tmpDataDir = await mkdtemp(join(tmpdir(), 'puma-localmedia-'));
  process.env.DATA_DIR = tmpDataDir;

  localMedia = await import('./local-media.js');
  videoStore = await import('./video-store.js');

  fixturesDir = await mkdtemp(join(tmpdir(), 'puma-localmedia-fixtures-'));
});

after(async () => {
  await rm(tmpDataDir, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

test('ffmpegToWav transcodes a real opus fixture to wav', async () => {
  const opusPath = join(fixturesDir, 'silence.opus');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.3', '-c:a', 'libopus', opusPath]);

  const wavPath = join(fixturesDir, 'silence-out.wav');
  const ok = await localMedia.ffmpegToWav(opusPath, wavPath);

  assert.equal(ok, true);
  const stats = await stat(wavPath);
  assert.ok(stats.size > 0);
});

test('ffmpegToWav resolves false (never throws) for a nonexistent input', async () => {
  const ok = await localMedia.ffmpegToWav(
    join(fixturesDir, 'does-not-exist.opus'),
    join(fixturesDir, 'unused-out.wav'),
  );
  assert.equal(ok, false);
});

test('processUpload finalizes an audio-only upload with source/mediaKind local/audio', async () => {
  const videoId = await videoStore.generateLocalId();
  const tempDir = videoStore.getTempDirectory(videoId);
  const tempFilePath = join(tempDir, 'source.opus');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(tempDir, { recursive: true }));
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.3', '-c:a', 'libopus', tempFilePath]);

  const info = await localMedia.processUpload({ videoId, tempFilePath, originalName: 'my-drum-loop.opus' });

  assert.equal(info.source, 'local');
  assert.equal(info.mediaKind, 'audio');
  assert.equal(info.title, 'my-drum-loop');
  assert.equal(await videoStore.exists(videoId), true);
});

test('processUpload rejects a video with no audio stream and cleans up the temp dir', async () => {
  const videoId = await videoStore.generateLocalId();
  const tempDir = videoStore.getTempDirectory(videoId);
  const tempFilePath = join(tempDir, 'source.mp4');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(tempDir, { recursive: true }));
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1', '-t', '0.2', '-an', '-c:v', 'libx264', tempFilePath,
  ]);

  await assert.rejects(
    () => localMedia.processUpload({ videoId, tempFilePath, originalName: 'silent-clip.mp4' }),
    (err) => err instanceof localMedia.NoAudioStreamError,
  );

  assert.equal(await videoStore.exists(videoId), false);
  await assert.rejects(() => stat(tempDir));
});
