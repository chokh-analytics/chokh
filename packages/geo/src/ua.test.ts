import { describe, expect, it } from 'vitest';

import { parseBrandList, parseUserAgent } from './ua.js';

const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1';

describe('parseBrandList', () => {
  it('reads the brands and drops the decoys Chromium pads the list with', () => {
    expect(parseBrandList('"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"')).toEqual([
      { brand: 'Chromium', version: '130' },
      { brand: 'Google Chrome', version: '130' },
    ]);
  });

  it('is empty for a header that carries nothing usable', () => {
    expect(parseBrandList('')).toEqual([]);
    expect(parseBrandList('"Not.A/Brand";v="24"')).toEqual([]);
  });
});

describe('parseUserAgent from the user agent string', () => {
  it('reads a desktop browser and its operating system', () => {
    expect(parseUserAgent(CHROME_DESKTOP)).toMatchObject({
      browser: 'Chrome',
      os: 'Windows',
      device: 'desktop',
    });
  });

  it('reads a phone', () => {
    expect(parseUserAgent(SAFARI_IPHONE)).toMatchObject({
      browser: 'Mobile Safari',
      os: 'iOS',
      osVersion: '18.1',
      device: 'mobile',
      brand: 'Apple',
      model: 'iPhone',
    });
  });

  it('reads a tablet as a tablet, not a phone', () => {
    expect(parseUserAgent(IPAD).device).toBe('tablet');
  });

  it('reads an Android device and its model', () => {
    expect(parseUserAgent(CHROME_ANDROID)).toMatchObject({
      browser: 'Chrome',
      os: 'Android',
      device: 'mobile',
      model: 'SM-S911B',
    });
  });

  it('answers with an empty device rather than throwing on nonsense', () => {
    expect(parseUserAgent('')).toMatchObject({ device: 'desktop' });
  });
});

describe('parseUserAgent with Client Hints', () => {
  it('prefers the hinted brand over a frozen user agent string', () => {
    const info = parseUserAgent(CHROME_DESKTOP, {
      ua: '"Chromium";v="131", "Brave";v="131", "Not?A_Brand";v="99"',
      mobile: '?0',
      platform: '"Linux"',
    });
    expect(info.browser).toBe('Brave');
    expect(info.browserVersion).toBe('131');
    expect(info.os).toBe('Linux');
  });

  it('prefers the full version list over the low entropy brand list', () => {
    const info = parseUserAgent(CHROME_DESKTOP, {
      ua: '"Chromium";v="131", "Google Chrome";v="131"',
      fullVersionList: '"Chromium";v="131.0.6778.86", "Google Chrome";v="131.0.6778.86"',
    });
    expect(info.browserVersion).toBe('131.0.6778.86');
  });

  it('reads the platform version and the model the hints carry', () => {
    const info = parseUserAgent(CHROME_ANDROID, {
      mobile: '?1',
      platform: '"Android"',
      platformVersion: '"15.0.0"',
      model: '"Pixel 9"',
    });
    expect(info).toMatchObject({
      os: 'Android',
      osVersion: '15.0.0',
      device: 'mobile',
      model: 'Pixel 9',
    });
  });

  it('calls a device mobile when the hint says so and the string does not', () => {
    expect(parseUserAgent(CHROME_DESKTOP, { mobile: '?1' }).device).toBe('mobile');
    expect(parseUserAgent(CHROME_DESKTOP, { mobile: '?0' }).device).toBe('desktop');
  });
});
