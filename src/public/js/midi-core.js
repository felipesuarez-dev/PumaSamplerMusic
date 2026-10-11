// Pure MIDI logic for the controller integration: message parsing, note/CC
// mapping and value scaling. No browser APIs and no DOM live here, so the
// whole decision-making surface is unit-testable (same split as
// turntable-core.js vs. the AudioWorklet wrapper). The Web MIDI adapter in
// midi.js only moves bytes in and events out; app.js only wires callbacks.

const MAX_PADS = 27;

// Web MIDI hands over complete messages (running status is resolved by the
// browser), so data[0] always carries the full status byte. Anything that is
// not a note or CC (clock, active sensing, pitch bend, program change, sysex,
// poly aftertouch...) returns null and is ignored by the caller.
export function parseMidiMessage(data) {
  if (!data || data.length < 2) return null;
  const status = data[0] & 0xf0;
  const channel = (data[0] & 0x0f) + 1;

  if (status === 0x90 && data.length >= 3) {
    const note = data[1] & 0x7f;
    const velocity = data[2] & 0x7f;
    // Velocity-0 note-on is the standard stand-in for note-off.
    if (velocity === 0) return { type: 'noteoff', note, velocity: 0, channel };
    return { type: 'noteon', note, velocity, channel };
  }
  if (status === 0x80 && data.length >= 3) {
    return { type: 'noteoff', note: data[1] & 0x7f, velocity: data[2] & 0x7f, channel };
  }
  if (status === 0xb0 && data.length >= 3) {
    return { type: 'cc', controller: data[1] & 0x7f, value: data[2] & 0x7f, channel };
  }
  return null;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Repo-wide convention (shared with the exporters): MIDI 36 = C1.
export function noteName(note) {
  const n = Number.isInteger(note) ? Math.max(0, Math.min(127, note)) : 0;
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
}

// --- Note mapping (pad position -> MIDI note) ------------------------------

// One note drives one pad and one pad holds one note: binding a note that is
// already taken moves it, mirroring how learn gestures are expected to feel.
export function bindNote(mapping, position, note) {
  const next = new Map(mapping);
  for (const [pos, bound] of next) {
    if (bound === note) next.delete(pos);
  }
  next.set(position, note);
  return next;
}

export function unbindNote(mapping, position) {
  const next = new Map(mapping);
  next.delete(position);
  return next;
}

export function positionForNote(mapping, note) {
  for (const [position, bound] of mapping) {
    if (bound === note) return position;
  }
  return null;
}

// --- CC mapping (parameter id -> MIDI CC) ----------------------------------

// Same one-to-one discipline as notes: a CC drives a single parameter.
export function bindCc(mapping, targetId, cc) {
  const next = new Map(mapping);
  for (const [id, bound] of next) {
    if (bound === cc) next.delete(id);
  }
  next.set(targetId, cc);
  return next;
}

export function unbindCc(mapping, targetId) {
  const next = new Map(mapping);
  next.delete(targetId);
  return next;
}

export function targetForCc(mapping, cc) {
  for (const [targetId, bound] of mapping) {
    if (bound === cc) return targetId;
  }
  return null;
}

// --- Persistence (localStorage JSON) ---------------------------------------

export function serializeMapping(mapping) {
  return JSON.stringify(Object.fromEntries(mapping));
}

function parseMappingJson(json) {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Malformed storage is never fatal: invalid entries are dropped and the map
// comes back (possibly empty). Duplicate notes/CCs keep the first seen, which
// is what the stable sort by position/id below makes deterministic.
export function deserializeNoteMapping(json) {
  const raw = parseMappingJson(json);
  const map = new Map();
  const usedNotes = new Set();
  if (!raw) return map;

  for (const [key, value] of Object.entries(raw)) {
    const position = Number(key);
    if (!Number.isInteger(position) || position < 1 || position > MAX_PADS) continue;
    if (!Number.isInteger(value) || value < 0 || value > 127) continue;
    if (usedNotes.has(value)) continue;
    usedNotes.add(value);
    map.set(position, value);
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

export function deserializeCcMapping(json) {
  const raw = parseMappingJson(json);
  const map = new Map();
  const usedCcs = new Set();
  if (!raw) return map;

  for (const [targetId, value] of Object.entries(raw)) {
    if (typeof targetId !== 'string' || targetId.length === 0) continue;
    if (!Number.isInteger(value) || value < 0 || value > 127) continue;
    if (usedCcs.has(value)) continue;
    usedCcs.add(value);
    map.set(targetId, value);
  }
  return map;
}

// --- Value scaling ----------------------------------------------------------

function snapToStep(value, min, max, step) {
  const s = Number.isFinite(step) && step > 0 ? step : 1;
  const snapped = Math.round((value - min) / s) * s + min;
  const clamped = Math.max(min, Math.min(max, snapped));
  // toFixed(6)+Number strips float dust (0.30000000000000004) without changing
  // any legitimate value at the step resolutions the knobs actually use.
  return Number(clamped.toFixed(6));
}

// Absolute CC (0..127) -> the input's own range, snapped to its step.
export function scaleCc(value, min, max, step) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(127, value)) : 0;
  return snapToStep(min + (v / 127) * (max - min), min, max, step);
}

// Soft-takeover helper for absolute knobs: did the knob's raw value cross the
// parameter's current position since its previous message? The app only starts
// applying an absolute CC once this returns true (or the knob lands exactly on
// the value), so a knob parked far away — or a bank switch that re-sends
// positions — can never slam a parameter.
export function ccCrossed(lastCc, currentCc, value) {
  if (lastCc == null) return false;
  return (lastCc < currentCc && value >= currentCc) || (lastCc > currentCc && value <= currentCc);
}

// Akai-style "Rel" endless encoders send two's-complement deltas: 1..63 is
// +1..+63, 65..127 is -63..-1, 0/64 mean no movement. The MPK manual does not
// document the wire format; the modal's activity monitor exposes the raw CC
// values, so a controller using another convention is visible at a glance.
export function ccDelta(raw) {
  const v = Number.isFinite(raw) ? Math.max(0, Math.min(127, raw)) : 0;
  if (v === 0 || v === 64) return 0;
  return v < 64 ? v : v - 128;
}

// Relative turn applied to the input's CURRENT value: one encoder tick moves
// the parameter by 1/127 of its full range, then snaps/clamps like absolute.
export function applyCcDelta(current, delta, min, max, step) {
  const base = Number.isFinite(current) ? current : min;
  const next = base + (delta * (max - min)) / 127;
  return snapToStep(next, min, max, step);
}
