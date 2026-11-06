import test from 'node:test';
import assert from 'node:assert/strict';

import { assertConfig, config } from '../src/config/index.js';
import { buildSafeFileName, estimateMp3SizeMb, isValidUrl, sanitizeTitle } from '../src/utils.js';

const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalDatabaseUrl = config.databaseUrl;

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
config.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
config.databaseUrl = 'postgres://test:test@localhost:5432/test';

test('assertConfig accepts valid environment values', () => {
  assert.doesNotThrow(() => assertConfig());
  assert.ok(typeof config.telegramBotToken === 'string' && config.telegramBotToken.length > 0);
});

test('sanitizeTitle strips unsafe characters', () => {
  assert.equal(sanitizeTitle('My: Video/Title?*', 20), 'My VideoTitle');
});

test('buildSafeFileName uses the video title without job identifiers', () => {
  assert.equal(
    buildSafeFileName('Montagem Nada Tropical - (Official Video)', 'mp3'),
    'Montagem Nada Tropical - (Official Video).mp3',
  );
});

test('buildSafeFileName keeps Unicode titles within filesystem component limits', () => {
  const fileName = buildSafeFileName('🚭'.repeat(120), 'mp4');

  assert.ok(Buffer.byteLength(fileName, 'utf8') <= 184);
  assert.match(fileName, /\.mp4$/);
});

test('isValidUrl accepts HTTP and HTTPS links', () => {
  assert.equal(isValidUrl('https://example.com/video'), true);
  assert.equal(isValidUrl('ftp://example.com/video'), false);
  assert.equal(isValidUrl('not-a-url'), false);
});

test('estimateMp3SizeMb calculates expected size for a duration', () => {
  const size = estimateMp3SizeMb(60, 128);
  assert.ok(Math.abs(size - 0.91552734375) < 0.001);
});

process.env.TELEGRAM_BOT_TOKEN = originalToken;
config.databaseUrl = originalDatabaseUrl;
