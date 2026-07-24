import packageZip from './package-zip.js';
import pss from './pss.js';
import sfz from './sfz.js';
import decentsampler from './decentsampler.js';
import mpc from './mpc-xpm.js';
import fl from './fl-slicer.js';
import logic from './logic-quicksampler.js';
import ableton from './ableton-adv.js';

// Order here is the order the client menu renders. 'package' is the default
// (the original session package). Everything after is opt-in.
const EXPORTERS = [packageZip, pss, sfz, decentsampler, mpc, fl, ableton, logic];
const byId = new Map(EXPORTERS.map((exporter) => [exporter.id, exporter]));

export const DEFAULT_EXPORTER = 'package';

export function getExporter(id) {
  return byId.get(id) || null;
}

export function listExporterIds() {
  return EXPORTERS.map((exporter) => exporter.id);
}
