import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'telegraf';

import {
  createBot,
  getVideoInfoFailureMessage,
} from '../src/services/telegram-bot.service.js';

function callbackUpdate(data) {
  return {
    update_id: 1,
    callback_query: {
      id: 'callback-id',
      from: {
        id: 123,
        is_bot: false,
        first_name: 'Test',
        last_name: 'User',
        username: 'test_user',
        language_code: 'en',
      },
      chat_instance: 'chat-instance',
      data,
      message: {
        message_id: 9,
        date: 1,
        chat: { id: 123, type: 'private' },
      },
    },
  };
}

function createTestBot() {
  const queuedJobs = [];
  const upsertedUsers = [];
  const sessionStore = {
    get: () => ({
      url: 'https://example.com/video',
      title: 'Test video',
      duration: 30,
    }),
  };
  const jobQueue = {
    async upsertUser(user) {
      upsertedUsers.push(user);
    },
    async addJob(data) {
      queuedJobs.push(data);
      return { id: 'job-123' };
    },
  };
  const bot = createBot({
    token: '123456:test-token',
    sessionStore,
    jobQueue,
  });
  const apiCalls = [];
  async function dispatch(data) {
    const update = callbackUpdate(data);
    const telegram = {
      async answerCbQuery() {},
      async editMessageText() {},
      async sendMessage(_chatId, text) {
        apiCalls.push({ method: 'sendMessage', payload: { text } });
        return { message_id: 27 };
      },
    };
    const ctx = new Context(update, telegram);

    await bot.middleware()(ctx, async () => {});
  }

  return { dispatch, queuedJobs, upsertedUsers, apiCalls };
}

test('TikTok photo links explain that only video posts are supported', () => {
  assert.match(
    getVideoInfoFailureMessage('https://www.tiktok.com/@creator/photo/1234567890'),
    /photo posts are not supported.*MP4 video and MP3 audio are supported/,
  );
});

test('unsupported non-photo URLs retain the general error message', () => {
  assert.match(
    getVideoInfoFailureMessage('https://example.com/video'),
    /platform might be unsupported or restricted/,
  );
});

test('bot rejects unsupported callback options', async () => {
  const { dispatch, queuedJobs, apiCalls } = createTestBot();

  await dispatch('dl_mp3_999');

  assert.equal(queuedJobs.length, 0);
  assert.ok(apiCalls.some(({ method, payload }) => (
    method === 'sendMessage' && payload.text.includes('Invalid download option')
  )));
});

test('bot enqueues a valid download with durable delivery details', async () => {
  const { dispatch, queuedJobs, upsertedUsers } = createTestBot();

  await dispatch('dl_mp3_192');

  assert.deepEqual(upsertedUsers, [{
    telegramUserId: 123,
    chatId: 123,
    username: 'test_user',
    firstName: 'Test',
    lastName: 'User',
    languageCode: 'en',
  }]);
  assert.equal(queuedJobs.length, 1);
  assert.deepEqual(queuedJobs[0], {
    chatId: 123,
    userId: 123,
    statusMessageId: 27,
    fileType: 'mp3',
    option: '192',
    url: 'https://example.com/video',
    title: 'Test video',
    duration: 30,
  });
});
