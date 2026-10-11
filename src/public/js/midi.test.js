import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fake browser environment installed BEFORE midi.js is imported (its
// controller reads localStorage synchronously at construction, and every test
// builds a fresh controller against the fake Web MIDI access below).
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

let inputs = new Map();
let requestCalls = 0;
const access = { inputs, onstatechange: null };
globalThis.window = { isSecureContext: true };
Object.defineProperty(globalThis, 'navigator', {
  value: {
    requestMIDIAccess: async () => {
      requestCalls += 1;
      return access;
    },
    permissions: { query: async () => ({ state: 'granted' }) },
  },
  configurable: true,
});

const { createMidiController } = await import('./midi.js');
const { positionForNote, targetForCc } = await import('./midi-core.js');

const MPK = { id: 'mpk', name: 'MPK mini IV' };

function resetBrowser({ devices = [], savedDevice = null, permissionState = 'granted' } = {}) {
  store.clear();
  if (savedDevice) store.set('puma-midi-device', JSON.stringify(savedDevice));
  inputs = new Map(devices.map((device) => [device.id, { ...device, onmidimessage: null }]));
  access.inputs = inputs;
  access.onstatechange = null;
  requestCalls = 0;
  navigator.permissions.query = async () => ({ state: permissionState });
}

function send(bytes) {
  const [, port] = [...inputs.entries()].find(([, input]) => input.onmidimessage) || [];
  assert.ok(port, 'no input is bound to receive messages');
  port.onmidimessage({ data: new Uint8Array(bytes) });
}

test('autoConnect: announces the saved controller when it is connected', async () => {
  resetBrowser({
    devices: [{ ...MPK, state: 'connected' }],
    savedDevice: MPK,
  });
  assert.deepEqual(await createMidiController().autoConnect(), { id: 'mpk', name: 'MPK mini IV' });
});

test('autoConnect: an unrelated single input never masquerades as the saved controller', async () => {
  resetBrowser({
    devices: [{ id: 'other', name: 'Random Synth', state: 'connected' }],
    savedDevice: MPK,
  });
  const midi = createMidiController();
  assert.equal(await midi.autoConnect(), null);
  // And nothing was bound or overwritten: the preference is intact and the
  // stranger is not selected (a stray controller must not drive the sampler).
  assert.deepEqual(JSON.parse(store.get('puma-midi-device')), MPK);
  assert.equal(midi.getSelectedInputId(), null);
});

test('autoConnect: nothing saved means nothing to announce', async () => {
  resetBrowser({ devices: [{ ...MPK, state: 'connected' }] });
  assert.equal(await createMidiController().autoConnect(), null);
});

test('autoConnect: without granted permission it resolves to null and never prompts', async () => {
  resetBrowser({
    devices: [{ ...MPK, state: 'connected' }],
    savedDevice: MPK,
    permissionState: 'prompt',
  });
  assert.equal(await createMidiController().autoConnect(), null);
  assert.equal(requestCalls, 0); // opening the app must never dialog
});

test('autoConnect: a re-enumerated id is matched by name and the id is refreshed', async () => {
  resetBrowser({
    devices: [{ id: 'mpk-new', name: 'MPK mini IV', state: 'connected' }],
    savedDevice: { id: 'mpk-old', name: 'MPK mini IV' },
  });
  assert.deepEqual(await createMidiController().autoConnect(), { id: 'mpk-new', name: 'MPK mini IV' });
  assert.deepEqual(JSON.parse(store.get('puma-midi-device')), { id: 'mpk-new', name: 'MPK mini IV' });
});

test('autoConnect: a disconnected saved port is not announced', async () => {
  resetBrowser({
    devices: [{ ...MPK, state: 'disconnected' }],
    savedDevice: MPK,
  });
  assert.equal(await createMidiController().autoConnect(), null);
});

test('note learn: binds the next note-on and persists the mapping', async () => {
  resetBrowser({ devices: [{ ...MPK, state: 'connected' }], savedDevice: MPK });
  const midi = createMidiController();
  await midi.init();
  midi.startNoteLearn(5);
  send([0x90, 36, 100]);
  assert.equal(midi.getNoteMapping().get(5), 36);
  assert.equal(positionForNote(midi.getNoteMapping(), 36), 5);
  assert.deepEqual(JSON.parse(store.get('puma-midi-mapping')), { 5: 36 });
});

test('cc learn: binds the next CC to the armed target and persists it', async () => {
  resetBrowser({ devices: [{ ...MPK, state: 'connected' }], savedDevice: MPK });
  const midi = createMidiController();
  await midi.init();
  midi.startCcLearn('pad-fx-cutoff');
  send([0xb0, 74, 64]);
  assert.equal(midi.getCcMapping().get('pad-fx-cutoff'), 74);
  assert.equal(targetForCc(midi.getCcMapping(), 74), 'pad-fx-cutoff');
  assert.deepEqual(JSON.parse(store.get('puma-midi-cc')), { 'pad-fx-cutoff': 74 });
});
