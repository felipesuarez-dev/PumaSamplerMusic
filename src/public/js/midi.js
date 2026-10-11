// Web MIDI adapter: device access, selection, the learn state machine and the
// event fan-out the app and the modal subscribe to. All decision-making lives
// in midi-core.js; this file only talks to the browser API and localStorage
// (no DOM, no audio). Preferences are environment config, not session data,
// so they persist under puma-midi-* keys like the app's other local settings.

import {
  parseMidiMessage,
  bindNote,
  unbindNote,
  bindCc,
  unbindCc,
  serializeMapping,
  deserializeNoteMapping,
  deserializeCcMapping,
} from './midi-core.js';

const NOTE_MAPPING_STORAGE = 'puma-midi-mapping';
const CC_MAPPING_STORAGE = 'puma-midi-cc';
const DEVICE_STORAGE = 'puma-midi-device';
const KNOB_MODE_STORAGE = 'puma-midi-knob-mode';
const AUTO_SELECT_STORAGE = 'puma-midi-autoselect';

function read(storageKey) {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function write(storageKey, value) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // Private mode / quota: preferences just don't persist, nothing to break.
  }
}

export function createMidiController() {
  let access = null;
  let status = 'idle'; // idle | requesting | ready | denied | unsupported | insecure
  let selectedInput = null;
  let noteMapping = deserializeNoteMapping(read(NOTE_MAPPING_STORAGE));
  let ccMapping = deserializeCcMapping(read(CC_MAPPING_STORAGE));
  let learn = null; // { type: 'note', position } | { type: 'cc', targetId }
  const listeners = new Map(); // event type -> Set<handler>

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type)?.delete(handler);
  }

  function emit(type, payload) {
    const handlers = listeners.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(payload);
  }

  function setStatus(next) {
    status = next;
    emit('status', next);
  }

  // Truthful failure modes, same spirit as the turntable's secure-context
  // message: an insecure page loses the whole [SecureContext] API, and blaming
  // the browser would send the user looking in the wrong place.
  function detectSupport() {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      return (typeof window !== 'undefined' && window.isSecureContext === false) ? 'insecure' : 'unsupported';
    }
    return null;
  }

  async function init() {
    const support = detectSupport();
    if (support) {
      setStatus(support);
      return status;
    }
    if (access) return status;
    if (status === 'requesting') return status;

    setStatus('requesting');
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      // NotAllowedError (permission denied) and SecurityError (blocked by
      // policy) both surface as denied; the console keeps the raw reason.
      console.warn('[midi] requestMIDIAccess failed:', err);
      setStatus('denied');
      return status;
    }

    access.onstatechange = () => {
      // Unplugging the selected port drops its object; clearing it here lets
      // autoSelectInput pick it back up (by id/name) when it reconnects — or
      // pick the only remaining port when nothing was ever saved.
      if (selectedInput && selectedInput.state === 'disconnected') {
        selectedInput.onmidimessage = null;
        selectedInput = null;
      }
      if (!selectedInput) autoSelectInput();
      emit('devices');
    };

    setStatus('ready');
    autoSelectInput();
    return status;
  }

  function listInputs() {
    if (!access) return [];
    return [...access.inputs.values()].map((input) => ({
      id: input.id,
      name: input.name || input.manufacturer || input.id,
      state: input.state,
    }));
  }

  // `persist` distinguishes a real choice from a convenience fallback: the
  // saved device preference must only be written by an explicit pick (the
  // modal) or by a match against the saved id/name — never by the "only input
  // around" fallback, which would overwrite the configured controller with an
  // unrelated device.
  function selectInput(id, { persist = true } = {}) {
    if (selectedInput) selectedInput.onmidimessage = null;
    const port = access ? access.inputs.get(id) : null;
    selectedInput = port || null;
    if (selectedInput) {
      selectedInput.onmidimessage = handleMessage;
      if (persist) {
        write(DEVICE_STORAGE, JSON.stringify({ id: selectedInput.id, name: selectedInput.name || '' }));
      }
    }
    emit('devices');
  }

  function loadSavedDevice() {
    try {
      const parsed = JSON.parse(read(DEVICE_STORAGE));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  // Reconnect preference: exact port id, then same name (ids can change when
  // the OS re-enumerates). The "only input around" convenience applies ONLY on
  // a fresh setup (nothing saved): with a saved device missing, selecting an
  // unrelated controller would let it drive the sampler uninvited — the user
  // can still pick it in the modal, and autoConnect's strict match below is
  // what decides whether the saved controller "came back".
  function autoSelectInput() {
    if (!access) return;
    const saved = loadSavedDevice();
    const byId = saved?.id ? access.inputs.get(saved.id) : null;
    const byName = !byId && saved?.name
      ? [...access.inputs.values()].find((input) => input.name === saved.name)
      : null;
    const match = byId || byName;
    if (match) {
      selectInput(match.id);
      return;
    }
    const hasSaved = Boolean(saved?.id || saved?.name);
    const only = !hasSaved && access.inputs.size === 1 ? [...access.inputs.values()][0] : null;
    if (only) selectInput(only.id, { persist: false });
    else emit('devices');
  }

  function handleMessage(event) {
    const message = parseMidiMessage(event.data);
    if (!message) return;

    if (message.type === 'cc' && learn?.type === 'cc') {
      ccMapping = bindCc(ccMapping, learn.targetId, message.controller);
      write(CC_MAPPING_STORAGE, serializeMapping(ccMapping));
      const bound = { ...learn, cc: message.controller };
      learn = null;
      emit('learn', bound);
      emit('mapping');
      emit('activity', message);
      return;
    }

    if (message.type === 'noteon' && learn?.type === 'note') {
      noteMapping = bindNote(noteMapping, learn.position, message.note);
      write(NOTE_MAPPING_STORAGE, serializeMapping(noteMapping));
      const bound = { ...learn, note: message.note };
      learn = null;
      emit('learn', bound);
      emit('mapping');
      emit('activity', message);
      return;
    }

    if (message.type === 'noteon') emit('noteon', message);
    else if (message.type === 'noteoff') emit('noteoff', message);
    else if (message.type === 'cc') emit('cc', message);
    emit('activity', message);
  }

  function startNoteLearn(position) {
    learn = { type: 'note', position };
    emit('learn', learn);
  }

  function startCcLearn(targetId) {
    learn = { type: 'cc', targetId };
    emit('learn', learn);
  }

  function cancelLearn() {
    if (!learn) return;
    learn = null;
    emit('learn', null);
  }

  // --- Auto-reconnect on load -------------------------------------------------

  // Permission probe that NEVER prompts: the Permissions API reports the state
  // of the 'midi' permission without opening a dialog. Browsers that don't
  // know the name throw, which is treated as "not granted" — the modal stays
  // the one place that asks for MIDI access.
  async function permissionGranted() {
    if (!navigator.permissions?.query) return false;
    try {
      const result = await navigator.permissions.query({ name: 'midi' });
      return result.state === 'granted';
    } catch {
      return false;
    }
  }

  // Load-time reconnect for the previously configured controller. Resolves to
  // the connected device ({ id, name }) ONLY when the live port actually
  // matches the saved device (by id, or by name when the OS re-enumerated it);
  // null otherwise — no saved device, permission not granted yet (opening the
  // app must never pop a dialog), or no matching device present.
  //
  // The strict match matters: autoSelectInput's "only input around" fallback
  // would otherwise let any unrelated single device masquerade as the saved
  // controller and fire the "previously configured controller connected"
  // toast (and this must never lie).
  async function autoConnect() {
    const saved = loadSavedDevice();
    if (!saved || (!saved.id && !saved.name)) return null;
    if (!(await permissionGranted())) return null;
    if ((await init()) !== 'ready') return null;
    const port = selectedInput;
    if (!port || port.state !== 'connected') return null;
    const isSavedDevice = (saved.id && port.id === saved.id) || (saved.name && port.name === saved.name);
    if (!isSavedDevice) return null;
    return { id: port.id, name: port.name || port.id };
  }

  function persistNotes() {
    write(NOTE_MAPPING_STORAGE, serializeMapping(noteMapping));
    emit('mapping');
  }

  function persistCcs() {
    write(CC_MAPPING_STORAGE, serializeMapping(ccMapping));
    emit('mapping');
  }

  return {
    init,
    autoConnect,
    on,
    getStatus: () => status,
    listInputs,
    selectInput,
    getSelectedInputId: () => (selectedInput ? selectedInput.id : null),

    getNoteMapping: () => new Map(noteMapping),
    bindNote(position, note) {
      noteMapping = bindNote(noteMapping, position, note);
      persistNotes();
    },
    unbindNote(position) {
      noteMapping = unbindNote(noteMapping, position);
      persistNotes();
    },
    clearNotes() {
      noteMapping = new Map();
      persistNotes();
    },

    getCcMapping: () => new Map(ccMapping),
    bindCc(targetId, cc) {
      ccMapping = bindCc(ccMapping, targetId, cc);
      persistCcs();
    },
    unbindCc(targetId) {
      ccMapping = unbindCc(ccMapping, targetId);
      persistCcs();
    },
    clearCcs() {
      ccMapping = new Map();
      persistCcs();
    },

    startNoteLearn,
    startCcLearn,
    cancelLearn,
    getLearn: () => (learn ? { ...learn } : null),

    getKnobMode: () => (read(KNOB_MODE_STORAGE) === 'rel' ? 'rel' : 'abs'),
    setKnobMode(mode) {
      write(KNOB_MODE_STORAGE, mode === 'rel' ? 'rel' : 'abs');
    },

    getAutoSelect: () => read(AUTO_SELECT_STORAGE) !== 'false',
    setAutoSelect(enabled) {
      write(AUTO_SELECT_STORAGE, String(Boolean(enabled)));
    },
  };
}
