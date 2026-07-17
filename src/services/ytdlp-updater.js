import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from '../utils/config.js';

// The container runs as `node` (uid 1000): system site-packages are not
// writable, but /home/node is. Since src/ is bind-mounted (no rebuild), the
// only way to keep yt-dlp fresh without a new image is a --user pip install
// under this path.
const USER_YTDLP_BIN = '/home/node/.local/bin/yt-dlp';

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Returns the path to the freshest available yt-dlp binary. Every download
// spawns a new process, so once the updater installs a newer binary here it
// is picked up automatically without a server restart.
export function getYtDlpBin() {
  return existsSync(USER_YTDLP_BIN) ? USER_YTDLP_BIN : 'yt-dlp';
}

// Non-blocking, non-fatal, log-only: a failed update must never affect the
// download path, which always falls back to whatever binary is present.
export function updateYtDlp() {
  const pipArgs = ['-m', 'pip', 'install', '--user', '--break-system-packages', '-U'];
  if (config.ytdlpChannel === 'nightly') {
    pipArgs.push('--pre', 'yt-dlp[default]');
  } else {
    pipArgs.push('yt-dlp');
  }

  const proc = spawn('python3', pipArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  proc.stdout.on('data', () => {
    // Discard: this is a background maintenance task, not user-facing.
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('close', (code) => {
    if (code === 0) {
      console.log(`yt-dlp auto-update completed (channel: ${config.ytdlpChannel})`);
    } else {
      console.warn(`yt-dlp auto-update exited with code ${code}: ${stderr.trim()}`);
    }
  });

  proc.on('error', (err) => {
    console.warn('yt-dlp auto-update failed to start:', err.message);
  });
}

// Runs once at boot, then every 24h. A yt-dlp installed with --user still
// discovers the system bgutil plugin (yt_dlp_plugins is a PEP-420 namespace
// package; the user-site path merges into the system python's sys.path), so
// PO-token support is preserved across updates.
export function startYtDlpAutoUpdate() {
  updateYtDlp();
  const interval = setInterval(updateYtDlp, UPDATE_INTERVAL_MS);
  interval.unref();
}
