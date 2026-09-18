// The bot filter tags rather than drops, so a dashboard can show the bot share
// and a site owner can tell a crawler wave from a traffic spike.

// Maintained list. Everything is matched as a lowercase substring of the user
// agent, so one entry covers a family.
const BOT_MARKERS = [
  'bot',
  'crawler',
  'spider',
  'crawl',
  'slurp',
  'archiver',
  'scraper',
  'fetcher',
  'monitor',
  'uptime',
  'validator',
  'feedburner',
  'facebookexternalhit',
  'bingpreview',
  'yandex',
  'baiduspider',
  'duckduckgo',
  'ia_archiver',
  'semrush',
  'ahrefs',
  'mj12',
  'dotbot',
  'petalbot',
  'applebot',
  'linkedinbot',
  'pinterest',
  'telegrambot',
  'whatsapp',
  'slackbot',
  'discordbot',
  'embedly',
  'quora link preview',
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'perplexitybot',
  'claudebot',
  'anthropic-ai',
  'google-extended',
  'ccbot',
  'bytespider',
  'amazonbot',
];

// A real person's browser does not announce a driver or an HTTP client.
const HEADLESS_MARKERS = [
  'headlesschrome',
  'phantomjs',
  'electron',
  'puppeteer',
  'playwright',
  'selenium',
  'webdriver',
  'cypress',
  'curl/',
  'wget/',
  'python-requests',
  'python-urllib',
  'httpie',
  'go-http-client',
  'java/',
  'okhttp',
  'axios/',
  'node-fetch',
  'undici',
  'libwww-perl',
  'postmanruntime',
];

// A person opening pages does not send hundreds of events a minute. The
// threshold sits far above a busy tab, which beats three times a minute and
// sends a handful of events a page.
export const BOT_EVENT_RATE_PER_MINUTE = 240;

export function isBotUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  if (ua === '') {
    // A browser always sends one. Nothing else has to.
    return true;
  }
  return BOT_MARKERS.some((marker) => ua.includes(marker));
}

export function isHeadlessUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return HEADLESS_MARKERS.some((marker) => ua.includes(marker));
}

export interface BotSignals {
  userAgent: string;
  eventsInWindow: number;
}

export function isBot(signals: BotSignals): boolean {
  return (
    isBotUserAgent(signals.userAgent) ||
    isHeadlessUserAgent(signals.userAgent) ||
    signals.eventsInWindow > BOT_EVENT_RATE_PER_MINUTE
  );
}
