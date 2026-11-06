import { Telegraf, Markup } from 'telegraf';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { RateLimiter } from '../lib/rate-limiter.js';
import { SessionStore } from '../storage/session-store.js';
import {
  estimateMp3SizeMb,
  isValidUrl,
} from '../utils.js';
import { fetchVideoInfo, getHighQualityLabel, getMediumQualityLabel, getMp4PresetOptions } from './downloader.service.js';

export function isTikTokPhotoUrl(url) {
  const parsedUrl = new URL(url);
  const isTikTokHost = parsedUrl.hostname === 'tiktok.com'
    || parsedUrl.hostname.endsWith('.tiktok.com');
  const isPhotoPost = parsedUrl.pathname
    .split('/')
    .some((segment) => segment.toLowerCase() === 'photo');

  return isTikTokHost && isPhotoPost;
}

export function getVideoInfoFailureMessage(url) {
  if (isTikTokPhotoUrl(url)) {
    return '❌ TikTok photo posts are not supported. Please send a TikTok video link instead; MP4 video and MP3 audio are supported.';
  }

  return '❌ Failed to process video info. The platform might be unsupported or restricted.';
}

export function createBot({
  sessionStore = new SessionStore(config.sessionStoreFile, config.sessionTtlMs),
  rateLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitMaxRequests,
  }),
  jobQueue,
  token = config.telegramBotToken,
} = {}) {
  if (!jobQueue) {
    throw new Error('A persistent download job queue is required.');
  }

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      await jobQueue.upsertUser({
        telegramUserId: ctx.from.id,
        chatId: ctx.chat?.id ?? ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name ?? null,
        languageCode: ctx.from.language_code ?? null,
      });
    }

    return next();
  });

  bot.start((ctx) => {
    ctx.reply('👋 Paste a video link here (YouTube, TikTok, IG, etc.) to get download options!');
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const chatId = String(ctx.chat.id);

    if (!isValidUrl(text)) {
      return ctx.reply('⚠️ Please send a valid web link.');
    }

    if (!rateLimiter.check(chatId)) {
      return ctx.reply('⏳ You have reached the rate limit for download requests. Please wait a moment and try again.');
    }

    const loadingMessage = await ctx.reply('⏳ Analyzing link and fetching format variations...');

    try {
      const info = await fetchVideoInfo(text);
      const title = info.title || 'Untitled Video';
      const duration = Number(info.duration) || 0;

      sessionStore.set(chatId, {
        url: text,
        title,
        duration,
        thumbnail: info.thumbnail || '',
        rawInfo: info,
      });

      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMessage.message_id).catch(() => {});
      await ctx.reply(
        `🎬 **${title}**\nChoose your download format:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📹 MP4 (Video)', 'type_mp4'),
            Markup.button.callback('🎵 MP3 (Audio)', 'type_mp3'),
          ],
        ]),
      );
    } catch (error) {
      const isPhotoPost = isTikTokPhotoUrl(text);
      const errorMessage = getVideoInfoFailureMessage(text);
      logger[isPhotoPost ? 'warn' : 'error']('Failed to parse video info.', { error: error.message, chatId });
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        errorMessage,
      ).catch(() => {});
    }
  });

  bot.action('type_mp4', async (ctx) => {
    await ctx.answerCbQuery();
    const session = sessionStore.get(ctx.chat.id);

    if (!session) {
      return ctx.reply('Session expired. Please paste the link again.');
    }

    const { high, medium } = getMp4PresetOptions(session.rawInfo?.formats || []);

    await ctx.editMessageText(
      '📺 Choose Video Quality Preset:',
      Markup.inlineKeyboard([
        [Markup.button.callback(getHighQualityLabel(high), 'dl_mp4_highest')],
        [Markup.button.callback(getMediumQualityLabel(medium), 'dl_mp4_medium')],
        [Markup.button.callback('⬅️ Back', 'back_to_main')],
      ]),
    );
  });

  bot.action('type_mp3', async (ctx) => {
    await ctx.answerCbQuery();
    const session = sessionStore.get(ctx.chat.id);

    if (!session) {
      return ctx.reply('Session expired. Please paste the link again.');
    }

    const size320 = estimateMp3SizeMb(session.duration, 320);
    const size192 = estimateMp3SizeMb(session.duration, 192);
    const size128 = estimateMp3SizeMb(session.duration, 128);

    const buttons = [];
    if (size320 < 49.5) {
      buttons.push([Markup.button.callback(`🔥 320 kbps (Ultra ~${size320.toFixed(1)}MB)`, 'dl_mp3_320')]);
    }
    if (size192 < 49.5) {
      buttons.push([Markup.button.callback(`🎧 192 kbps (High ~${size192.toFixed(1)}MB)`, 'dl_mp3_192')]);
    }
    buttons.push([Markup.button.callback(`📻 128 kbps (Standard ~${size128.toFixed(1)}MB)`, 'dl_mp3_128')]);
    buttons.push([Markup.button.callback('⬅️ Back', 'back_to_main')]);

    await ctx.editMessageText('🎼 Choose Audio Bitrate:', Markup.inlineKeyboard(buttons));
  });

  bot.action('back_to_main', async (ctx) => {
    await ctx.answerCbQuery();
    const data = sessionStore.get(ctx.chat.id);

    if (!data) {
      return ctx.reply('Session expired. Please paste the link again.');
    }

    await ctx.editMessageText(
      `🎬 **${data.title}**\nChoose your download format:`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('📹 MP4 (Video)', 'type_mp4'),
          Markup.button.callback('🎵 MP3 (Audio)', 'type_mp3'),
        ],
      ]),
    );
  });

  bot.action(/^dl_(mp4|mp3)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Initiating delivery stream...');

    const [, fileType, option] = ctx.match;
    const session = sessionStore.get(ctx.chat.id);

    if (!session) {
      return ctx.reply('❌ Error: Link session expired. Please resend the URL.');
    }

    if ((fileType === 'mp4' && !['highest', 'medium'].includes(option))
      || (fileType === 'mp3' && !['128', '192', '320'].includes(option))) {
      return ctx.reply('⚠️ Invalid download option. Please choose from the menu again.');
    }

    if (fileType === 'mp3') {
      const bitrateKbps = Number.parseInt(option, 10);
      const estimatedAudioMb = estimateMp3SizeMb(session.duration, bitrateKbps);

      if (estimatedAudioMb > 49.5) {
        return ctx.reply(`⚠️ **Telegram 50MB Limit Exceeded!** The audio output is estimated to be around **${estimatedAudioMb.toFixed(1)} MB**.`);
      }
    }

    const statusMessage = await ctx.reply('Preparing your download...');

    try {
      const job = await jobQueue.addJob({
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        statusMessageId: statusMessage.message_id,
        fileType,
        option,
        url: session.url,
        title: session.title,
        duration: session.duration,
      });
      logger.info('Download job queued.', { jobId: job.id, chatId: ctx.chat.id, fileType });
    } catch (error) {
      logger.error('Unable to queue download job.', { error: error.message, chatId: ctx.chat.id });
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        '❌ Could not queue the download. Please try again later.',
      ).catch(() => {});
    }
  });

  bot.catch((error, ctx) => {
    logger.error('Telegraf bot error.', { error: error.message, chatId: ctx?.chat?.id });
    return ctx.reply('⚠️ Something went wrong while processing your request.').catch((replyError) => {
      logger.warn('Unable to notify user about bot error.', {
        error: replyError.message,
        chatId: ctx?.chat?.id,
      });
    });
  });

  return bot;
}
