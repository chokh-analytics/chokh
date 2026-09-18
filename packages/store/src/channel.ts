import type { Attributes } from './types.js';

// Where a session came from, in one word. The classifier is here rather than in
// an adapter because a channel is written onto the session row once and then
// read back for the rest of that row's life: two adapters disagreeing about
// what "organic" means would file the same visit under two names.
//
// The names are machine keys, not labels. A surface shows them through its own
// messages file, so Bangla can follow without hunting through components.
export type Channel = 'direct' | 'organic' | 'social' | 'referral' | 'email' | 'paid' | 'ai';

export const CHANNELS: readonly Channel[] = [
  'direct',
  'organic',
  'social',
  'referral',
  'email',
  'paid',
  'ai',
];

// utm_medium is what the person who built the link said the traffic is, so it
// wins over any guess made from the referrer.
const MEDIUM: Readonly<Record<string, Channel>> = {
  cpc: 'paid',
  ppc: 'paid',
  paid: 'paid',
  paidsearch: 'paid',
  paid_search: 'paid',
  'paid-search': 'paid',
  paidsocial: 'paid',
  paid_social: 'paid',
  'paid-social': 'paid',
  display: 'paid',
  banner: 'paid',
  retargeting: 'paid',
  affiliate: 'paid',
  cpm: 'paid',
  cpv: 'paid',
  cpa: 'paid',
  email: 'email',
  'e-mail': 'email',
  newsletter: 'email',
  social: 'social',
  'social-network': 'social',
  social_network: 'social',
  'social-media': 'social',
  social_media: 'social',
  sm: 'social',
  referral: 'referral',
  organic: 'organic',
  search: 'organic',
};

// An assistant that answers with a link is not a search engine and not a
// referral: it is the channel a site owner most wants to see appear, because
// nothing in the old world of analytics reported it.
const AI_HOSTS = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'perplexity.ai',
  'www.perplexity.ai',
  'gemini.google.com',
  'bard.google.com',
  'claude.ai',
  'copilot.microsoft.com',
  'm365.cloud.microsoft',
  'edgeservices.bing.com',
  'you.com',
  'poe.com',
]);

const SEARCH_HOSTS = new Set([
  'bing.com',
  'duckduckgo.com',
  'baidu.com',
  'ecosia.org',
  'search.brave.com',
  'startpage.com',
  'qwant.com',
  'naver.com',
  'ask.com',
  'lite.duckduckgo.com',
  'html.duckduckgo.com',
]);

// google.co.uk, yandex.com.tr and the rest of the country suffixes, without
// carrying a list of every top level domain in the tracker's memory.
const SEARCH_PREFIXES = ['google.', 'yahoo.', 'yandex.', 'searx.', 'duckduckgo.'];

const SOCIAL_HOSTS = new Set([
  'facebook.com',
  'm.facebook.com',
  'l.facebook.com',
  'lm.facebook.com',
  'instagram.com',
  'l.instagram.com',
  'twitter.com',
  'x.com',
  't.co',
  'linkedin.com',
  'lnkd.in',
  'reddit.com',
  'out.reddit.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  't.me',
  'telegram.me',
  'whatsapp.com',
  'wa.me',
  'chat.whatsapp.com',
  'pinterest.com',
  'tiktok.com',
  'quora.com',
  'discord.com',
  'vk.com',
  'threads.net',
  'threads.com',
  'snapchat.com',
  'tumblr.com',
  'news.ycombinator.com',
  'mastodon.social',
]);

const EMAIL_HOSTS = new Set([
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'mail.zoho.com',
  'roundcube.net',
]);

export function referrerHost(referrer: string | undefined): string | undefined {
  if (referrer === undefined || referrer === '') {
    return undefined;
  }
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

function withoutWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function fromHost(host: string): Channel {
  const bare = withoutWww(host);
  if (AI_HOSTS.has(bare) || AI_HOSTS.has(host)) {
    return 'ai';
  }
  if (SEARCH_HOSTS.has(bare) || SEARCH_PREFIXES.some((prefix) => bare.startsWith(prefix))) {
    return 'organic';
  }
  if (SOCIAL_HOSTS.has(bare)) {
    return 'social';
  }
  if (EMAIL_HOSTS.has(host) || EMAIL_HOSTS.has(bare)) {
    return 'email';
  }
  return 'referral';
}

export interface ChannelSource {
  referrer?: string;
  utm?: Attributes;
  // The site's own hostname. A browser reports the previous page as the
  // referrer on the first pageview of a load, so a visitor walking from one of
  // your pages to another would otherwise be filed as a referral from you.
  hostname?: string;
}

export function classifyChannel(source: ChannelSource): Channel {
  const medium = source.utm?.medium?.trim().toLowerCase();
  if (medium !== undefined && medium !== '') {
    const named = MEDIUM[medium];
    if (named !== undefined) {
      return named;
    }
  }
  // A campaign with a medium nobody recognises is still a campaign, so it is
  // not direct: fall through to the referrer, then to referral.
  const host = referrerHost(source.referrer);
  if (host === undefined) {
    return medium !== undefined && medium !== '' ? 'referral' : 'direct';
  }
  const site = source.hostname?.toLowerCase();
  if (site !== undefined && withoutWww(host) === withoutWww(site)) {
    return 'direct';
  }
  return fromHost(host);
}
