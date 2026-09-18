import { describe, expect, it } from 'vitest';

import { classifyChannel, referrerHost } from './channel.js';

describe('classifyChannel', () => {
  it('calls a visitor with no referrer and no campaign direct', () => {
    expect(classifyChannel({})).toBe('direct');
    expect(classifyChannel({ referrer: '' })).toBe('direct');
  });

  it('believes the medium the link was tagged with', () => {
    expect(classifyChannel({ utm: { medium: 'cpc' } })).toBe('paid');
    expect(classifyChannel({ utm: { medium: 'paid-social' } })).toBe('paid');
    expect(classifyChannel({ utm: { medium: 'newsletter' } })).toBe('email');
    expect(classifyChannel({ utm: { medium: 'Email' } })).toBe('email');
    expect(classifyChannel({ utm: { medium: 'social' } })).toBe('social');
    expect(classifyChannel({ utm: { medium: 'organic' } })).toBe('organic');
    expect(classifyChannel({ utm: { medium: 'referral' } })).toBe('referral');
  });

  it('lets the tag beat the referrer, because the person who built the link knew', () => {
    const paidSearch = classifyChannel({
      referrer: 'https://www.google.com/',
      utm: { medium: 'cpc' },
    });
    expect(paidSearch).toBe('paid');
  });

  it('calls a campaign with a medium nobody knows a referral, never direct', () => {
    expect(classifyChannel({ utm: { medium: 'qr-code' } })).toBe('referral');
  });

  it('knows a search engine, country suffixes and all', () => {
    expect(classifyChannel({ referrer: 'https://www.google.com/' })).toBe('organic');
    expect(classifyChannel({ referrer: 'https://google.co.uk/search?q=chokh' })).toBe('organic');
    expect(classifyChannel({ referrer: 'https://duckduckgo.com/' })).toBe('organic');
    expect(classifyChannel({ referrer: 'https://yandex.com.tr/' })).toBe('organic');
    expect(classifyChannel({ referrer: 'https://www.bing.com/' })).toBe('organic');
  });

  it('knows the places people share links', () => {
    expect(classifyChannel({ referrer: 'https://m.facebook.com/' })).toBe('social');
    expect(classifyChannel({ referrer: 'https://t.co/abc' })).toBe('social');
    expect(classifyChannel({ referrer: 'https://www.linkedin.com/feed/' })).toBe('social');
    expect(classifyChannel({ referrer: 'https://t.me/somechannel' })).toBe('social');
    expect(classifyChannel({ referrer: 'https://news.ycombinator.com/' })).toBe('social');
  });

  it('gives the assistants a channel of their own', () => {
    // The whole point of the category: nothing a site owner used before
    // reported these, and they are a growing share of the way people arrive.
    expect(classifyChannel({ referrer: 'https://chatgpt.com/' })).toBe('ai');
    expect(classifyChannel({ referrer: 'https://www.perplexity.ai/search' })).toBe('ai');
    expect(classifyChannel({ referrer: 'https://gemini.google.com/app' })).toBe('ai');
    expect(classifyChannel({ referrer: 'https://claude.ai/chat/abc' })).toBe('ai');
    expect(classifyChannel({ referrer: 'https://copilot.microsoft.com/' })).toBe('ai');
  });

  it('does not mistake gemini for a Google search', () => {
    // gemini.google.com ends in google.com, so the assistant list has to be
    // asked before the search prefixes are.
    expect(classifyChannel({ referrer: 'https://gemini.google.com/' })).not.toBe('organic');
  });

  it('knows a webmail client from a website', () => {
    expect(classifyChannel({ referrer: 'https://mail.google.com/mail/u/0/' })).toBe('email');
    expect(classifyChannel({ referrer: 'https://outlook.live.com/' })).toBe('email');
  });

  it('calls anything else a referral', () => {
    expect(classifyChannel({ referrer: 'https://someblog.example/post' })).toBe('referral');
  });

  it('does not call a walk through your own site a referral', () => {
    // A browser reports the previous page as the referrer on the first
    // pageview of a load, so without this every second page is a referral
    // from yourself.
    expect(classifyChannel({ referrer: 'https://shop.test/a', hostname: 'shop.test' })).toBe(
      'direct',
    );
    expect(classifyChannel({ referrer: 'https://www.shop.test/a', hostname: 'shop.test' })).toBe(
      'direct',
    );
  });

  it('survives a referrer that is not a URL', () => {
    expect(referrerHost('android-app')).toBeUndefined();
    expect(classifyChannel({ referrer: 'not a url' })).toBe('direct');
  });
});
