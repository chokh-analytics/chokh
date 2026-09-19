import { useCallback, useEffect, useState, type JSX } from 'react';
import { useLocation } from 'wouter';

import { DEFAULT_COMPARE } from '../lib/query.js';
import { resolvePreset, shiftRange } from '../lib/range.js';
import { messages } from '../messages/en.js';
import { ShortcutSheet, type ShortcutGroup } from '../ui/ShortcutSheet.js';
import styles from './shortcuts.module.css';
import { nextChoice, readChoice, writeChoice, applyChoice } from '../theme/theme.js';
import { useApp } from './context.js';
import { useShortcuts } from './useShortcuts.js';
import { useViewQuery } from './useViewQuery.js';
import { destinationsFor } from './Shell.js';

// What the keys do, in one place, so the sheet that lists them is built from
// the same table that runs them. A card of shortcuts written by hand beside the
// bindings is a card that goes out of date the first time one changes.

// How anything else asks for the sheet. A shortcut nobody can discover is a
// shortcut for the person who wrote it, so the account menu offers it too, and
// an event is a smaller seam between the two than lifting this state into the
// shell would be.
export const OPEN_SHORTCUTS = 'chokh:shortcuts';

// g then a letter, in the order the navigation is in. The letters are the first
// letter of each destination, except that Geo and Overview both want their own
// and "g g" for Geo is what every tool with this convention does.
const DESTINATION_KEYS = ['o', 'r', 'p', 's', 'g', 'd', 'u'];

// One binding, described once: what it is called, which group it belongs in,
// and what it does. The keys run this table and the card lists it, so a card
// that says something the keyboard does not do is not a thing that can happen.
interface Binding {
  keys: string;
  label: string;
  group: string;
  run: () => void;
}

export function bindingsFor(
  siteId: string,
  act: {
    go: (path: string) => void;
    preset: (preset: 'today' | 'yesterday' | '7d' | '30d') => void;
    shift: (direction: -1 | 1) => void;
    compare: () => void;
    clearFilters: () => void;
    theme: () => void;
    help: () => void;
  },
): Binding[] {
  return [
    ...destinationsFor(siteId).map((destination, index) => ({
      keys: `g ${DESTINATION_KEYS[index] ?? ''}`,
      label: destination.label,
      group: messages.shortcuts.groupGo,
      run: () => act.go(destination.path),
    })),
    {
      keys: 't',
      label: messages.range.today,
      group: messages.shortcuts.groupRange,
      run: () => act.preset('today'),
    },
    {
      keys: 'y',
      label: messages.range.yesterday,
      group: messages.shortcuts.groupRange,
      run: () => act.preset('yesterday'),
    },
    {
      keys: '7',
      label: messages.range.last7,
      group: messages.shortcuts.groupRange,
      run: () => act.preset('7d'),
    },
    {
      keys: '3',
      label: messages.range.last30,
      group: messages.shortcuts.groupRange,
      run: () => act.preset('30d'),
    },
    {
      keys: '[',
      label: messages.shortcuts.earlier,
      group: messages.shortcuts.groupRange,
      run: () => act.shift(-1),
    },
    {
      keys: ']',
      label: messages.shortcuts.later,
      group: messages.shortcuts.groupRange,
      run: () => act.shift(1),
    },
    {
      keys: 'c',
      label: messages.shortcuts.compare,
      group: messages.shortcuts.groupRange,
      run: act.compare,
    },
    {
      keys: 'x',
      label: messages.shortcuts.clearFilters,
      group: messages.shortcuts.groupView,
      run: act.clearFilters,
    },
    {
      keys: 'l',
      label: messages.shortcuts.theme,
      group: messages.shortcuts.groupView,
      run: act.theme,
    },
    {
      keys: '?',
      label: messages.shortcuts.help,
      group: messages.shortcuts.groupView,
      run: act.help,
    },
  ];
}

// The same table, written for a person, in the order it was declared.
export function groupsFrom(bindings: Binding[]): ShortcutGroup[] {
  const groups: ShortcutGroup[] = [];
  for (const binding of bindings) {
    const existing = groups.find((group) => group.title === binding.group);
    const row = { keys: binding.keys.split(' '), label: binding.label };
    if (existing === undefined) {
      groups.push({ title: binding.group, rows: [row] });
      continue;
    }
    existing.rows.push(row);
  }
  return groups;
}

export function Shortcuts(): JSX.Element | null {
  const { site, now } = useApp();
  const [, navigate] = useLocation();
  const { query, set } = useViewQuery();
  const [open, setOpen] = useState(false);
  const timezone = site.settings.timezone;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onAsked = (): void => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS, onAsked);
    return () => window.removeEventListener(OPEN_SHORTCUTS, onAsked);
  }, []);

  const bindings = bindingsFor(site.id, {
    go: (path) => navigate(path),
    preset: (preset) => set({ ...query, range: resolvePreset(preset, now, timezone) }),
    shift: (direction) => set({ ...query, range: shiftRange(query.range, direction) }),
    compare: () => set({ ...query, compare: query.compare === null ? DEFAULT_COMPARE : null }),
    clearFilters: () => set({ ...query, filters: [] }),
    theme: () => {
      const store = typeof localStorage === 'undefined' ? undefined : localStorage;
      const prefersDark =
        typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
      const next = nextChoice(readChoice(store), prefersDark);
      writeChoice(store, next);
      applyChoice(document.documentElement, next);
    },
    help: () => setOpen((was) => !was),
  });

  // Off while the sheet is open. The sheet is a layer over the page, and a
  // page that keeps navigating underneath a dialog is a page that moved while
  // somebody was reading what the keys do.
  const armed = useShortcuts(
    bindings.map((binding) => ({ keys: binding.keys, run: binding.run })),
    !open,
  );

  if (open) {
    return <ShortcutSheet groups={groupsFrom(bindings)} onClose={close} />;
  }

  // What is armed, while it is armed. A sequence that waits a second and a
  // half for its second key and shows nothing is a keyboard that swallowed a
  // press.
  return armed === '' ? null : <Armed prefix={armed} />;
}

function Armed({ prefix }: { prefix: string }): JSX.Element {
  return (
    <p className={styles.armed} role="status">
      <kbd className={styles.armedKey}>{prefix}</kbd>
      <span>{messages.shortcuts.armed}</span>
    </p>
  );
}
