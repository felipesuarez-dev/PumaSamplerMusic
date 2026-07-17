const MAX_LOGS = 500;
const buffer = [];

function push(level, args) {
  const message = args
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
  buffer.push({ level, message, timestamp: Date.now() });
  if (buffer.length > MAX_LOGS) buffer.shift();
}

// Wraps console methods once at startup so every existing console.log/warn/error
// call across the app also lands in an in-memory ring buffer, without having
// to thread a logger through every module that already logs directly.
export function installConsoleCapture() {
  const original = { log: console.log, warn: console.warn, error: console.error };

  console.log = (...args) => {
    push('info', args);
    original.log(...args);
  };
  console.warn = (...args) => {
    push('warn', args);
    original.warn(...args);
  };
  console.error = (...args) => {
    push('error', args);
    original.error(...args);
  };
}

export function getRecentLogs() {
  return [...buffer];
}
