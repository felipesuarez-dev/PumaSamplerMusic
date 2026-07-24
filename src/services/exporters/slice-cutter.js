import { join } from 'node:path';
import { runMediaProcess } from '../media-process.js';
import * as videoStore from '../video-store.js';
import { runPool } from './common.js';

// Fixed export format: 44.1 kHz / 16-bit stereo. Because the rate is fixed and
// known, slice frame offsets are simply round(seconds * sampleRate) -- the
// persisted session only stores seconds, never a sample rate.
export const EXPORT_SAMPLE_RATE = 44100;

function padSlices(session) {
  return (session.pads || []).filter(
    (p) => p.videoId
      && Number.isFinite(p.start)
      && Number.isFinite(p.end)
      && p.end > p.start,
  );
}

// Cuts one pad's [start, end] region to a 16-bit stereo WAV. `-ss` is placed
// AFTER `-i` (accurate seek: ffmpeg decodes then trims) rather than before it
// (fast but imprecise on lossy opus) -- slices are short, so accuracy wins.
async function cutOne(opusPath, start, end, outPath, sampleRate) {
  const duration = Math.max(0, end - start);
  const { code } = await runMediaProcess('ffmpeg', [
    '-y', '-i', opusPath,
    '-ss', String(start), '-t', String(duration),
    '-ar', String(sampleRate), '-ac', '2', '-sample_fmt', 's16',
    outPath,
  ]);
  return code === 0;
}

// Cuts every assignable pad to its own WAV under tmpDir. Returns entries in
// stable pad order (completion order can differ under concurrency), each with
// the sample-frame offsets a DAW/sampler format needs. Pads whose source media
// no longer exists on disk are skipped.
export async function cutPadSlices(session, tmpDir, { sampleRate = EXPORT_SAMPLE_RATE, isAborted } = {}) {
  const slices = padSlices(session);
  const entries = slices.map((pad, index) => ({
    pad,
    index,
    filename: `pad-${String(index + 1).padStart(2, '0')}.wav`,
  }));

  const done = [];
  await runPool(entries, 2, async (entry) => {
    if (isAborted && isAborted()) return;
    if (!(await videoStore.exists(entry.pad.videoId))) return;
    const opusPath = videoStore.getAudioFilePath(entry.pad.videoId);
    const outPath = join(tmpDir, entry.filename);
    const ok = await cutOne(opusPath, entry.pad.start, entry.pad.end, outPath, sampleRate);
    if (!ok) return;
    done.push({
      ...entry,
      path: outPath,
      videoId: entry.pad.videoId,
      frameCount: Math.round((entry.pad.end - entry.pad.start) * sampleRate),
      sampleRate,
    });
  });

  done.sort((a, b) => a.index - b.index);
  return done;
}

// Transcodes each distinct source to a single full-length WAV (used by the
// FL/Logic sliced-WAV exporters, which embed cue markers instead of cutting).
export async function fullTrackWavs(session, tmpDir, { sampleRate = EXPORT_SAMPLE_RATE, isAborted } = {}) {
  const videoIds = [...new Set((session.pads || []).map((p) => p.videoId).filter(Boolean))];
  const results = [];
  await runPool(videoIds, 2, async (videoId) => {
    if (isAborted && isAborted()) return;
    if (!(await videoStore.exists(videoId))) return;
    const opusPath = videoStore.getAudioFilePath(videoId);
    const outPath = join(tmpDir, `full-${videoId}.wav`);
    const { code } = await runMediaProcess('ffmpeg', [
      '-y', '-i', opusPath,
      '-ar', String(sampleRate), '-ac', '2', '-sample_fmt', 's16',
      outPath,
    ]);
    if (code === 0) results.push({ videoId, path: outPath, sampleRate });
  });
  return results;
}

// Slice boundary sample offsets per source video, for cue-point injection.
// Uses each pad's start (and the last pad's end) so a DAW slicer lands markers
// where the user's chops are.
export function sliceFramesByVideo(session, sampleRate = EXPORT_SAMPLE_RATE) {
  const byVideo = new Map();
  for (const pad of padSlices(session)) {
    if (!byVideo.has(pad.videoId)) byVideo.set(pad.videoId, new Set());
    byVideo.get(pad.videoId).add(Math.round(pad.start * sampleRate));
    byVideo.get(pad.videoId).add(Math.round(pad.end * sampleRate));
  }
  const out = new Map();
  for (const [videoId, set] of byVideo) {
    out.set(videoId, [...set].sort((a, b) => a - b));
  }
  return out;
}
