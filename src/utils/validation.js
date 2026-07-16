const YOUTUBE_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
  /^https?:\/\/(www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /^https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/,
];

export function extractYouTubeId(url) {
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[match.length - 1];
  }
  return null;
}

export function isValidYouTubeUrl(url) {
  return extractYouTubeId(url) !== null;
}

export function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 30) {
    return false;
  }
  // Allow single keys (q, 1, Enter, Space) or combinations (shift+a, ctrl+enter)
  return /^[\w\[\]\\;',./`~-]+(\+[\w\[\]\\;',./`~-]+)?$/i.test(key);
}

const MAX_PADS = 27;

export function validateSession(session) {
  const errors = [];

  if (!session || typeof session !== 'object') {
    return ['Session must be an object'];
  }

  if (!session.name || typeof session.name !== 'string' || session.name.trim().length === 0) {
    errors.push('Session name is required');
  }

  if (!Array.isArray(session.pads)) {
    errors.push('Pads must be an array');
    return errors;
  }

  if (session.pads.length > MAX_PADS) {
    errors.push(`Maximum ${MAX_PADS} pads allowed`);
  }

  const usedPositions = new Set();
  const usedKeys = new Set();

  for (const pad of session.pads) {
    if (!pad || typeof pad !== 'object') {
      errors.push('Each pad must be an object');
      continue;
    }

    if (typeof pad.position !== 'number' || pad.position < 1 || pad.position > MAX_PADS) {
      errors.push(`Pad position must be between 1 and ${MAX_PADS}`);
    } else if (usedPositions.has(pad.position)) {
      errors.push(`Duplicate pad position: ${pad.position}`);
    } else {
      usedPositions.add(pad.position);
    }

    if (!validateKey(pad.key)) {
      errors.push(`Invalid key for pad ${pad.position || '?'}: ${pad.key}`);
    } else if (usedKeys.has(pad.key.toLowerCase())) {
      errors.push(`Duplicate key: ${pad.key}`);
    } else {
      usedKeys.add(pad.key.toLowerCase());
    }

    if (typeof pad.start !== 'number' || pad.start < 0) {
      errors.push(`Invalid start time for pad ${pad.position || '?'}`);
    }

    if (typeof pad.end !== 'number' || pad.end <= pad.start) {
      errors.push(`Invalid end time for pad ${pad.position || '?'} (must be > start)`);
    }

    if (!pad.videoId || typeof pad.videoId !== 'string') {
      errors.push(`videoId is required for pad ${pad.position || '?'}`);
    }
  }

  return errors;
}
