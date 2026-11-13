// What the tracker's script tag carries. a.js reads its settings from its own
// tag's attributes, so these are the whole configuration; @chokh/react injects
// the tag and @chokh/next renders it with next/script, both from this one list.

export interface ChokhTagOptions {
  // The site key, data-site. The only one that is required.
  site: string;
  // Where the collector is, data-api: a first-party path such as /_pa, or the
  // Chokh server's /api. Left out, the tracker posts to api/collect beside the
  // script's own URL.
  api?: string;
  // 'persistent' keeps a visitor id in localStorage, which a sign out can
  // rotate; 'cookieless' (the tracker's default) stores nothing in the browser.
  visitorId?: 'cookieless' | 'persistent';
  // Count a change of the #hash as a page, for an app that routes by it.
  hashRouting?: boolean;
  // Honour the browser's Do Not Track setting.
  respectDnt?: boolean;
  // Undefined: no consent gate. A boolean: the tag carries data-consent, so the
  // tracker holds every event until consent is true, and drops what it held
  // when it turns false.
  consent?: boolean;
}

export const TRACKER_ID = 'chokh-tracker';
export const VITALS_ID = 'chokh-vitals';
export const ERRORS_ID = 'chokh-errors';

// The data-* attributes of the tracker's tag.
export function trackerAttributes(options: ChokhTagOptions): Record<string, string> {
  const attributes: Record<string, string> = { 'data-site': options.site };
  if (options.api !== undefined && options.api !== '') attributes['data-api'] = options.api;
  if (options.visitorId !== undefined) attributes['data-visitor-id'] = options.visitorId;
  if (options.hashRouting === true) attributes['data-hash'] = '';
  if (options.respectDnt === true) attributes['data-dnt'] = '';
  if (options.consent !== undefined) attributes['data-consent'] = '';
  return attributes;
}

// v.js and e.js sit beside a.js wherever a.js is served from, so an option of
// true means "the one next to the tracker" and a string is a URL of its own.
export function siblingScript(trackerSrc: string, option: boolean | string | undefined, file: string): string | undefined {
  if (option === undefined || option === false) return undefined;
  if (typeof option === 'string') return option;
  return trackerSrc.replace(/[^/]*$/, file);
}
