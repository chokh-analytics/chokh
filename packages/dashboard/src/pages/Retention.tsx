import { useCallback, useMemo, type JSX } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  ATTRIBUTION_DIMENSIONS,
  type ActivityResult,
  type AttributionDimension,
  type AttributionResult,
  type CohortInterval,
  type CohortResult,
  type Goal,
  type PowerUsersResult,
} from '@chokh/store/contract';
import { addDays, bucketStart, dayBounds, dayKey } from '@chokh/store/time';

import { useApp } from '../app/context.js';
import { useTabParam } from '../app/useTabParam.js';
import { identityAllowed, type RetentionWindow } from '../lib/api.js';
import {
  formatCount,
  formatDate,
  formatExact,
  formatLastSeen,
  formatRate,
  formatValue,
  timeFormatter,
} from '../lib/format.js';
import {
  useActivity,
  useAttribution,
  useCohorts,
  useGoals,
  usePowerUsers,
} from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { labelFor } from '../reports/DimensionCard.js';
import { Card } from '../ui/Card.js';
import { SelectField } from '../ui/Field.js';
import { InfoDot } from '../ui/InfoDot.js';
import { KpiRow, KpiTile } from '../ui/KpiTile.js';
import { EmptyState, ErrorState, Skeleton, Working } from '../ui/State.js';
import { TimeChart } from '../ui/TimeChart.js';
import styles from './Retention.module.css';

// Retention and attribution (AN-PPL01): who comes back, how often, and what
// brought the people who converted.
//
// Its own windows rather than the range bar's, because the range bar's
// questions are the wrong ones here: a cohort over "Today" is one cell, and
// stickiness over a day is a ratio of nothing. So a cohort grid reads the last
// twelve weeks or six months, and activity and attribution the last thirty or
// ninety days, each ending with today in the site's own calendar. Every choice
// is in the address bar, like everywhere else in this dashboard.
//
// None of these reads takes a filter (the server refuses one), and none is
// polled: a grid of who came back does not move in the half minute a live chart
// does.

const VIEWS = ['cohorts', 'activity', 'attribution'] as const;
type View = (typeof VIEWS)[number];
const INTERVALS = ['week', 'month'] as const;
const WINDOWS = ['30', '90'] as const;
const SERIES = ['dau', 'wau', 'mau'] as const;
type Series = (typeof SERIES)[number];
const GOAL_PARAM = 'goal';
const SPLIT_PARAM = 'split';

// How many cohorts each grid shows: a quarter of weeks, half a year of months.
const COHORT_COUNT: Readonly<Record<CohortInterval, number>> = { week: 12, month: 6 };
const POWER_USERS_SHOWN = 20;

const VIEW_LABELS: Readonly<Record<View, string>> = {
  cohorts: messages.retention.viewCohorts,
  activity: messages.retention.viewActivity,
  attribution: messages.retention.viewAttribution,
};

const SERIES_LABELS: Readonly<Record<Series, string>> = {
  dau: messages.retention.dau,
  wau: messages.retention.wau,
  mau: messages.retention.mau,
};

// The end of the site's today. Not now: a window that ends now has a new end
// every minute, and every minute would be a new read of every stay in it. The
// store knows which day is still running from its own clock.
function endOfToday(now: number, timezone: string): number {
  return dayBounds(dayKey(now, timezone), timezone).end;
}

export function daysWindow(now: number, days: number, timezone: string): RetentionWindow {
  const first = addDays(dayKey(now, timezone), -(days - 1));
  return { from: dayBounds(first, timezone).start, to: endOfToday(now, timezone) };
}

export function cohortWindow(now: number, interval: CohortInterval, timezone: string): RetentionWindow {
  let start = bucketStart(now, interval, timezone);
  for (let back = 1; back < COHORT_COUNT[interval]; back += 1) {
    start = bucketStart(start - 1, interval, timezone);
  }
  return { from: start, to: endOfToday(now, timezone) };
}

// A cell's shade: five bands, none of them dark enough to lose the number
// written on it, in either theme.
export function bandOf(rate: number | null): number {
  if (rate === null || rate <= 0) return -1;
  if (rate <= 0.1) return 0;
  if (rate <= 0.25) return 1;
  if (rate <= 0.5) return 2;
  if (rate <= 0.8) return 3;
  return 4;
}

const BAND_CLASS = [styles.band0, styles.band1, styles.band2, styles.band3, styles.band4];

// The day a cohort began, with its year once that is not this year's: a grid of
// "29 Dec" and "5 Jan" side by side is a grid that crossed a new year.
function cohortLabel(start: number, interval: CohortInterval, now: number, timezone: string): string {
  if (interval === 'month') {
    return timeFormatter(timezone, { month: 'short', year: 'numeric' }).format(start);
  }
  const year = timeFormatter(timezone, { year: 'numeric' });
  if (year.format(start) === year.format(now)) {
    return formatDate(start, timezone);
  }
  return timeFormatter(timezone, { day: 'numeric', month: 'short', year: 'numeric' }).format(start);
}

function useParam(name: string): { value: string | null; set: (next: string | null) => void } {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const raw = new URLSearchParams(search).get(name);
  const set = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(search);
      if (next === null) params.delete(name);
      else params.set(name, next);
      const text = params.toString();
      navigate(`${location}${text === '' ? '' : `?${text}`}`, { replace: true });
    },
    [search, location, navigate, name],
  );
  return { value: raw === null || raw === '' ? null : raw, set };
}

// A row of choices, one of them on. A radio group, because exactly one is
// chosen and the choice is the state, not a navigation.
function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}): JSX.Element {
  return (
    <div className={styles.choice} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={[styles.choiceItem, option.id === value ? styles.choiceOn : '']
            .filter(Boolean)
            .join(' ')}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Retention(): JSX.Element {
  const { site } = useApp();
  const view = useTabParam('view', VIEWS);
  const interval = useTabParam('interval', INTERVALS);
  const span = useTabParam('window', WINDOWS);
  const cookieless = site.settings.visitorIdMode === 'cookieless';

  return (
    <div className={styles.page}>
      <h1 className="sr-only">{messages.retention.title}</h1>
      <div className={styles.toolbar}>
        <div className={styles.views} role="tablist" aria-label={messages.retention.views}>
          {VIEWS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`retention-tab-${id}`}
              aria-selected={id === view.tab}
              aria-controls="retention-panel"
              className={[styles.view, id === view.tab ? styles.viewOn : ''].filter(Boolean).join(' ')}
              onClick={() => view.set(id)}
            >
              {VIEW_LABELS[id]}
            </button>
          ))}
        </div>
        {view.tab === 'cohorts' ? (
          <Choice
            label={messages.retention.window}
            options={[
              { id: 'week', label: messages.retention.weekly },
              { id: 'month', label: messages.retention.monthly },
            ]}
            value={interval.tab}
            onChange={interval.set}
          />
        ) : (
          <Choice
            label={messages.retention.window}
            options={[
              { id: '30', label: messages.retention.window30 },
              { id: '90', label: messages.retention.window90 },
            ]}
            value={span.tab}
            onChange={span.set}
          />
        )}
      </div>
      {cookieless && view.tab !== 'attribution' && (
        <p className={styles.notice} role="note">
          {messages.retention.cookieless}
        </p>
      )}
      <div
        id="retention-panel"
        role="tabpanel"
        aria-labelledby={`retention-tab-${view.tab}`}
        className={styles.stack}
      >
        {view.tab === 'cohorts' && <Cohorts interval={interval.tab} />}
        {view.tab === 'activity' && <Activity days={Number(span.tab)} />}
        {view.tab === 'attribution' && <Attribution days={Number(span.tab)} />}
      </div>
    </div>
  );
}

function RawNote({ meta }: { meta: Record<string, unknown> | undefined }): JSX.Element | null {
  const days = meta?.retentionDays;
  if (typeof days !== 'number') return null;
  return <p className={styles.rawNote}>{format(messages.retention.rawNote, { days: formatExact(days) })}</p>;
}

// ------------------------------------------------------------------- cohorts

function Cohorts({ interval }: { interval: CohortInterval }): JSX.Element {
  const { client, site, now } = useApp();
  const timezone = site.settings.timezone;
  const window = useMemo(() => cohortWindow(now, interval, timezone), [now, interval, timezone]);
  const read = useCohorts(client, site.id, window, interval);

  return (
    <Card
      title={messages.retention.cohortsTitle}
      help={<InfoDot label={messages.retention.cohortsTitle} text={messages.retention.cohortsNote} />}
    >
      {read.isFetching && !read.isPending && <Working />}
      {read.isPending ? (
        <div className={styles.loading}>
          <Skeleton height={28} />
          <Skeleton height={28} />
          <Skeleton height={28} />
          <Skeleton height={28} />
        </div>
      ) : read.isError ? (
        <ErrorState error={read.error} onRetry={() => void read.refetch()} />
      ) : (
        <>
          <CohortGrid result={read.data.data} now={now} timezone={timezone} />
          <RawNote meta={read.data.meta} />
        </>
      )}
    </Card>
  );
}

function CohortGrid({
  result,
  now,
  timezone,
}: {
  result: CohortResult;
  now: number;
  timezone: string;
}): JSX.Element {
  if (result.cohorts.every((cohort) => cohort.visitors === 0)) {
    return <EmptyState message={messages.retention.cohortsNone} />;
  }
  const columns = Math.max(...result.cohorts.map((cohort) => cohort.periods.length));
  const periodLabel = result.interval === 'week' ? messages.retention.weekN : messages.retention.monthN;
  return (
    <>
      {/* Wider than a phone at twelve weeks, so it scrolls inside its card, the
          first column held still, and the box takes focus so a keyboard can
          scroll it too. */}
      <div
        className={styles.scroll}
        tabIndex={0}
        role="group"
        aria-label={messages.retention.cohortsCaption}
      >
        <table className={styles.grid}>
          <caption className="sr-only">{messages.retention.cohortsCaption}</caption>
          <thead>
            <tr>
              <th scope="col" className={[styles.sticky, styles.headCell].join(' ')}>
                {messages.retention.cohortColumn}
              </th>
              <th scope="col" className={[styles.headCell, styles.num].join(' ')}>
                {messages.retention.cohortPeople}
              </th>
              {Array.from({ length: columns }, (_, index) => (
                <th key={index} scope="col" className={[styles.headCell, styles.num].join(' ')}>
                  {format(periodLabel, { n: index })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.cohorts.map((cohort) => {
              const label = cohortLabel(cohort.start, result.interval, now, timezone);
              return (
                <tr key={cohort.start}>
                  <th scope="row" className={[styles.sticky, styles.rowHead].join(' ')}>
                    {result.interval === 'week' ? (
                      <>
                        <span className="sr-only">{format(messages.retention.weekOf, { date: label })}</span>
                        <span aria-hidden="true">{label}</span>
                      </>
                    ) : (
                      label
                    )}
                  </th>
                  <td className={[styles.cell, styles.num, styles.size].join(' ')}>
                    {formatCount(cohort.visitors)}
                  </td>
                  {Array.from({ length: columns }, (_, index) => {
                    const period = cohort.periods[index];
                    if (period === undefined) {
                      return <td key={index} className={styles.cell} aria-hidden="true" />;
                    }
                    if (cohort.visitors === 0) {
                      return (
                        <td key={index} className={[styles.cell, styles.num, styles.nobody].join(' ')}>
                          <span className="sr-only">{messages.retention.cohortEmpty}</span>
                        </td>
                      );
                    }
                    const band = bandOf(period.rate);
                    const words = format(
                      period.complete ? messages.retention.cellTitle : messages.retention.cellRunning,
                      { count: formatExact(period.visitors), size: formatExact(cohort.visitors) },
                    );
                    return (
                      <td
                        key={index}
                        title={words}
                        className={[
                          styles.cell,
                          styles.num,
                          styles.heat,
                          band < 0 ? styles.zero : BAND_CLASS[band],
                          period.complete ? '' : styles.running,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {formatRate(period.rate)}
                        <span className="sr-only">{`, ${words}`}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.hint}>{messages.retention.scrollHint}</p>
    </>
  );
}

// ------------------------------------------------------------------ activity

function Activity({ days }: { days: number }): JSX.Element {
  const { client, site, now } = useApp();
  const timezone = site.settings.timezone;
  const window = useMemo(() => daysWindow(now, days, timezone), [now, days, timezone]);
  const read = useActivity(client, site.id, window);
  const series = useTabParam('series', SERIES);
  const data: ActivityResult | undefined = read.data?.data;
  const loading = read.isPending;

  const points = (data?.days ?? []).map((day) => ({ start: day.start, value: day[series.tab] }));
  const last = data?.days[data.days.length - 1];
  const failed = read.isError ? () => void read.refetch() : undefined;
  const whole = (value: number | null | undefined): string | null =>
    value === null || value === undefined ? null : formatCount(Math.round(value));

  return (
    <>
      <KpiRow>
        {SERIES.map((id) => (
          <KpiTile
            key={id}
            label={SERIES_LABELS[id]}
            value={whole(data?.[id])}
            help={
              id === 'dau'
                ? messages.retention.dauHelp
                : id === 'wau'
                  ? messages.retention.wauHelp
                  : messages.retention.mauHelp
            }
            loading={loading}
            selected={series.tab === id}
            onSelect={() => series.set(id)}
            {...(failed === undefined ? {} : { onRetry: failed })}
          />
        ))}
        <KpiTile
          label={messages.retention.stickiness}
          value={formatRate(data?.stickiness)}
          help={messages.retention.stickinessHelp}
          loading={loading}
          {...(failed === undefined ? {} : { onRetry: failed })}
        />
        <KpiTile
          label={messages.retention.returning}
          value={formatRate(data?.returningRate)}
          help={messages.retention.returningHelp}
          {...(data === undefined
            ? {}
            : {
                title: format(messages.retention.returningOf, {
                  count: formatExact(data.returning),
                  total: formatExact(data.visitors),
                }),
              })}
          loading={loading}
          {...(failed === undefined ? {} : { onRetry: failed })}
        />
        <KpiTile
          label={messages.retention.powerUsers}
          value={data === undefined ? null : formatCount(data.powerUsers)}
          help={format(messages.retention.powerUsersHelp, {
            days: formatExact(data?.powerMinDays ?? Math.ceil(days / 3)),
          })}
          loading={loading}
          {...(failed === undefined ? {} : { onRetry: failed })}
        />
      </KpiRow>
      {read.isError ? (
        <Card title={messages.retention.activeChart}>
          <ErrorState error={read.error} onRetry={() => void read.refetch()} />
        </Card>
      ) : (
        <TimeChart
          title={messages.retention.activeChart}
          points={points}
          interval="day"
          timezone={timezone}
          metricLabel={SERIES_LABELS[series.tab]}
          loading={loading}
          live={last !== undefined && !last.complete}
          rangeEnd={window.to}
        />
      )}
      <Curve read={read} />
      <PowerUsers days={days} window={window} />
    </>
  );
}

function Curve({ read }: { read: ReturnType<typeof useActivity> }): JSX.Element {
  const curve = read.data?.data.curve ?? [];
  const max = Math.max(0, ...curve);
  // About six labels whatever the window, so ninety days on a phone is 1, 15,
  // 30 and on rather than ninety digits on top of each other.
  const tickEvery = curve.length <= 30 ? 5 : 15;
  return (
    <Card
      title={messages.retention.curveTitle}
      help={<InfoDot label={messages.retention.curveTitle} text={messages.retention.curveNote} />}
    >
      {read.isPending ? (
        <div className={styles.loading}>
          <Skeleton height={140} />
        </div>
      ) : read.isError ? (
        <ErrorState error={read.error} onRetry={() => void read.refetch()} />
      ) : max === 0 ? (
        <EmptyState message={messages.retention.curveEmpty} />
      ) : (
        <>
          <div className={styles.curve} aria-hidden="true">
            {curve.map((count, index) => {
              const days = index + 1;
              const words =
                days === 1
                  ? format(messages.retention.curveBarOne, { count: formatExact(count) })
                  : format(messages.retention.curveBar, {
                      count: formatExact(count),
                      days: formatExact(days),
                    });
              return (
                <div key={days} className={styles.curveSlot} title={words}>
                  <div
                    className={styles.curveBar}
                    style={{ height: `${count === 0 ? 0 : Math.max(2, (count / max) * 100)}%` }}
                  />
                  <span className={styles.curveTick}>
                    {days === 1 || days % tickEvery === 0 ? String(days) : ''}
                  </span>
                </div>
              );
            })}
          </div>
          <p className={styles.axis} aria-hidden="true">
            {messages.retention.curveDays}
          </p>
          {/* Hidden in a box rather than on the table: a table grows to its
              content whatever width it is given, and pushed the page sideways. */}
          <div className="sr-only">
            <table>
              <caption>{messages.retention.curveCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{messages.retention.curveDays}</th>
                  <th scope="col">{messages.retention.cohortPeople}</th>
                </tr>
              </thead>
              <tbody>
                {curve.map((count, index) => (
                  <tr key={index}>
                    <th scope="row">{index + 1}</th>
                    <td>{formatExact(count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function PowerUsers({ days, window }: { days: number; window: RetentionWindow }): JSX.Element {
  const { client, site, now } = useApp();
  const timezone = site.settings.timezone;
  const read = usePowerUsers(client, site.id, window, POWER_USERS_SHOWN);
  const result: PowerUsersResult | undefined = read.data?.data;
  const identity = identityAllowed(read.data?.meta);

  return (
    <Card
      title={messages.retention.mostActive}
      help={<InfoDot label={messages.retention.mostActive} text={messages.retention.mostActiveNote} />}
    >
      {read.isFetching && !read.isPending && <Working />}
      {read.isPending ? (
        <div className={styles.loading}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : read.isError ? (
        <ErrorState error={read.error} onRetry={() => void read.refetch()} />
      ) : result === undefined || result.people.length === 0 ? (
        <EmptyState
          message={format(messages.retention.mostActiveNone, {
            days: formatExact(result?.minDays ?? Math.ceil(days / 3)),
          })}
        />
      ) : (
        <div
          className={styles.scroll}
          tabIndex={0}
          role="group"
          aria-label={messages.retention.mostActiveCaption}
        >
          <table className={styles.table}>
            <caption className="sr-only">{messages.retention.mostActiveCaption}</caption>
            <thead>
              <tr>
                <th scope="col" className={styles.headCell}>
                  {messages.people.person}
                </th>
                <th scope="col" className={[styles.headCell, styles.num].join(' ')}>
                  {messages.retention.activeDays}
                </th>
                <th scope="col" className={[styles.headCell, styles.num].join(' ')}>
                  {messages.people.visits}
                </th>
                <th scope="col" className={styles.headCell}>
                  {messages.people.lastSeenColumn}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.people.map((row) => {
                const given = identity ? (row.traits?.name ?? row.traits?.email ?? row.userId) : undefined;
                return (
                  <tr key={row.visitorId} className={styles.row}>
                    <td className={styles.cell}>
                      <Link
                        href={`/${site.id}/people/v/${encodeURIComponent(row.visitorId)}`}
                        className={styles.link}
                      >
                        <span className={styles.who}>
                          <span className={styles.whoName}>{given ?? messages.identity.anonymous}</span>
                          <span className={styles.whoId}>{row.visitorId.slice(0, 10)}</span>
                        </span>
                      </Link>
                    </td>
                    <td className={[styles.cell, styles.num].join(' ')}>
                      {format(messages.retention.activeDaysOf, {
                        count: formatExact(row.activeDays),
                        days: formatExact(result.days),
                      })}
                    </td>
                    <td className={[styles.cell, styles.num].join(' ')} title={formatExact(row.visits)}>
                      {formatCount(row.visits)}
                    </td>
                    <td
                      className={[styles.cell, styles.when].join(' ')}
                      title={new Date(row.lastSeenAt).toISOString()}
                    >
                      {formatLastSeen(row.lastSeenAt, now, timezone)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------- attribution

const SPLIT_OPTIONS = ATTRIBUTION_DIMENSIONS.map((dim) => ({
  value: dim,
  label: messages.dimensions[dim],
}));

function isSplit(value: string | null): value is AttributionDimension {
  return value !== null && (ATTRIBUTION_DIMENSIONS as readonly string[]).includes(value);
}

function Attribution({ days }: { days: number }): JSX.Element {
  const { client, site, now } = useApp();
  const [, navigate] = useLocation();
  const timezone = site.settings.timezone;
  const window = useMemo(() => daysWindow(now, days, timezone), [now, days, timezone]);
  const goals = useGoals(client, site.id);
  const goalParam = useParam(GOAL_PARAM);
  const splitParam = useParam(SPLIT_PARAM);
  const list: Goal[] = goals.data?.data.goals ?? [];
  const goal = list.find((candidate) => candidate.id === goalParam.value) ?? list[0] ?? null;
  const dim: AttributionDimension = isSplit(splitParam.value) ? splitParam.value : 'channel';
  const read = useAttribution(client, site.id, window, goal?.id ?? null, dim);

  if (goals.isPending) {
    return (
      <Card title={messages.retention.attributionTitle}>
        <div className={styles.loading}>
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      </Card>
    );
  }
  if (goals.isError) {
    return (
      <Card title={messages.retention.attributionTitle}>
        <ErrorState error={goals.error} onRetry={() => void goals.refetch()} />
      </Card>
    );
  }
  if (goal === null) {
    return (
      <Card title={messages.retention.attributionTitle}>
        <EmptyState
          message={messages.retention.noGoals}
          action={{ label: messages.retention.addGoal, onClick: () => navigate(`/${site.id}/goals`) }}
        />
      </Card>
    );
  }

  return (
    <Card
      title={messages.retention.attributionTitle}
      help={
        <InfoDot label={messages.retention.attributionTitle} text={messages.retention.attributionNote} />
      }
    >
      <div className={styles.pickers}>
        <SelectField
          label={messages.retention.goal}
          options={list.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
          value={goal.id}
          onChange={(event) => goalParam.set(event.target.value)}
        />
        <SelectField
          label={messages.retention.splitBy}
          options={SPLIT_OPTIONS}
          value={dim}
          onChange={(event) => splitParam.set(event.target.value === 'channel' ? null : event.target.value)}
        />
      </div>
      {read.isFetching && !read.isPending && <Working />}
      {read.isPending ? (
        <div className={styles.loading}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : read.isError ? (
        <ErrorState error={read.error} onRetry={() => void read.refetch()} />
      ) : read.data.data.visitors === 0 ? (
        <EmptyState message={messages.retention.nobodyConverted} />
      ) : (
        <>
          <AttributionTable result={read.data.data} />
          <RawNote meta={read.data.meta} />
        </>
      )}
    </Card>
  );
}

function AttributionTable({ result }: { result: AttributionResult }): JSX.Element {
  const total = result.visitors;
  const rows = [...result.rows];
  const otherCount = result.other.first.visitors + result.other.last.visitors;
  const label = (key: string): string => (key === '' ? messages.retention.none : labelFor(result.dim, key));
  const bar = (visitors: number, tone: string): JSX.Element => {
    const share = total === 0 ? 0 : visitors / total;
    return (
      <div className={styles.barCell}>
        <span className={styles.barTrack} aria-hidden="true">
          <span className={[styles.barFill, tone].join(' ')} style={{ width: `${share * 100}%` }} />
        </span>
        <span className={styles.barValue}>
          {formatCount(visitors)}
          <span className={styles.barShare}>{formatRate(share)}</span>
        </span>
      </div>
    );
  };
  return (
    <>
      <p className={styles.summary}>
        {result.value === null
          ? format(messages.retention.converted, {
              count: formatExact(result.visitors),
              completions: formatExact(result.completions),
            })
          : format(messages.retention.convertedValue, {
              count: formatExact(result.visitors),
              completions: formatExact(result.completions),
              value: formatValue(result.value),
            })}
      </p>
      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem}>
          <span className={[styles.swatch, styles.first].join(' ')} />
          {messages.retention.firstTouch}
        </span>
        <span className={styles.legendItem}>
          <span className={[styles.swatch, styles.last].join(' ')} />
          {messages.retention.lastTouch}
        </span>
      </div>
      <div
        className={styles.scroll}
        tabIndex={0}
        role="group"
        aria-label={messages.retention.attributionCaption}
      >
        <table className={styles.table}>
          <caption className="sr-only">{messages.retention.attributionCaption}</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.headCell}>
                {messages.dimensions[result.dim]}
              </th>
              <th scope="col" className={styles.headCell}>
                {messages.retention.firstTouch}
              </th>
              <th scope="col" className={styles.headCell}>
                {messages.retention.lastTouch}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={styles.row}>
                <th scope="row" className={[styles.cell, styles.keyCell].join(' ')} title={row.key}>
                  {label(row.key)}
                </th>
                <td className={styles.cell}>{bar(row.first.visitors, styles.first ?? '')}</td>
                <td className={styles.cell}>{bar(row.last.visitors, styles.last ?? '')}</td>
              </tr>
            ))}
            {otherCount > 0 && (
              <tr className={styles.row}>
                <th scope="row" className={[styles.cell, styles.keyCell].join(' ')}>
                  {messages.retention.other}
                </th>
                <td className={styles.cell}>{bar(result.other.first.visitors, styles.first ?? '')}</td>
                <td className={styles.cell}>{bar(result.other.last.visitors, styles.last ?? '')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
