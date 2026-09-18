import UAParser from 'ua-parser-js';

import type { ClientHints, UserAgentInfo } from './types.js';

// Chromium pads the brand list with a decoy whose punctuation it varies on
// purpose ("Not?A_Brand", "Not.A/Brand", "(Not(Brand"), so the letters alone
// are what identifies it.
const DECOY_BRAND = /^not(a)?brand$/;

function isDecoy(brand: string): boolean {
  return DECOY_BRAND.test(brand.replace(/[^a-z]/gi, '').toLowerCase());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

// Sec-CH-UA and Sec-CH-UA-Full-Version-List are the same grammar:
//   "Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"
export function parseBrandList(header: string): { brand: string; version: string }[] {
  const brands: { brand: string; version: string }[] = [];
  for (const entry of header.split(',')) {
    const [rawBrand, rawVersion] = entry.split(';v=');
    if (rawBrand === undefined || rawVersion === undefined) {
      continue;
    }
    const brand = unquote(rawBrand);
    if (brand === '' || isDecoy(brand)) {
      continue;
    }
    brands.push({ brand, version: unquote(rawVersion) });
  }
  return brands;
}

// The last real brand is the specific browser: Chromium first, then the brand
// that shipped it.
function pickBrand(header: string): { brand: string; version: string } | undefined {
  const brands = parseBrandList(header);
  return brands.length === 0 ? undefined : brands[brands.length - 1];
}

function deviceFrom(type: string | undefined, mobile: string | undefined): UserAgentInfo['device'] {
  if (type === 'mobile' || type === 'tablet') {
    return type;
  }
  if (type !== undefined && type !== '') {
    // console, smarttv, wearable, embedded and xr all browse on a big screen.
    return 'desktop';
  }
  return mobile === '?1' ? 'mobile' : 'desktop';
}

function clean(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

// Client Hints are preferred over the user agent string wherever they are sent,
// because a browser freezing its user agent still reports the truth here.
export function parseUserAgent(userAgent: string, hints: ClientHints = {}): UserAgentInfo {
  const parsed = new UAParser(userAgent).getResult();
  const info: UserAgentInfo = {};

  const hinted = pickBrand(hints.fullVersionList ?? hints.ua ?? '');
  const browser = hinted?.brand ?? clean(parsed.browser.name);
  const browserVersion = hinted?.version ?? clean(parsed.browser.version);
  if (browser !== undefined) info.browser = browser;
  if (browserVersion !== undefined) info.browserVersion = browserVersion;

  const os = clean(hints.platform === undefined ? undefined : unquote(hints.platform)) ?? clean(parsed.os.name);
  const osVersion =
    clean(hints.platformVersion === undefined ? undefined : unquote(hints.platformVersion)) ??
    clean(parsed.os.version);
  if (os !== undefined) info.os = os;
  if (osVersion !== undefined) info.osVersion = osVersion;

  info.device = deviceFrom(parsed.device.type, hints.mobile);

  const brand = clean(parsed.device.vendor);
  const model = clean(hints.model === undefined ? undefined : unquote(hints.model)) ?? clean(parsed.device.model);
  if (brand !== undefined) info.brand = brand;
  if (model !== undefined) info.model = model;

  return info;
}
