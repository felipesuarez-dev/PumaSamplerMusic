import { readFile } from 'node:fs/promises';
import * as videoStore from '../video-store.js';
import { sanitizeFilename, readmeFor } from './common.js';
import { sliceFramesByVideo, EXPORT_SAMPLE_RATE } from './slice-cutter.js';
import { addCuePoints } from './wav-cue.js';

// Shared builder for the FL Studio and Logic exports: one full-length WAV per
// source with the chop boundaries embedded as RIFF cue markers. Fruity Slicer 2
// and Logic's Quick Sampler read those markers as slice points on import.
export async function buildSlicedWavBundle({ session, archive, getFullWavs, daw }) {
  const fullWavs = await getFullWavs();
  const framesByVideo = sliceFramesByVideo(session, EXPORT_SAMPLE_RATE);

  for (const wav of fullWavs) {
    const buffer = await readFile(wav.path);
    const positions = framesByVideo.get(wav.videoId) || [];
    const withCues = addCuePoints(buffer, positions);
    const info = await videoStore.getInfo(wav.videoId);
    const base = sanitizeFilename(info?.title || wav.videoId);
    archive.append(withCues, { name: `${base}-${wav.videoId}.wav` });
  }

  archive.append(readmeFor(daw, 'the WAV files (slice markers embedded)'), { name: 'README.txt' });
}
