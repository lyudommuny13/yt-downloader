import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { Telegram } from 'telegraf';

import { createJobQueue } from './src/lib/job-queue.js';
import { logger } from './src/lib/logger.js';
import { createHealthServer } from './src/telemetry/health-server.js';
import { createBot } from './src/services/telegram-bot.service.js';
import { config, assertConfig } from './src/config/index.js';
import { createDownloadJobProcessor } from './src/services/download-job.processor.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

async function main() {
  assertConfig();

  const telegram = new Telegram(config.telegramBotToken);
  const jobQueue = await createJobQueue({
    queueName: process.env.DOWNLOAD_QUEUE_NAME || 'download_jobs',
    concurrency: config.maxConcurrentDownloads,
    databaseUrl: config.databaseUrl,
    processor: createDownloadJobProcessor({
      telegram,
      downloadDirectory: config.downloadDirectory,
    }),
    attempts: config.jobMaxAttempts,
    backoffDelayMs: config.jobRetryDelayMs,
  });

  const bot = createBot({ jobQueue });
  let botRunning = false;
  const healthServer = createHealthServer({
    port: config.port,
    jobQueue,
    isBotRunning: () => botRunning,
  });

  try {
    await bot.launch();
    botRunning = true;
    logger.info('Telegram bot started.');
  } catch (error) {
    await jobQueue.close();
    healthServer.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    botRunning = false;
    logger.info('Shutting down application.');

    await bot.stop();
    await new Promise((resolve) => healthServer.close(resolve));
    await jobQueue.close();
  };

  process.once('SIGINT', () => shutdown().catch((error) => {
    logger.error('Shutdown failed.', { error: error.message });
    process.exitCode = 1;
  }));
  process.once('SIGTERM', () => shutdown().catch((error) => {
    logger.error('Shutdown failed.', { error: error.message });
    process.exitCode = 1;
  }));
}

main().catch((error) => {
  logger.error('Application failed to start.', { error: error.message });
  process.exitCode = 1;
});
