import { useState, type JSX } from 'react';
import type { Filter } from '@chokh/store/contract';

import { OPERATOR_SIGNS, removeFilter } from '../lib/filters.js';
import { customRange, resolvePreset, shiftRange, type Compare, type Preset } from '../lib/range.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Popover } from '../ui/Popover.js';
import popover from '../ui/Popover.module.css';
import { useApp } from './context.js';
import { useViewQuery } from './useViewQuery.js';
import styles from './RangeBar.module.css';

// The window, the comparison and the filters, in the one row that is on every
// report page.

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: messages.range.today },
  { id: 'yesterday', label: messages.range.yesterday },
  { id: '7d', label: messages.range.last7 },
  { id: '30d', label: messages.range.last30 },
];

const COMPARES: { id: Compare | 'off'; label: string }[] = [
  { id: 'previous_period', label: messages.range.comparePrevious },
  { id: 'previous_year', label: messages.range.comparePreviousYear },
  { id: 'off', label: messages.range.compareOff },
];

const DIMENSION_LABELS = messages.dimensions as Record<string, string>;

function Chip({ filter, onRemove }: { filter: Filter; onRemove: () => void }): JSX.Element {
  return (
    <span className={styles.chip}>
      <span className={styles.chipText}>
        <span className={styles.chipDim}>{DIMENSION_LABELS[filter.dim] ?? filter.dim}</span>{' '}
        {filter.op === 'is'
          ? messages.filters.is
          : filter.op === 'is_not'
            ? messages.filters.isNot
            : messages.filters.contains}{' '}
        {filter.value}
      </span>
      <button
        type="button"
        className={styles.chipOff}
        onClick={onRemove}
        aria-label={`${messages.filters.remove}: ${filter.dim}${OPERATOR_SIGNS[filter.op]}${filter.value}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 5.7 18.3 4.3 16.9 10.6 10.6 4.3 4.3 5.7 2.9 12 9.2l4.9-4.9z" />
        </svg>
      </button>
    </span>
  );
}

function CustomRange({ close }: { close: () => void }): JSX.Element {
  const { site } = useApp();
  const { query, set } = useViewQuery();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  return (
    <form
      className={styles.custom}
      onSubmit={(event) => {
        event.preventDefault();
        if (from === '' || to === '') {
          return;
        }
        set({ ...query, range: customRange(from, to, site.settings.timezone), interval: null });
        close();
      }}
    >
      <div className={styles.customRow}>
        <Field
          label={messages.range.customFrom}
          type="date"
          required
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Field
          label={messages.range.customTo}
          type="date"
          required
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      <Button type="submit" variant="primary" block>
        {messages.range.apply}
      </Button>
    </form>
  );
}

export function RangeBar(): JSX.Element {
  const { site, now } = useApp();
  const { query, set } = useViewQuery();
  const timezone = site.settings.timezone;

  return (
    <div className={styles.bar}>
      <div className={styles.group} role="group" aria-label={messages.range.presets}>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={[styles.preset, query.range.preset === preset.id ? styles.presetCurrent : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={query.range.preset === preset.id}
            onClick={() =>
              set({ ...query, range: resolvePreset(preset.id, now, timezone), interval: null })
            }
          >
            {preset.label}
          </button>
        ))}
        <Popover
          align="left"
          label={messages.range.custom}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              className={[
                styles.preset,
                query.range.preset === 'custom' ? styles.presetCurrent : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-expanded={open}
              onClick={toggle}
            >
              {messages.range.custom}
            </button>
          )}
        >
          {({ close }) => <CustomRange close={close} />}
        </Popover>
      </div>

      {/* Walking a window back and forward by its own length is how somebody
          reads week over week without opening a calendar. */}
      <div className={styles.step}>
        <Button
          variant="quiet"
          label={messages.range.earlier}
          onClick={() => set({ ...query, range: shiftRange(query.range, -1) })}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M15 6l-6 6 6 6z" />
          </svg>
        </Button>
        <Button
          variant="quiet"
          label={messages.range.later}
          onClick={() => set({ ...query, range: shiftRange(query.range, 1) })}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 6l6 6-6 6z" />
          </svg>
        </Button>
      </div>

      <Popover
        align="left"
        label={messages.range.compare}
        trigger={({ open, toggle }) => (
          <Button variant="quiet" onClick={toggle} aria-expanded={open}>
            {query.compare === null
              ? messages.range.compareOff
              : query.compare === 'previous_year'
                ? messages.range.comparePreviousYear
                : messages.range.comparePrevious}
          </Button>
        )}
      >
        {({ close }) => (
          <>
            <p className={popover.heading}>{messages.range.compare}</p>
            {COMPARES.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={[
                  popover.item,
                  (query.compare ?? 'off') === candidate.id ? popover.itemCurrent : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  set({ ...query, compare: candidate.id === 'off' ? null : candidate.id });
                  close();
                }}
              >
                <span>{candidate.label}</span>
              </button>
            ))}
          </>
        )}
      </Popover>

      <span className={styles.spacer} />
      {/*
        The full sentence where there is room for it, the zone alone where there
        is not. On a phone this is the tail of the row that already says which
        window is on screen, so "Times in" is a preamble to something already
        said, and it was what pushed this onto a third row of its own.
      */}
      <span className={styles.zone} title={format(messages.range.timezoneNote, { timezone })}>
        <span className={styles.zoneLong}>
          {format(messages.range.timezoneNote, { timezone })}
        </span>
        <span className={styles.zoneShort}>{timezone}</span>
      </span>

      {query.filters.length > 0 && (
        <div className={styles.chips}>
          {query.filters.map((filter) => (
            <Chip
              key={`${filter.dim}${filter.op}${filter.value}`}
              filter={filter}
              onRemove={() => set({ ...query, filters: removeFilter(query.filters, filter) })}
            />
          ))}
          <button
            type="button"
            className={styles.clear}
            onClick={() => set({ ...query, filters: [] })}
          >
            {messages.filters.clear}
          </button>
        </div>
      )}
    </div>
  );
}
