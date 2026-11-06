import 'dotenv/config';

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  databaseUrl: process.env.DATABASE_URL || '',
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000),
  downloadDirectory: process.env.DOWNLOAD_DIRECTORY || './downloads',
  sessionStoreFile: process.env.SESSION_STORE_FILE || './data/sessions.json',
  maxConcurrentDownloads: Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 10),
  port: Number(process.env.PORT || 3000),
  jobMaxAttempts: Number(process.env.JOB_MAX_ATTEMPTS || 3),
  jobRetryDelayMs: Number(process.env.JOB_RETRY_DELAY_MS || 5000),
};

export function assertConfig() {
  if (!config.telegramBotToken) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN in environment variables.');
  }

  if (!config.databaseUrl) {
    throw new Error('Missing DATABASE_URL in environment variables.');
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(config.databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
  }

  if (!Number.isFinite(config.sessionTtlMs) || config.sessionTtlMs <= 0) {
    throw new Error('SESSION_TTL_MS must be a positive number.');
  }

  if (!Number.isInteger(config.maxConcurrentDownloads) || config.maxConcurrentDownloads < 1) {
    throw new Error('MAX_CONCURRENT_DOWNLOADS must be a positive integer.');
  }

  if (!Number.isInteger(config.rateLimitWindowMs) || config.rateLimitWindowMs < 1) {
    throw new Error('RATE_LIMIT_WINDOW_MS must be a positive integer.');
  }

  if (!Number.isInteger(config.rateLimitMaxRequests) || config.rateLimitMaxRequests < 1) {
    throw new Error('RATE_LIMIT_MAX_REQUESTS must be a positive integer.');
  }

  if (!Number.isInteger(config.jobMaxAttempts) || config.jobMaxAttempts < 1) {
    throw new Error('JOB_MAX_ATTEMPTS must be a positive integer.');
  }

  if (!Number.isFinite(config.jobRetryDelayMs) || config.jobRetryDelayMs < 0) {
    throw new Error('JOB_RETRY_DELAY_MS must be zero or a positive number.');
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
}
