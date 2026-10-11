import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMidiMessage,
  noteName,
  bindNote,
  unbindNote,
  positionForNote,
  bindCc,
  unbindCc,
  targetForCc,
  serializeMapping,
  deserializeNoteMapping,
  deserializeCcMapping,
  scaleCc,
  ccDelta,
  applyCcDelta,
  ccCrossed,
} from './midi-core.js';

// --- parseMidiMessage -------------------------------------------------------

test('parseMidiMessage: note-on with velocity carries note and channel', () => {
  assert.deepEqual(parseMidiMessage([0x90, 36, 100]), { type: 'noteon', note: 36, velocity: 100, channel: 1 });
  assert.deepEqual(parseMidiMessage([0x9f, 43, 1]), { type: 'noteon', note: 43, velocity: 1, channel: 16 });
});

test('parseMidiMessage: note-on with velocity 0 is a note-off', () => {
  assert.deepEqual(parseMidiMessage([0x90, 36, 0]), { type: 'noteoff', note: 36, velocity: 0, channel: 1 });
});

test('parseMidiMessage: explicit note-off status', () => {
  assert.deepEqual(parseMidiMessage([0x82, 48, 64]), { type: 'noteoff', note: 48, velocity: 64, channel: 3 });
});

test('parseMidiMessage: CC carries controller and value', () => {
  assert.deepEqual(parseMidiMessage([0xb0, 70, 127]), { type: 'cc', controller: 70, value: 127, channel: 1 });
  assert.deepEqual(parseMidiMessage([0xb5, 7, 0]), { type: 'cc', controller: 7, value: 0, channel: 6 });
});

test('parseMidiMessage: ignores everything that is not a note or CC', () => {
  assert.equal(parseMidiMessage([0xf8]), null); // clock
  assert.equal(parseMidiMessage([0xfe]), null); // active sensing
  assert.equal(parseMidiMessage([0xf0, 0x7e, 0x00]), null); // sysex
  assert.equal(parseMidiMessage([0xe0, 0x00, 0x40]), null); // pitch bend
  assert.equal(parseMidiMessage([0xc0, 5]), null); // program change
  assert.equal(parseMidiMessage([0xa0, 60, 100]), null); // poly aftertouch
  assert.equal(parseMidiMessage([0x90, 36]), null); // truncated note-on
  assert.equal(parseMidiMessage(null), null);
  assert.equal(parseMidiMessage([]), null);
});

test('parseMidiMessage: masks off the high bit of data bytes', () => {
  // Some devices send data bytes beyond 0x7f; masking keeps them in range.
  assert.deepEqual(parseMidiMessage([0x90, 0x80 | 36, 0x80 | 100]), { type: 'noteon', note: 36, velocity: 100, channel: 1 });
});

// --- noteName ---------------------------------------------------------------

test('noteName: uses the repo convention where MIDI 36 is C1', () => {
  assert.equal(noteName(36), 'C1');
  assert.equal(noteName(39), 'D#1');
  assert.equal(noteName(43), 'G1');
  assert.equal(noteName(48), 'C2');
  assert.equal(noteName(60), 'C3');
});

// --- note mapping -----------------------------------------------------------

test('bindNote: adding, replacing and moving a note between pads', () => {
  let map = new Map();
  map = bindNote(map, 1, 36);
  map = bindNote(map, 2, 37);
  assert.deepEqual([...map.entries()], [[1, 36], [2, 37]]);

  // Rebinding note 36 to pad 3 frees pad 1 (one note = one pad).
  map = bindNote(map, 3, 36);
  assert.equal(map.has(1), false);
  assert.equal(map.get(3), 36);

  // Rebinding pad 3 to a new note replaces its old value.
  map = bindNote(map, 3, 50);
  assert.equal(map.get(3), 50);
  assert.equal(positionForNote(map, 36), null);
});

test('unbindNote/positionForNote: pad and reverse lookups', () => {
  let map = bindNote(new Map(), 5, 40);
  assert.equal(positionForNote(map, 40), 5);
  assert.equal(positionForNote(map, 41), null);
  map = unbindNote(map, 5);
  assert.equal(map.size, 0);
  assert.equal(unbindNote(map, 99).size, 0);
});

test('bindNote: returns a new map, never mutating the input', () => {
  const original = new Map([[1, 36]]);
  const next = bindNote(original, 2, 37);
  assert.equal(original.size, 1);
  assert.equal(next.size, 2);
});

// --- CC mapping -------------------------------------------------------------

test('bindCc: a CC drives a single parameter and rebinding frees the old one', () => {
  let map = new Map();
  map = bindCc(map, 'master-volume', 70);
  map = bindCc(map, 'pad-fx-cutoff', 71);
  assert.equal(map.get('master-volume'), 70);

  // Moving CC 70 to another target removes it from the first.
  map = bindCc(map, 'pad-fx-cutoff', 70);
  assert.equal(map.has('master-volume'), false);
  assert.equal(targetForCc(map, 70), 'pad-fx-cutoff');
  assert.equal(targetForCc(map, 71), null);
  assert.equal(targetForCc(map, 99), null);
});

test('unbindCc: removing a target leaves the rest untouched', () => {
  const map = bindCc(bindCc(new Map(), 'a', 1), 'b', 2);
  const next = unbindCc(map, 'a');
  assert.equal(next.has('a'), false);
  assert.equal(next.get('b'), 2);
  assert.equal(map.size, 2); // input not mutated
});

// --- serialization ----------------------------------------------------------

test('serializeMapping: produces a stable JSON object', () => {
  const map = new Map([[1, 36], [3, 40]]);
  assert.equal(serializeMapping(map), '{"1":36,"3":40}');
  assert.equal(serializeMapping(new Map()), '{}');
});

test('deserializeNoteMapping: round-trips a valid mapping', () => {
  const map = new Map([[2, 37], [1, 36]]);
  const restored = deserializeNoteMapping(serializeMapping(map));
  assert.deepEqual([...restored.entries()], [[1, 36], [2, 37]]); // sorted by position
});

test('deserializeNoteMapping: drops invalid, duplicate and out-of-range entries', () => {
  const json = JSON.stringify({
    '1': 36,
    '2': 36, // duplicate note -> dropped (first wins)
    '3': 500, // note out of range
    '0': 40, // position below 1
    '28': 41, // position above MAX_PADS
    'x': 42, // non-numeric position
    '4': 'foo', // non-numeric note
  });
  assert.deepEqual([...deserializeNoteMapping(json).entries()], [[1, 36]]);
});

test('deserialize*: malformed or missing JSON returns an empty map', () => {
  assert.equal(deserializeNoteMapping('not json').size, 0);
  assert.equal(deserializeNoteMapping(null).size, 0);
  assert.equal(deserializeNoteMapping('[]').size, 0);
  assert.equal(deserializeNoteMapping('"str"').size, 0);
  assert.equal(deserializeCcMapping('not json').size, 0);
  assert.equal(deserializeCcMapping(null).size, 0);
});

test('deserializeCcMapping: validates target ids and CC range, dedupes CCs', () => {
  const json = JSON.stringify({
    'master-volume': 70,
    'pad-fx-cutoff': 70, // duplicate CC -> dropped (first wins)
    'pad-fx-drive': 200, // CC out of range
    '': 74, // empty target id
    'pad-fx-pan': 74,
  });
  const map = deserializeCcMapping(json);
  assert.equal(map.size, 2);
  assert.equal(map.get('master-volume'), 70);
  assert.equal(map.get('pad-fx-pan'), 74);
});

// --- scaling ----------------------------------------------------------------

test('scaleCc: maps the 0..127 sweep onto the input range', () => {
  assert.equal(scaleCc(0, 0, 2, 0.01), 0);
  assert.equal(scaleCc(127, 0, 2, 0.01), 2);
  assert.equal(scaleCc(0, -12, 12, 1), -12);
  assert.equal(scaleCc(127, -12, 12, 1), 12);
});

test('scaleCc: snaps to the step, clamps out-of-range CC values and cleans float dust', () => {
  // 64/127*100 = 50.39... -> step 1 snaps to 50.
  assert.equal(scaleCc(64, 0, 100, 1), 50);
  // Resonance-style range: 0.1 + (1/127)*19.9 = 0.256... -> step 0.1 snaps to 0.3.
  assert.equal(scaleCc(1, 0.1, 20, 0.1), 0.3);
  // Attack-style step.
  assert.equal(scaleCc(64, 0, 2000, 10), 1010);
  // Out-of-range CC values clamp to the ends.
  assert.equal(scaleCc(200, 0, 100, 1), 100);
  assert.equal(scaleCc(-5, 0, 100, 1), 0);
});

test('ccDelta: two-complement relative deltas', () => {
  assert.equal(ccDelta(0), 0);
  assert.equal(ccDelta(1), 1);
  assert.equal(ccDelta(63), 63);
  assert.equal(ccDelta(64), 0);
  assert.equal(ccDelta(65), -63);
  assert.equal(ccDelta(127), -1);
});

test('ccCrossed: detects an upward and downward crossing of the current position', () => {
  assert.equal(ccCrossed(40, 50, 55), true); // swept up past the parameter
  assert.equal(ccCrossed(60, 50, 45), true); // swept down past it
  assert.equal(ccCrossed(60, 50, 55), false); // still above — not picked up yet
  assert.equal(ccCrossed(40, 50, 45), false); // still below
  assert.equal(ccCrossed(null, 50, 55), false); // first message never engages
  // Landing exactly on the value is not a "crossing": the app latches it via
  // the snapped-value match instead (next === current) before this matters.
  assert.equal(ccCrossed(50, 50, 51), false);
});

test('applyCcDelta: moves from the current value, clamped and snapped', () => {
  assert.equal(applyCcDelta(100, 1, 50, 200, 1), 101);
  assert.equal(applyCcDelta(100, -1, 50, 200, 1), 99);
  assert.equal(applyCcDelta(50, -5, 50, 200, 1), 50);
  assert.equal(applyCcDelta(200, 5, 50, 200, 1), 200);
  assert.equal(applyCcDelta(0, 0, 0, 2, 0.01), 0);
});
