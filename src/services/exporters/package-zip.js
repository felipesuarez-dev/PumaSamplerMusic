import { join } from 'node:path';
import * as videoStore from '../video-store.js';
import { ffmpegToWav } from '../local-media.js';
import { runPool } from './common.js';

// The original session package (renamed "PumaSampler Session Package" in the UI):
// session.json + each source's opus + a WAV transcode + a media.json manifest.
// This is the behaviour that previously lived inline in routes/sessions.js,
// moved here unchanged so every format goes through the same exporter contract.
export function buildManifestEntry(videoId, info) {
  return {
    videoId,
    title: info?.title,
    source: info?.source || 'youtube',
    mediaKind: info?.mediaKind || 'video',
    duration: info?.duration,
  };
}

export default {
  id: 'package',
  ext: 'zip',
  async build({ session, archive, tmpDir, isAborted }) {
    archive.append(JSON.stringify(session, null, 2), { name: 'session.json' });

    const videoIds = [...new Set((session.pads || []).map((p) => p.videoId).filter(Boolean))];
    const manifest = [];
    const exportable = [];
    for (const videoId of videoIds) {
      if (isAborted()) break;
      if (!(await videoStore.exists(videoId))) continue;
      const info = await videoStore.getInfo(videoId);
      manifest.push(buildManifestEntry(videoId, info));
      archive.file(videoStore.getAudioFilePath(videoId), { name: `audio/${videoId}.opus` });
      exportable.push({ videoId });
    }

    const wavPaths = new Map();
    await runPool(exportable, 2, async ({ videoId }) => {
      if (isAborted()) return;
      const wavPath = join(tmpDir, `${videoId}.wav`);
      const ok = await ffmpegToWav(videoStore.getAudioFilePath(videoId), wavPath);
      if (ok && !isAborted()) wavPaths.set(videoId, wavPath);
    });
    for (const { videoId } of exportable) {
      const wavPath = wavPaths.get(videoId);
      if (wavPath) archive.file(wavPath, { name: `audio/${videoId}.wav` });
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: 'media.json' });
  },
};
