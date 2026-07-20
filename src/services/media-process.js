import { spawn } from 'node:child_process';

// Shared spawn plumbing for ffprobe/ffmpeg child processes. Callers keep
// their own success/failure interpretation (exit code checks, JSON parsing,
// etc.) — this only wires stdio and collects stdout/stderr.
export function runMediaProcess(cmd, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] });
    let stdout = '';
    let stderr = '';

    if (captureStdout) proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => reject(err));
  });
}
