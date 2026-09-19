import { useCallback, useEffect, useState, type JSX } from 'react';
import { useLocation } from 'wouter';

import { DEFAULT_COMPARE } from '../lib/query.js';
import { resolvePreset, shiftRange } from '../lib/range.js';
import { messages } from '../messages/en.js';
import { ShortcutSheet, type ShortcutGroup } from '../ui/ShortcutSheet.js';
import { nextChoice, readChoice, writeChoice, applyChoice } from '../theme/theme.js';
import { useApp } from './context.js';
import { useShortcuts, type Shortcut } from './useShortcuts.js';
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

export function Shortcuts(): JSX.Element | null {
  const { site, now } = useApp();
  const [, navigate] = useLocation();
  const { query, set } = useViewQuery();
  const [open, setOpen] = useState(false);
  const timezone = site.settings.timezone;
  const destinations = destinationsFor(site.id);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onAsked = (): void => setOpen(true);
    window.addEventListener(OPEN_SHORTCUTS, onAsked);
    return () => window.removeEventListener(OPEN_SHORTCUTS, onAsked);
  }, []);

  const table: Shortcut[] = [
    ...destinations.map((destination, index) => ({
      keys: `g ${DESTINATION_KEYS[index] ?? ''}`,
      run: () => navigate(destination.path),
    })),
    { keys: 't', run: () => set({ ...query, range: resolvePreset('today', now, timezone) }) },
    {
      keys: 'y',
      run: () => set({ ...query, range: resolvePreset('yesterday', now, timezone) }),
    },
    { keys: '7', run: () => set({ ...query, range: resolvePreset('7d', now, timezone) }) },
    { keys: '3', run: () => set({ ...query, range: resolvePreset('30d', now, timezone) }) },
    { keys: '[', run: () => set({ ...query, range: shiftRange(query.range, -1) }) },
    { keys: ']', run: () => set({ ...query, range: shiftRange(query.range, 1) }) },
    {
      keys: 'c',
      run: () => set({ ...query, compare: query.compare === null ? DEFAULT_COMPARE : null }),
    },
    { keys: 'x', run: () => set({ ...query, filters: [] }) },
    {
      keys: 'l',
      run: () => {
        const store = typeof localStorage === 'undefined' ? undefined : localStorage;
        const prefersDark =
          typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
        const next = nextChoice(readChoice(store), prefersDark);
        writeChoice(store, next);
        applyChoice(document.documentElement, next);
      },
    },
    { keys: '?', run: () => setOpen((was) => !was) },
  ];

  useShortcuts(table);

  if (!open) {
    return null;
  }

  return <ShortcutSheet groups={groupsFor(site.id)} onClose={close} />;
}

// The same table, written for a person. Built from destinationsFor so a
// destination added to the navigation cannot be missing from this card.
export function groupsFor(siteId: string): ShortcutGroup[] {
  return [
    {
      title: messages.shortcuts.groupGo,
      rows: destinationsFor(siteId).map((destination, index) => ({
        keys: ['g', DESTINATION_KEYS[index] ?? ''],
        label: destination.label,
      })),
    },
    {
      title: messages.shortcuts.groupRange,
      rows: [
        { keys: ['t'], label: messages.range.today },
        { keys: ['y'], label: messages.range.yesterday },
        { keys: ['7'], label: messages.range.last7 },
        { keys: ['3'], label: messages.range.last30 },
        { keys: ['['], label: messages.shortcuts.earlier },
        { keys: [']'], label: messages.shortcuts.later },
        { keys: ['c'], label: messages.shortcuts.compare },
      ],
    },
    {
      title: messages.shortcuts.groupView,
      rows: [
        { keys: ['x'], label: messages.shortcuts.clearFilters },
        { keys: ['l'], label: messages.shortcuts.theme },
        { keys: ['?'], label: messages.shortcuts.help },
      ],
    },
  ];
}
