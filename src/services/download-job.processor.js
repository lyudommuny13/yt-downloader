import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { isPermanentJobError, PermanentJobError } from '../lib/job-errors.js';
import { metrics } from '../telemetry/metrics.js';
import {
  buildSafeFileName,
  ensureDownloadDirectory,
} from '../utils.js';
import {
  convertAudioToMp3,
  downloadAudioOnly,
  downloadMp4Video,
} from './downloader.service.js';

function createStatusUpdater(telegram, job) {
  let lastReportedPercent = -10;

  return async (label, percent) => {
    const reportPercent = Math.min(100, Math.floor(percent / 10) * 10);
    if (reportPercent < lastReportedPercent + 10) return;
    lastReportedPercent = reportPercent;
    await job.updateProgress(reportPercent);

    try {
      await telegram.editMessageText(
        job.data.chatId,
        job.data.statusMessageId,
        undefined,
        `${label} ${reportPercent}%`,
      );
    } catch (error) {
      logger.debug('Unable to update job progress message.', {
        jobId: job.id,
        error: error.message,
      });
    }
  };
}

async function sendMedia(send) {
  try {
    return await send();
  } catch (error) {
    if ([400, 403].includes(error.response?.error_code)) {
      throw new PermanentJobError(error.message, {
        cause: error,
        userMessage: '❌ Telegram could not deliver this file. Please check that the bot can message you and try another download.',
      });
    }
    throw error;
  }
}

export function createDownloadJobProcessor({ telegram, downloadDirectory }) {
  return async (job) => {
    const startedAt = process.hrtime.bigint();
    const { chatId, statusMessageId, fileType, option, url, title, duration } = job.data;
    ensureDownloadDirectory(downloadDirectory);

    const jobDirectory = fs.mkdtempSync(path.join(downloadDirectory, 'job-'));
    const outputPath = path.join(jobDirectory, buildSafeFileName(title, fileType));
    const audioPath = path.join(jobDirectory, 'audio-source.webm');
    let deliveredOutputPath = outputPath;
    const updateProgress = createStatusUpdater(telegram, job);

    try {
      if (fileType === 'mp4') {
        deliveredOutputPath = await downloadMp4Video({
          url,
          outputPath,
          option,
          onProgress: (percent) => {
            void updateProgress('📥 Downloading Video...', percent).catch((error) => {
              logger.warn('Unable to persist download progress.', { jobId: job.id, error: error.message });
            });
          },
        });

        await telegram.editMessageText(chatId, statusMessageId, undefined, '📤 Uploading MP4 to Telegram...');
        await sendMedia(() => telegram.sendVideo(chatId, { source: deliveredOutputPath }));
      } else {
        deliveredOutputPath = await downloadAudioOnly({
          url,
          outputPath: audioPath,
          onProgress: (percent) => {
            void updateProgress('📥 Pulling Audio...', percent).catch((error) => {
              logger.warn('Unable to persist download progress.', { jobId: job.id, error: error.message });
            });
          },
        });

        await telegram.editMessageText(chatId, statusMessageId, undefined, '🎛️ Converting audio...');
        deliveredOutputPath = await convertAudioToMp3({
          inputPath: deliveredOutputPath,
          outputPath,
          title,
          bitrateKbps: option,
        });

        await telegram.editMessageText(chatId, statusMessageId, undefined, '📤 Uploading MP3 to Telegram...');
        await sendMedia(() => telegram.sendAudio(chatId, { source: deliveredOutputPath }, { title, duration }));
      }

      await telegram.editMessageText(chatId, statusMessageId, undefined, '✅ Download complete.')
        .catch((error) => {
          logger.debug('Unable to update completed job message.', {
            jobId: job.id,
            error: error.message,
          });
        });
      metrics.jobDuration.observe(
        { format: fileType, result: 'success' },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
      return { delivered: true };
    } catch (error) {
      metrics.jobDuration.observe(
        { format: fileType, result: 'failure' },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );

      if (isPermanentJobError(error) || job.attemptsMade >= (job.opts.attempts || 1)) {
        await telegram.sendMessage(
          chatId,
          error.userMessage
            || '❌ The download could not be completed after several attempts. Please try again later.',
        ).catch((notifyError) => {
          logger.warn('Unable to send terminal job failure notice.', {
            jobId: job.id,
            error: notifyError.message,
          });
        });
      }

      throw error;
    } finally {
      try {
        fs.rmSync(jobDirectory, { recursive: true, force: true });
      } catch (error) {
        logger.warn('Unable to remove a download working directory.', {
          jobId: job.id,
          directory: jobDirectory,
          error: error.message,
        });
      }
    }
  };
}
