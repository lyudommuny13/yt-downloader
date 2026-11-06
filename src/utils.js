import fs from 'fs';

export const MAX_TELEGRAM_FILE_SIZE_BYTES = 49.9 * 1024 * 1024;

export function sanitizeTitle(title = 'video', maxLength = 30) {
  const cleaned = String(title)
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .slice(0, maxLength);

  return cleaned || 'video';
}

export function isValidUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function estimateMp3SizeMb(durationSeconds, bitrateKbps) {
  const safeDuration = Number(durationSeconds) || 0;
  const safeBitrate = Number(bitrateKbps) || 0;
  const bitsPerSecond = safeBitrate * 1000;

  return ((bitsPerSecond / 8) * safeDuration) / (1024 * 1024);
}

export function ensureDownloadDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export function buildSafeFileName(title, extension) {
  const safeTitle = sanitizeTitle(title, 120);
  let fileTitle = '';

  for (const character of safeTitle) {
    if (Buffer.byteLength(`${fileTitle}${character}`, 'utf8') > 180) break;
    fileTitle += character;
  }

  return `${fileTitle || 'video'}.${extension}`;
}
