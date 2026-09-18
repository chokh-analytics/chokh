import type { Config } from './types';

// The site's settings reach the browser as attributes on the script tag, so one
// static file serves every site. data-site is the only required one.
export function readConfig(script: Element | null): Config | null {
  if (script === null) {
    return null;
  }
  const siteId = script.getAttribute('data-site');
  if (siteId === null || siteId === '') {
    return null;
  }

  const api = script.getAttribute('data-api');
  const src = script.getAttribute('src') ?? '';
  const collectUrl =
    api !== null && api !== ''
      ? api.replace(/\/+$/, '') + '/collect'
      : src.replace(/[^/]*$/, 'api/collect');

  return {
    siteId,
    collectUrl,
    hashRouting: script.hasAttribute('data-hash'),
    persistentVisitor: script.getAttribute('data-visitor-id') === 'persistent',
    honourDnt: script.hasAttribute('data-dnt'),
    requireConsent: script.hasAttribute('data-consent'),
  };
}

export function findScript(doc: Document): Element | null {
  const current = doc.currentScript;
  if (current !== null && current.hasAttribute('data-site')) {
    return current;
  }
  return doc.querySelector('script[data-site]');
}

export function doNotTrack(nav: Navigator, win: Window): boolean {
  const n = nav as Navigator & { msDoNotTrack?: string | null };
  const w = win as Window & { doNotTrack?: string | null };
  return n.doNotTrack === '1' || w.doNotTrack === '1' || n.msDoNotTrack === '1';
}
