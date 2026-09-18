// The visitor id. In persistent mode the browser keeps one for 13 months so a
// returning visitor is recognised across days; in cookieless mode nothing is
// stored and the collector derives the id from a daily salted hash.
const TTL_MS = 13 * 30 * 24 * 60 * 60 * 1000;

function key(siteId: string): string {
  return 'chokh.' + siteId;
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function readVisitorId(store: Storage | null, siteId: string): string | undefined {
  if (store === null) {
    return undefined;
  }
  const now = Date.now();
  try {
    const raw = store.getItem(key(siteId));
    if (raw !== null) {
      const cut = raw.lastIndexOf('.');
      const born = Number(raw.slice(cut + 1));
      if (cut > 0 && now - born < TTL_MS) {
        return raw.slice(0, cut);
      }
    }
    const id = newId();
    store.setItem(key(siteId), id + '.' + now);
    return id;
  } catch {
    // Storage can be unavailable or full. The visitor is then cookieless for
    // this page, which is a degraded mode, not a failure.
    return undefined;
  }
}

export function clearVisitorId(store: Storage | null, siteId: string): void {
  if (store === null) {
    return;
  }
  try {
    store.removeItem(key(siteId));
  } catch {
    // Nothing to do: there is no id to forget.
  }
}

export function safeStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}
