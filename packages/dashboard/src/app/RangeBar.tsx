import { useState, type FormEvent, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { MAX_SEGMENTS_PER_SITE, type Filter, type Goal, type Segment } from '@chokh/store/contract';

import { api } from '../lib/api.js';
import { ChokhError } from '../lib/client.js';
import { OPERATOR_SIGNS, removeFilter } from '../lib/filters.js';
import { formatExact, formatRate } from '../lib/format.js';
import { segmentsKey, useAggregate, useGoals, useSegments } from '../lib/queries.js';
import { customRange, resolvePreset, shiftRange, type Compare, type Preset } from '../lib/range.js';
import { format, messages } from '../messages/en.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { Popover } from '../ui/Popover.js';
import popover from '../ui/Popover.module.css';
import { isOwner, useApp } from './context.js';
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

const REMOVE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 5.7 18.3 4.3 16.9 10.6 10.6 4.3 4.3 5.7 2.9 12 9.2l4.9-4.9z" />
  </svg>
);

function operatorWord(filter: Filter): string {
  return filter.op === 'is'
    ? messages.filters.is
    : filter.op === 'is_not'
      ? messages.filters.isNot
      : messages.filters.contains;
}

// A filter as a sentence: the dimension's name, the operator's word, the value.
function describe(filter: Filter): string {
  return `${DIMENSION_LABELS[filter.dim] ?? filter.dim} ${operatorWord(filter)} ${filter.value}`;
}

function Chip({ filter, onRemove }: { filter: Filter; onRemove: () => void }): JSX.Element {
  return (
    <span className={styles.chip}>
      <span className={styles.chipText}>
        <span className={styles.chipDim}>{DIMENSION_LABELS[filter.dim] ?? filter.dim}</span>{' '}
        {operatorWord(filter)} {filter.value}
      </span>
      <button
        type="button"
        className={styles.chipOff}
        onClick={onRemove}
        aria-label={`${messages.filters.remove}: ${filter.dim}${OPERATOR_SIGNS[filter.op]}${filter.value}`}
      >
        {REMOVE_ICON}
      </button>
    </span>
  );
}

// Which goal every breakdown is counted against. One list, read once and shared
// with the shell that vouches for the id in a link, so opening this costs no
// request of its own.
function GoalPicker(): JSX.Element {
  const { client, site } = useApp();
  const { query, set } = useViewQuery();
  const goals = useGoals(client, site.id);
  const list = goals.data?.data.goals ?? [];

  return (
    <Popover
      align="left"
      label={messages.goals.picker}
      trigger={({ open, toggle }) => (
        <Button variant="quiet" onClick={toggle} aria-expanded={open} aria-haspopup="true">
          {messages.goals.picker}
          <svg
            className={styles.pickerCaret}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </Button>
      )}
    >
      {({ close }) => {
        const pick = (goal: string | null): void => {
          set({ ...query, goal });
          close();
        };
        return (
          <>
            <p className={popover.heading}>{messages.goals.picker}</p>
            {goals.isError ? (
              <p className={styles.pickerNote}>{messages.states.error}</p>
            ) : goals.isPending ? null : list.length === 0 ? (
              <>
                <p className={styles.pickerNote}>{messages.goals.pickerEmpty}</p>
                <Link to={`/${site.id}/goals`} className={popover.item} onClick={close}>
                  <span>{messages.goals.pickerManage}</span>
                </Link>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={[popover.item, query.goal === null ? popover.itemCurrent : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => pick(null)}
                >
                  <span>{messages.goals.pickerNone}</span>
                </button>
                {list.map((goal) => (
                  <button
                    key={goal.id}
                    type="button"
                    className={[popover.item, query.goal === goal.id ? popover.itemCurrent : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => pick(goal.id)}
                  >
                    <span>{goal.name}</span>
                    <span className={popover.itemNote}>{goal.match}</span>
                  </button>
                ))}
              </>
            )}
          </>
        );
      }}
    </Popover>
  );
}

// Saved filter lists: apply one in a press, compare the chart against one,
// save the filters on screen as a new one, delete one. A segment is exactly
// what a report can already be narrowed by, so applying it is writing its
// filters into the link, and comparing it is one more time series with its
// filters on the same range. Saving and deleting are an owner's, the way a
// goal is (D1): the list is shared by everybody who reads the site.
function useRefreshSegments(): () => Promise<void> {
  const queryClient = useQueryClient();
  const { site } = useApp();
  return () => queryClient.invalidateQueries({ queryKey: segmentsKey(site.id) });
}

function SegmentRow({
  segment,
  owner,
  onDone,
}: {
  segment: Segment;
  owner: boolean;
  onDone: () => void;
}): JSX.Element {
  const { client, site } = useApp();
  const { query, set } = useViewQuery();
  const refresh = useRefreshSegments();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const count = segment.filters.length;

  async function remove(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api.deleteSegment(client, site.id, segment.id);
      if (query.vs === segment.id) {
        set({ ...query, vs: null });
      }
      await refresh();
    } catch (error) {
      setProblem(error instanceof ChokhError ? error.message : messages.states.error);
      setBusy(false);
    }
  }

  return (
    <div className={styles.segment}>
      <button
        type="button"
        className={popover.item}
        aria-label={format(messages.segments.apply, { name: segment.name })}
        title={segment.filters.map(describe).join(', ')}
        onClick={() => {
          set({ ...query, filters: segment.filters.map((filter) => ({ ...filter })) });
          onDone();
        }}
      >
        <span>{segment.name}</span>
        <span className={popover.itemNote}>
          {count === 1 ? messages.segments.oneFilter : format(messages.segments.filtersOf, { count })}
        </span>
      </button>
      {confirming ? (
        <div className={styles.segmentActions}>
          <span className={styles.pickerNote}>
            {format(messages.segments.deleteConfirm, { name: segment.name })}
          </span>
          {problem !== null && (
            <span className={styles.pickerNote} role="alert">
              {problem}
            </span>
          )}
          <Button onClick={() => void remove()} disabled={busy}>
            {messages.segments.deleteYes}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
            {messages.segments.deleteNo}
          </Button>
        </div>
      ) : (
        <div className={styles.segmentActions}>
          <Button
            variant="quiet"
            aria-pressed={query.vs === segment.id}
            onClick={() => {
              set({ ...query, vs: query.vs === segment.id ? null : segment.id });
              onDone();
            }}
          >
            {messages.segments.compare}
          </Button>
          {owner && (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              {messages.segments.delete}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// The filters on screen, saved under a name. Only drawn for an owner with a
// filter on; everybody else reads why in one sentence.
function SaveSegment({ onSaved }: { onSaved: () => void }): JSX.Element {
  const { client, site } = useApp();
  const { query } = useViewQuery();
  const refresh = useRefreshSegments();
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const missing = tried && name.trim() === '';

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    if (name.trim() === '') {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.createSegment(client, site.id, { name: name.trim(), filters: query.filters });
      setName('');
      setTried(false);
      await refresh();
      onSaved();
    } catch (error) {
      setProblem(
        error instanceof ChokhError && error.code === 'SEGMENT_EXISTS'
          ? messages.segments.exists
          : error instanceof ChokhError && error.code === 'SEGMENT_LIMIT'
            ? format(messages.segments.limit, { max: MAX_SEGMENTS_PER_SITE })
            : error instanceof ChokhError
              ? error.message
              : messages.states.error,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.custom} onSubmit={(event) => void submit(event)} noValidate>
      <p className={popover.heading}>{messages.segments.saveTitle}</p>
      <p className={styles.pickerNote}>{query.filters.map(describe).join(', ')}</p>
      <Field
        label={messages.segments.name}
        placeholder={messages.segments.namePlaceholder}
        maxLength={100}
        value={name}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        {...(missing ? { problem: messages.segments.required } : {})}
      />
      {problem !== null && (
        <p className={styles.pickerNote} role="alert">
          {problem}
        </p>
      )}
      <Button type="submit" variant="primary" block disabled={busy}>
        {busy ? messages.segments.saving : messages.segments.save}
      </Button>
    </form>
  );
}

function SegmentPicker(): JSX.Element {
  const { client, site, me } = useApp();
  const { query } = useViewQuery();
  const segments = useSegments(client, site.id);
  const list = segments.data?.data.segments ?? [];
  const owner = isOwner(me.teams, site.teamId);

  return (
    <Popover
      align="left"
      label={messages.segments.picker}
      trigger={({ open, toggle }) => (
        <Button
          variant="quiet"
          label={messages.segments.picker}
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="true"
        >
          {/* The word where there is room, a bookmark where there is not: on a
              phone the second row holds the arrows, the comparison, the goal,
              this and the zone, and the word pushed the zone onto a third. */}
          <span className={styles.pickerLong}>{messages.segments.picker}</span>
          <svg
            className={styles.pickerIcon}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M6 3h12v18l-6-4-6 4z" />
          </svg>
          <svg
            className={styles.pickerCaret}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </Button>
      )}
    >
      {({ close }) => (
        <>
          <p className={popover.heading}>{messages.segments.picker}</p>
          {segments.isError ? (
            <p className={styles.pickerNote}>{messages.states.error}</p>
          ) : segments.isPending ? null : list.length === 0 ? (
            <>
              <p className={styles.pickerNote}>{messages.segments.empty}</p>
              <p className={styles.pickerNote}>{messages.segments.emptyLede}</p>
            </>
          ) : (
            list.map((segment) => (
              <SegmentRow key={segment.id} segment={segment} owner={owner} onDone={close} />
            ))
          )}
          {query.filters.length > 0 &&
            (owner ? (
              <>
                <div className={popover.divider} />
                <SaveSegment onSaved={close} />
              </>
            ) : (
              <p className={styles.pickerNote}>{messages.segments.ownerOnly}</p>
            ))}
        </>
      )}
    </Popover>
  );
}

// The goal that is on, with the site-wide answer beside its name. The same
// aggregate the Overview's tiles read, so on the Overview it is no read at all.
function GoalChip({ goal }: { goal: Goal }): JSX.Element {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  const totals = useAggregate({ client, siteId: site.id, query, now });
  const conversion = totals.data?.data.conversion;

  return (
    <span className={styles.chip}>
      <span className={styles.chipText}>{format(messages.goals.chip, { name: goal.name })}</span>
      {conversion !== undefined && (
        <span className={styles.chipDim}>
          {format(messages.goals.chipSummary, {
            rate: formatRate(conversion.rate) ?? messages.states.notAvailable,
            count: formatExact(conversion.visitors),
          })}
        </span>
      )}
      <InfoDot
        label={format(messages.a11y.metricHelp, { metric: messages.metrics.conversionRate })}
        text={messages.metricHelp.conversionRate}
      />
      <button
        type="button"
        className={styles.chipOff}
        onClick={() => set({ ...query, goal: null })}
        aria-label={messages.goals.remove}
      >
        {REMOVE_ICON}
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
  const { site, now, goals, segments } = useApp();
  const { query, set, requestedGoal, requestedVs } = useViewQuery();
  const timezone = site.settings.timezone;
  const goal = query.goal === null ? undefined : goals?.find((each) => each.id === query.goal);
  // A link naming a goal the list does not have: dropped, and said so, with a
  // way to take it out of the link. A compared segment, the same.
  const goalGone = requestedGoal !== null && query.goal === null && goals !== undefined;
  const compared = query.vs === null ? undefined : segments?.find((each) => each.id === query.vs);
  const vsGone = requestedVs !== null && query.vs === null && segments !== undefined;

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

      <GoalPicker />
      <SegmentPicker />

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

      {(query.filters.length > 0 ||
        goal !== undefined ||
        goalGone ||
        compared !== undefined ||
        vsGone) && (
        <div className={styles.chips}>
          {goal !== undefined && <GoalChip goal={goal} />}
          {compared !== undefined && (
            <span className={styles.chip}>
              <span className={styles.chipText}>
                {format(messages.segments.comparing, { name: compared.name })}
              </span>
              <InfoDot
                label={format(messages.segments.comparing, { name: compared.name })}
                text={messages.segments.comparingHelp}
              />
              <button
                type="button"
                className={styles.chipOff}
                onClick={() => set({ ...query, vs: null })}
                aria-label={messages.segments.stopComparing}
              >
                {REMOVE_ICON}
              </button>
            </span>
          )}
          {vsGone && (
            <span className={[styles.chip, styles.chipWarn].join(' ')}>
              <span className={styles.chipText}>{messages.segments.gone}</span>
              <button
                type="button"
                className={styles.chipOff}
                onClick={() => set({ ...query, vs: null })}
                aria-label={messages.segments.stopComparing}
              >
                {REMOVE_ICON}
              </button>
            </span>
          )}
          {goalGone && (
            <span className={[styles.chip, styles.chipWarn].join(' ')}>
              <span className={styles.chipText}>{messages.goals.gone}</span>
              <button
                type="button"
                className={styles.chipOff}
                onClick={() => set({ ...query, goal: null })}
                aria-label={messages.goals.remove}
              >
                {REMOVE_ICON}
              </button>
            </span>
          )}
          {query.filters.map((filter) => (
            <Chip
              key={`${filter.dim}${filter.op}${filter.value}`}
              filter={filter}
              onRemove={() => set({ ...query, filters: removeFilter(query.filters, filter) })}
            />
          ))}
          {query.filters.length > 0 && (
            <button
              type="button"
              className={styles.clear}
              onClick={() => set({ ...query, filters: [] })}
            >
              {messages.filters.clear}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
