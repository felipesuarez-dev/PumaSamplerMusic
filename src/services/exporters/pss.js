import * as videoStore from '../video-store.js';
import { buildManifestEntry } from './package-zip.js';

// Native PumaSampler Session (.pss): a compact, re-importable bundle -- the same
// zip container the app's import reader already understands (session.json +
// audio/<id>.opus + media.json), minus the WAV transcodes the general package
// carries for DAW drag-and-drop. Meant for round-tripping a session back into
// PumaSampler, so opus (the app's own source format) is enough.
export default {
  id: 'pss',
  ext: 'pss',
  async build({ session, archive, isAborted }) {
    archive.append(JSON.stringify(session, null, 2), { name: 'session.json' });

    const videoIds = [...new Set((session.pads || []).map((p) => p.videoId).filter(Boolean))];
    const manifest = [];
    for (const videoId of videoIds) {
      if (isAborted()) break;
      if (!(await videoStore.exists(videoId))) continue;
      const info = await videoStore.getInfo(videoId);
      manifest.push(buildManifestEntry(videoId, info));
      archive.file(videoStore.getAudioFilePath(videoId), { name: `audio/${videoId}.opus` });
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'media.json' });
  },
};
