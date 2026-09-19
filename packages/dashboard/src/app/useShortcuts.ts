import { useEffect, useRef } from 'react';

// The keys, and the three rules that keep them from being a nuisance.
//
// Nothing fires while somebody is typing, because a dashboard with a search box
// and a bare "g" shortcut eats the g out of "google". Nothing fires with a
// modifier held, because ctrl+r is the browser's and taking it is worse than
// not having the shortcut. And every sequence times out, so a stray "g" does
// not lie in wait for the next letter somebody presses a minute later.
//
// The sequences are the ones every tool of this kind uses: g then a letter for
// a destination, brackets to step the range, single letters for the presets.
// Following a convention is worth more than inventing a better one, because the
// person pressing g has already learned it somewhere else.

// How long a prefix waits for its second key. Long enough to be typed by a
// person thinking, short enough that it is not still armed a moment later.
const SEQUENCE_MS = 1_200;

export interface Shortcut {
  // 'g o' for a sequence, 'c' for a single key. Lower case; a shifted key is
  // written as the character it produces, so '?' is '?'.
  keys: string;
  run: () => void;
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useShortcuts(shortcuts: Shortcut[], enabled = true): void {
  // Held in a ref so a re-render between two keys of a sequence does not lose
  // the first one, and so the listener is bound once rather than on every
  // change of what the keys do.
  const table = useRef(shortcuts);
  table.current = shortcuts;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let prefix = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clear = (): void => {
      prefix = '';
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) {
        return;
      }
      if (event.key === 'Escape') {
        clear();
        return;
      }
      const key = event.key.toLowerCase();
      if (key.length !== 1) {
        return;
      }

      const attempt = prefix === '' ? key : `${prefix} ${key}`;
      const hit = table.current.find((shortcut) => shortcut.keys === attempt);
      if (hit !== undefined) {
        event.preventDefault();
        clear();
        hit.run();
        return;
      }

      // Not a shortcut yet, but the start of one: hold it and wait for the
      // second key.
      const starts = table.current.some((shortcut) => shortcut.keys.startsWith(`${key} `));
      clear();
      if (prefix === '' && starts) {
        prefix = key;
        timer = setTimeout(clear, SEQUENCE_MS);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      clear();
    };
  }, [enabled]);
}
