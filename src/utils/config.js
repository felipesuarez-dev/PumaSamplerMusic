import { env } from 'node:process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const port = parseInt(env.PORT || '4070', 10);
const dataDir = env.DATA_DIR || '/data';
const maxCacheGb = parseFloat(env.MAX_CACHE_GB || '10');
const maxConcurrentDownloads = parseInt(env.MAX_CONCURRENT_DOWNLOADS || '2', 10);

const videosDir = join(dataDir, 'videos');
const sessionsDir = join(dataDir, 'sessions');

[videosDir, sessionsDir].forEach((dir) => {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`Failed to create directory ${dir}:`, err.message);
    throw err;
  }
});

export const config = {
  port,
  host: env.HOST || '0.0.0.0',
  dataDir,
  videosDir,
  sessionsDir,
  maxCacheBytes: Math.floor(maxCacheGb * 1024 * 1024 * 1024),
  maxConcurrentDownloads,
  nodeEnv: env.NODE_ENV || 'development',
  allowedHosts: (env.ALLOWED_HOSTS || '').split(',').filter(Boolean),
  cookiesFile: env.COOKIES_FILE || '',
  potProviderUrl: env.POT_PROVIDER_URL || '',
};
