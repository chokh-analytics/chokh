import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { doNotTrack, findScript, readConfig } from './config';

function script(attributes: Record<string, string>): HTMLScriptElement {
  const el = document.createElement('script');
  for (const [name, value] of Object.entries(attributes)) {
    el.setAttribute(name, value);
  }
  return el;
}

beforeEach(() => {
  document.head.innerHTML = '';
});

describe('readConfig', () => {
  it('needs a site key', () => {
    expect(readConfig(null)).toBeNull();
    expect(readConfig(script({ src: 'https://a.test/a.js' }))).toBeNull();
    expect(readConfig(script({ 'data-site': '' }))).toBeNull();
  });

  it('derives the collect url from the script source', () => {
    const config = readConfig(script({ 'data-site': 's1', src: 'https://a.test/a.js' }));
    expect(config?.collectUrl).toBe('https://a.test/api/collect');
  });

  it('uses the first party proxy path when the site gives one', () => {
    const config = readConfig(
      script({ 'data-site': 's1', 'data-api': '/_pa/', src: '/_pa/a.js' }),
    );
    expect(config?.collectUrl).toBe('/_pa/collect');
  });

  it('defaults to cookieless, no hash routing, no consent gate and no DNT check', () => {
    const config = readConfig(script({ 'data-site': 's1', src: '/a.js' }));
    expect(config).toMatchObject({
      siteId: 's1',
      hashRouting: false,
      persistentVisitor: false,
      honourDnt: false,
      requireConsent: false,
    });
  });

  it('reads the site settings off the tag', () => {
    const config = readConfig(
      script({
        'data-site': 's1',
        src: '/a.js',
        'data-hash': '',
        'data-visitor-id': 'persistent',
        'data-dnt': '',
        'data-consent': '',
      }),
    );
    expect(config).toMatchObject({
      hashRouting: true,
      persistentVisitor: true,
      honourDnt: true,
      requireConsent: true,
    });
  });
});

describe('findScript', () => {
  it('finds the tag that carries the site key', () => {
    document.head.appendChild(script({ src: '/other.js' }));
    const mine = script({ 'data-site': 's1', src: '/a.js' });
    document.head.appendChild(mine);
    expect(findScript(document)).toBe(mine);
  });

  it('is null when the page carries no tag of ours', () => {
    expect(findScript(document)).toBeNull();
  });
});

describe('doNotTrack', () => {
  function signal(target: object, name: string, value: string | null): void {
    Object.defineProperty(target, name, { value, configurable: true });
  }

  afterEach(() => {
    signal(window.navigator, 'doNotTrack', null);
    signal(window.navigator, 'msDoNotTrack', null);
    signal(window, 'doNotTrack', null);
  });

  it('reads the signal on navigator', () => {
    signal(window.navigator, 'doNotTrack', '1');
    expect(doNotTrack(window.navigator, window)).toBe(true);
  });

  it('reads the signal older browsers put on window', () => {
    signal(window, 'doNotTrack', '1');
    expect(doNotTrack(window.navigator, window)).toBe(true);
  });

  it('reads the signal Internet Explorer put on navigator', () => {
    signal(window.navigator, 'msDoNotTrack', '1');
    expect(doNotTrack(window.navigator, window)).toBe(true);
  });

  it('is false when nothing asks not to be tracked', () => {
    expect(doNotTrack(window.navigator, window)).toBe(false);
  });
});
