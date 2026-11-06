import fs from 'fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import youtubedl from 'youtube-dl-exec';

import { PermanentJobError } from '../lib/job-errors.js';
import { MAX_TELEGRAM_FILE_SIZE_BYTES, sanitizeTitle } from '../utils.js';

const ytDlp = youtubedl.create(
  process.env.YT_DLP_PATH || youtubedl.constants.YOUTUBE_DL_PATH,
);

export function getYtDlpOutputTemplate(outputPath) {
  const parsedPath = path.parse(outputPath);
  return path.join(parsedPath.dir, `${parsedPath.name}.%(ext)s`);
}

export function findYtDlpOutput(outputTemplate, expectedExtension) {
  const parsedTemplate = path.parse(outputTemplate);
  const outputPrefix = parsedTemplate.name.replace(/%\([^)]+\)s$/, '');
  const outputDirectory = parsedTemplate.dir || '.';
  const candidates = fs.readdirSync(outputDirectory)
    .filter((fileName) => fileName.startsWith(`${outputPrefix}.`))
    .filter((fileName) => !/\.(?:part|ytdl)$/i.test(fileName))
    .filter((fileName) => !expectedExtension || path.extname(fileName).toLowerCase() === `.${expectedExtension}`)
    .map((fileName) => path.join(outputDirectory, fileName))
    .filter((filePath) => fs.statSync(filePath).isFile());

  if (candidates.length !== 1) {
    throw new Error(`Expected one completed download for "${outputPrefix}", found ${candidates.length}.`);
  }

  return candidates[0];
}

export function getMp4FormatSelector(option) {
  return option === 'highest'
    ? 'bestvideo[ext=mp4][filesize<=49M]+bestaudio[ext=m4a]/best[ext=mp4][filesize<=49M]/best[ext=mp4]/best'
    : 'worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst';
}

export function withYtDlpDiagnostics(error) {
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const message = stderr
    ? `${error.message}\nyt-dlp stderr:\n${stderr.slice(-4000)}`
    : error.message;

  if (/ERROR:\s*(?:\[[^\]]+\]\s*)?Unsupported URL:/i.test(message)) {
    return new PermanentJobError(message, {
      cause: error,
      userMessage: '❌ This link is not supported. Please send a link to a supported video.',
    });
  }

  if (/ERROR:\s*(?:\[[^\]]+\]\s*)?(?:Private video|Video unavailable|This video is unavailable|This video is no longer available|has been removed|not available in your country)/i.test(message)) {
    return new PermanentJobError(message, {
      cause: error,
      userMessage: '❌ This video is private or unavailable. Please check the link or choose another video.',
    });
  }

  if (/ERROR:\s*(?:\[[^\]]+\]\s*)?(?:Sign in to confirm your age|Login required|This content is only available to logged-in users)/i.test(message)) {
    return new PermanentJobError(message, {
      cause: error,
      userMessage: '❌ This video requires an account or age verification and cannot be downloaded.',
    });
  }

  return stderr ? new Error(message, { cause: error }) : error;
}

export async function fetchVideoInfo(url) {
  return ytDlp(url, {
    dumpSingleJson: true,
  });
}

export function getMp4PresetOptions(formats = []) {
  const mp4Formats = formats.filter((format) => format.ext === 'mp4' && Number.isFinite(format.filesize));

  if (!mp4Formats.length) {
    return { high: null, medium: null };
  }

  const sorted = [...mp4Formats].sort((a, b) => (a.filesize || Number.MAX_SAFE_INTEGER) - (b.filesize || Number.MAX_SAFE_INTEGER));

  const high = sorted.find((format) => format.height >= 720 && format.filesize <= MAX_TELEGRAM_FILE_SIZE_BYTES)
    ?? sorted.at(-1)
    ?? null;

  const medium = sorted.find((format) => format.height >= 360 && format.filesize <= MAX_TELEGRAM_FILE_SIZE_BYTES)
    ?? sorted.at(Math.floor(sorted.length / 2))
    ?? null;

  return { high, medium };
}

export function getHighQualityLabel(format) {
  if (!format) return '📹 High Quality (Best Fit)';
  return `📹 High Quality (~${(format.filesize / (1024 * 1024)).toFixed(1)}MB)`;
}

export function getMediumQualityLabel(format) {
  if (!format) return '📺 Medium Quality (Compact)';
  return `📺 Medium Quality (~${(format.filesize / (1024 * 1024)).toFixed(1)}MB)`;
}

export function resolveAudioOutputPath(outputPath, title) {
  const requestedPath = path.resolve(outputPath);
  const isDirectory = fs.existsSync(requestedPath) && fs.statSync(requestedPath).isDirectory();
  const resolvedPath = isDirectory || !path.extname(requestedPath)
    ? path.join(requestedPath, `${sanitizeTitle(title, 50)}-${randomUUID()}.mp3`)
    : requestedPath;

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

export async function downloadMp4Video({ url, outputPath, option, onProgress }) {
  const temporaryPath = path.join(path.dirname(outputPath), 'video.mp4');
  const outputTemplate = getYtDlpOutputTemplate(temporaryPath);
  const process = ytDlp.exec(url, {
    output: outputTemplate,
    format: getMp4FormatSelector(option),
    mergeOutputFormat: 'mp4',
    remuxVideo: 'mp4',
  });

  process.stdout.on('data', (data) => {
    const match = data.toString().match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const percent = Math.floor(Number.parseFloat(match[1]));
      if (Number.isFinite(percent)) onProgress?.(percent);
    }
  });

  process.stderr.on('data', (data) => {
    const match = data.toString().match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const percent = Math.floor(Number.parseFloat(match[1]));
      if (Number.isFinite(percent)) onProgress?.(percent);
    }
  });

  try {
    await process;
  } catch (error) {
    throw withYtDlpDiagnostics(error);
  }

  const downloadedPath = findYtDlpOutput(outputTemplate, 'mp4');
  const stats = fs.statSync(downloadedPath);
  if (stats.size > MAX_TELEGRAM_FILE_SIZE_BYTES) {
    throw new PermanentJobError('Downloaded video exceeds Telegram size limit.', {
      userMessage: '❌ This video exceeds Telegram’s 50 MB file limit. Please choose a smaller quality.',
    });
  }

  fs.renameSync(downloadedPath, outputPath);
  return outputPath;
}

export async function downloadAudioOnly({ url, outputPath, onProgress }) {
  const outputTemplate = getYtDlpOutputTemplate(outputPath);
  const process = ytDlp.exec(url, {
    output: outputTemplate,
    format: 'bestaudio',
  });

  process.stdout.on('data', (data) => {
    const match = data.toString().match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const percent = Math.floor(Number.parseFloat(match[1]));
      if (Number.isFinite(percent)) onProgress?.(percent);
    }
  });

  process.stderr.on('data', (data) => {
    const match = data.toString().match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      const percent = Math.floor(Number.parseFloat(match[1]));
      if (Number.isFinite(percent)) onProgress?.(percent);
    }
  });

  try {
    await process;
  } catch (error) {
    throw withYtDlpDiagnostics(error);
  }
  return findYtDlpOutput(outputTemplate);
}

export async function convertAudioToMp3({ inputPath, outputPath, title, bitrateKbps }) {
  const safeBitrate = Number.isFinite(Number(bitrateKbps)) ? Number(bitrateKbps) : 128;
  const resolvedOutputPath = resolveAudioOutputPath(outputPath, title);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(resolvedOutputPath)
      .toFormat('mp3')
      .audioBitrate(safeBitrate)
      .outputOptions('-metadata', `title=${sanitizeTitle(title, 50)}`)
      .outputOptions('-metadata', 'artist=Cloud Downloader Bot')
      .outputOptions('-metadata', 'album=Telegram Downloads')
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const stats = fs.statSync(resolvedOutputPath);
  if (stats.size > MAX_TELEGRAM_FILE_SIZE_BYTES) {
    throw new PermanentJobError('Converted audio exceeds Telegram size limit.', {
      userMessage: '❌ This audio exceeds Telegram’s 50 MB file limit. Please choose a lower bitrate.',
    });
  }

  return resolvedOutputPath;
}
