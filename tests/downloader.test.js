import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findYtDlpOutput,
  getYtDlpOutputTemplate,
  getMp4FormatSelector,
  getMp4PresetOptions,
  resolveAudioOutputPath,
  withYtDlpDiagnostics,
} from '../src/services/downloader.service.js';
import { PermanentJobError } from '../src/lib/job-errors.js';

test('yt-dlp unsupported URLs are marked as permanent failures', () => {
  const error = withYtDlpDiagnostics({
    message: 'yt-dlp failed',
    stderr: 'ERROR: Unsupported URL: https://example.com/photo/123',
  });

  assert.ok(error instanceof PermanentJobError);
  assert.equal(error.retryable, false);
  assert.match(error.userMessage, /link is not supported/);
});

test('transient yt-dlp errors remain retryable', () => {
  const error = withYtDlpDiagnostics({
    message: 'yt-dlp failed',
    stderr: 'ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable',
  });

  assert.equal(error instanceof PermanentJobError, false);
});

test('MP4 presets choose a fitting high and medium format without mutating input', () => {
  const formats = [
    { ext: 'mp4', filesize: 8 * 1024 * 1024, height: 360 },
    { ext: 'mp4', filesize: 40 * 1024 * 1024, height: 720 },
    { ext: 'mp4', filesize: 60 * 1024 * 1024, height: 1080 },
    { ext: 'webm', filesize: 4 * 1024 * 1024, height: 1080 },
  ];
  const originalOrder = [...formats];

  const presets = getMp4PresetOptions(formats);

  assert.equal(presets.high.height, 720);
  assert.equal(presets.medium.height, 360);
  assert.deepEqual(formats, originalOrder);
});

test('MP4 presets return null when no measured MP4 formats exist', () => {
  assert.deepEqual(getMp4PresetOptions([{ ext: 'webm', filesize: 100, height: 720 }]), {
    high: null,
    medium: null,
  });
});

test('MP4 format selectors fall back when a platform lacks separate MP4 audio/video streams', () => {
  assert.equal(
    getMp4FormatSelector('highest'),
    'bestvideo[ext=mp4][filesize<=49M]+bestaudio[ext=m4a]/best[ext=mp4][filesize<=49M]/best[ext=mp4]/best',
  );
  assert.equal(
    getMp4FormatSelector('medium'),
    'worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst',
  );
});

test('audio output path uses a unique MP3 file when given a directory', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-downloader-'));

  try {
    const outputDirectory = path.join(temporaryDirectory, 'Downloads');
    fs.mkdirSync(outputDirectory);

    const outputPath = resolveAudioOutputPath(outputDirectory, 'Test: audio');

    assert.equal(path.dirname(outputPath), outputDirectory);
    assert.equal(path.extname(outputPath), '.mp3');
    assert.match(path.basename(outputPath), /^Test audio-[\da-f-]+\.mp3$/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('audio output path treats extensionless paths as directories and creates them', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-downloader-'));

  try {
    const outputDirectory = path.join(temporaryDirectory, 'Downloads');
    const outputPath = resolveAudioOutputPath(outputDirectory, 'Test audio');

    assert.equal(path.dirname(outputPath), outputDirectory);
    assert.equal(path.extname(outputPath), '.mp3');
    assert.equal(fs.statSync(outputDirectory).isDirectory(), true);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('yt-dlp output template lets the downloader choose the real container extension', () => {
  assert.equal(
    getYtDlpOutputTemplate('C:\\downloads\\video.mp4'),
    path.join('C:\\downloads', 'video.%(ext)s'),
  );
});

test('yt-dlp output lookup finds the completed file and ignores partials', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-downloader-'));

  try {
    const outputPath = path.join(temporaryDirectory, 'video.mp4');
    const partialPath = `${outputPath}.part`;
    fs.writeFileSync(outputPath, 'complete');
    fs.writeFileSync(partialPath, 'partial');

    assert.equal(
      findYtDlpOutput(getYtDlpOutputTemplate(outputPath), 'mp4'),
      outputPath,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
