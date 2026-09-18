import { describe, expect, it } from 'vitest';

import { BOT_EVENT_RATE_PER_MINUTE, isBot, isBotUserAgent, isHeadlessUserAgent } from './bots.js';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('isBotUserAgent', () => {
  it('knows the search crawlers', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; YandexBot/3.0)')).toBe(true);
  });

  it('knows the AI crawlers', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; GPTBot/1.2)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; PerplexityBot/1.0)')).toBe(true);
  });

  it('knows the link preview fetchers', () => {
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true);
    expect(isBotUserAgent('WhatsApp/2.23')).toBe(true);
  });

  it('treats a missing user agent as a bot, because a browser always sends one', () => {
    expect(isBotUserAgent('')).toBe(true);
  });

  it('leaves a real browser alone', () => {
    expect(isBotUserAgent(CHROME)).toBe(false);
  });
});

describe('isHeadlessUserAgent', () => {
  it('knows the drivers and the HTTP clients', () => {
    expect(isHeadlessUserAgent('Mozilla/5.0 HeadlessChrome/130.0.0.0')).toBe(true);
    expect(isHeadlessUserAgent('curl/8.5.0')).toBe(true);
    expect(isHeadlessUserAgent('python-requests/2.32')).toBe(true);
    expect(isHeadlessUserAgent('Go-http-client/2.0')).toBe(true);
  });

  it('leaves a real browser alone', () => {
    expect(isHeadlessUserAgent(CHROME)).toBe(false);
  });
});

describe('isBot', () => {
  it('tags a visitor sending more events than a person can', () => {
    expect(isBot({ userAgent: CHROME, eventsInWindow: BOT_EVENT_RATE_PER_MINUTE + 1 })).toBe(true);
  });

  it('leaves a busy but human visitor alone', () => {
    expect(isBot({ userAgent: CHROME, eventsInWindow: BOT_EVENT_RATE_PER_MINUTE })).toBe(false);
  });
});
