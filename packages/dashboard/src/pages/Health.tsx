import { useMemo, type JSX } from 'react';
import { Link } from 'wouter';
import { addDays, dayBounds, dayKey } from '@chokh/store/time';
import {
  VITAL_METRICS,
  type CoverageResult,
  type ErrorGroup,
  type ErrorsResult,
  type VitalFigure,
  type VitalMetric,
  type VitalRating,
  type VitalsResult,
} from '@chokh/store/health';

import { useApp } from '../app/context.js';
import { useTabParam } from '../app/useTabParam.js';
import {
  formatCount,
  formatExact,
  formatLastSeen,
  formatRate,
  formatVital,
} from '../lib/format.js';
import type { RetentionWindow } from '../lib/api.js';
import { useCoverage, useErrors, useVitals } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Card } from '../ui/Card.js';
import { InfoDot } from '../ui/InfoDot.js';
import { KpiRow, KpiTile } from '../ui/KpiTile.js';
import { EmptyState, ErrorState, Skeleton, Working } from '../ui/State.js';
import styles from './Health.module.css';

// Health (AN-VIT01): how fast the pages are for the people reading them, what
// breaks in their browsers, and how much of the signed-in traffic the tracker
// never sees.
//
// Its own windows, like Retention's: a p75 over "Today" is a handful of page
// loads, and Core Web Vitals are read over 28 days everywhere else, so that is
// the default here, with 7 and 90 beside it, each ending with the site's today.
// Every choice is in the address bar. None of these reads takes a filter and
// none is polled.

const VIEWS = ['vitals', 'errors', 'coverage'] as const;
type View = (typeof VIEWS)[number];
// The first is the default.
const WINDOWS = ['28', '7', '90'] as const;
const DEVICES = ['all', 'desktop', 'mobile', 'tablet'] as const;
type DeviceChoice = (typeof DEVICES)[number];
const CORE: readonly VitalMetric[] = ['LCP', 'INP', 'CLS'];

// The last days of the site's calendar, ending with the end of its today rather
// than now, so the window and its cache key move once a day and not every
// minute. The store knows which day is still running from its own clock.
export function healthWindow(now: number, days: number, timezone: string): RetentionWindow {
  const today = dayKey(now, timezone);
  return {
    from: dayBounds(addDays(today, -(days - 1)), timezone).start,
    to: dayBounds(today, timezone).end,
  };
}

const VIEW_LABELS: Readonly<Record<View, string>> = {
  vitals: messages.health.viewVitals,
  errors: messages.health.viewErrors,
  coverage: messages.health.viewCoverage,
};

const WINDOW_LABELS: Readonly<Record<(typeof WINDOWS)[number], string>> = {
  '7': messages.health.window7,
  '28': messages.health.window28,
  '90': messages.health.window90,
};

const DEVICE_LABELS: Readonly<Record<string, string>> = {
  all: messages.health.deviceAll,
  desktop: messages.health.desktop,
  mobile: messages.health.mobile,
  tablet: messages.health.tablet,
  '': messages.health.deviceUnknown,
};

const METRIC_NAMES: Readonly<Record<VitalMetric, string>> = {
  LCP: messages.health.lcp,
  INP: messages.health.inp,
  CLS: messages.health.cls,
  FCP: messages.health.fcp,
  TTFB: messages.health.ttfb,
};

const METRIC_HELP: Readonly<Record<VitalMetric, string>> = {
  LCP: messages.health.lcpHelp,
  INP: messages.health.inpHelp,
  CLS: messages.health.clsHelp,
  FCP: messages.health.fcpHelp,
  TTFB: messages.health.ttfbHelp,
};

const RATING_WORDS: Readonly<Record<VitalRating, string>> = {
  good: messages.health.good,
  'needs-improvement': messages.health.needsImprovement,
  poor: messages.health.poor,
};

const RATING_CLASS: Readonly<Record<VitalRating, string | undefined>> = {
  good: styles.good,
  'needs-improvement': styles.needs,
  poor: styles.poor,
};

// A Core Web Vitals band is said three ways at once: a word, a shape and a
// colour, so nobody needs to tell green from amber to read it. A circle for
// good, a triangle for needs improvement, a square for poor.
export function RatingMark({ rating }: { rating: VitalRating }): JSX.Element {
  return (
    <span className={[styles.mark, RATING_CLASS[rating]].filter(Boolean).join(' ')}>
      <svg className={styles.shape} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        {rating === 'good' ? (
          <circle cx="5" cy="5" r="4" />
        ) : rating === 'needs-improvement' ? (
          <path d="M5 1 L9.2 9 L0.8 9 Z" />
        ) : (
          <rect x="1.2" y="1.2" width="7.6" height="7.6" />
        )}
      </svg>
      {RATING_WORDS[rating]}
    </span>
  );
}

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

function RawNote({ meta }: { meta: Record<string, unknown> | undefined }): JSX.Element | null {
  const days = meta?.retentionDays;
  if (typeof days !== 'number') return null;
  return (
    <p className={styles.note}>{format(messages.health.rawNote, { days: formatExact(days) })}</p>
  );
}

// The line a page needs to send what this view reads, with the install's own
// address in it.
function ScriptLine({ file }: { file: 'v.js' | 'e.js' }): JSX.Element {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <pre className={styles.code} tabIndex={0}>
      <code>{`<script defer src="${origin}/${file}"></script>`}</code>
    </pre>
  );
}

export function Health(): JSX.Element {
  const view = useTabParam('view', VIEWS);
  const span = useTabParam('window', WINDOWS);

  return (
    <div className={styles.page}>
      <h1 className="sr-only">{messages.health.title}</h1>
      <div className={styles.toolbar}>
        <div className={styles.views} role="tablist" aria-label={messages.health.views}>
          {VIEWS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`health-tab-${id}`}
              aria-selected={id === view.tab}
              aria-controls="health-panel"
              className={[styles.view, id === view.tab ? styles.viewOn : ''].filter(Boolean).join(' ')}
              onClick={() => view.set(id)}
            >
              {VIEW_LABELS[id]}
            </button>
          ))}
        </div>
        <Choice
          label={messages.health.window}
          options={(['7', '28', '90'] as const).map((id) => ({ id, label: WINDOW_LABELS[id] }))}
          value={span.tab}
          onChange={span.set}
        />
      </div>
      <div
        id="health-panel"
        role="tabpanel"
        aria-labelledby={`health-tab-${view.tab}`}
        className={styles.stack}
      >
        {view.tab === 'vitals' && <Vitals days={Number(span.tab)} />}
        {view.tab === 'errors' && <Errors days={Number(span.tab)} />}
        {view.tab === 'coverage' && <Coverage days={Number(span.tab)} />}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- vitals

function figureValue(metric: VitalMetric, figure: VitalFigure | undefined): string | null {
  return figure === undefined ? null : formatVital(metric, figure.p75);
}

function TooFew({ figure }: { figure: VitalFigure }): JSX.Element {
  return (
    <span className={styles.tooFew}>
      {figure.samples === 0
        ? messages.health.noSamples
        : format(messages.health.tooFew, { count: formatExact(figure.samples) })}
    </span>
  );
}

function Shares({ metric, result }: { metric: VitalMetric; result: VitalsResult }): JSX.Element | null {
  const summary = result.metrics.find((each) => each.metric === metric);
  const shares = summary?.shares;
  if (shares === null || shares === undefined) return null;
  const parts: { rating: VitalRating; share: number }[] = [
    { rating: 'good', share: shares.good },
    { rating: 'needs-improvement', share: shares.needsImprovement },
    { rating: 'poor', share: shares.poor },
  ];
  return (
    <div className={styles.shares}>
      <div className={styles.bar} aria-hidden="true">
        {parts.map((part) =>
          part.share > 0 ? (
            <span
              key={part.rating}
              className={[styles.segment, RATING_CLASS[part.rating]].filter(Boolean).join(' ')}
              style={{ flexGrow: part.share }}
            />
          ) : null,
        )}
      </div>
      <ul className={styles.legend}>
        {parts.map((part) => (
          <li key={part.rating}>
            <RatingMark rating={part.rating} />
            <span className={styles.legendValue}>{formatRate(part.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VitalCard({ metric, result }: { metric: VitalMetric; result: VitalsResult }): JSX.Element {
  const summary = result.metrics.find((each) => each.metric === metric);
  const devices = summary?.devices ?? [];
  return (
    <section className={styles.vital} aria-label={METRIC_NAMES[metric]}>
      <h3 className={styles.vitalHead}>
        <abbr title={METRIC_NAMES[metric]}>{metric}</abbr>
        <InfoDot label={METRIC_NAMES[metric]} text={METRIC_HELP[metric]} />
      </h3>
      <p className={styles.vitalName}>{METRIC_NAMES[metric]}</p>
      {summary === undefined || summary.p75 === null || summary.rating === null ? (
        summary === undefined ? null : <TooFew figure={summary} />
      ) : (
        <>
          <p className={styles.vitalValue} title={messages.health.p75}>
            <span className="sr-only">{messages.health.p75}</span>
            <span>{formatVital(metric, summary.p75)}</span>
          </p>
          <RatingMark rating={summary.rating} />
          <p className={styles.samples}>
            {format(messages.health.samples, { count: formatExact(summary.samples) })}
          </p>
          <Shares metric={metric} result={result} />
        </>
      )}
      {devices.length > 0 && (
        <ul className={styles.devices} aria-label={messages.health.byDevice}>
          {devices.map((device) => (
            <li key={device.device}>
              <span className={styles.deviceName}>{DEVICE_LABELS[device.device] ?? device.device}</span>
              {device.p75 === null || device.rating === null ? (
                <TooFew figure={device} />
              ) : (
                <span className={styles.deviceValue}>
                  {formatVital(metric, device.p75)}
                  <RatingMark rating={device.rating} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Vitals({ days }: { days: number }): JSX.Element {
  const { client, site, now } = useApp();
  const timezone = site.settings.timezone;
  const window = useMemo(() => healthWindow(now, days, timezone), [now, days, timezone]);
  const device = useTabParam('device', DEVICES);
  const sort = useTabParam('sort', VITAL_METRICS);
  const read = useVitals(
    client,
    site.id,
    window,
    device.tab === 'all' ? null : device.tab,
    sort.tab,
  );
  const result = read.data?.data;
  const measured = result?.metrics.some((each) => each.samples > 0) ?? false;

  return (
    <>
      <div className={styles.toolbar}>
        <Choice<DeviceChoice>
          label={messages.health.device}
          options={DEVICES.map((id) => ({ id, label: DEVICE_LABELS[id] ?? id }))}
          value={device.tab}
          onChange={device.set}
        />
      </div>
      <Card
        title={messages.health.vitalsTitle}
        help={<InfoDot label={messages.health.vitalsTitle} text={messages.health.vitalsNote} />}
      >
        {read.isFetching && !read.isPending && <Working />}
        {read.isPending ? (
          <div className={styles.vitals}>
            {CORE.map((metric) => (
              <Skeleton key={metric} height={180} />
            ))}
          </div>
        ) : read.isError ? (
          <ErrorState error={read.error} onRetry={() => void read.refetch()} />
        ) : !measured || result === undefined ? (
          <div className={styles.empty}>
            <EmptyState message={messages.health.vitalsNone} />
            <ScriptLine file="v.js" />
          </div>
        ) : (
          <>
            <div className={styles.vitals}>
              {CORE.map((metric) => (
                <VitalCard key={metric} metric={metric} result={result} />
              ))}
            </div>
            <h3 className={styles.subhead}>{messages.health.supporting}</h3>
            <div className={styles.vitals}>
              {(['FCP', 'TTFB'] as const).map((metric) => (
                <VitalCard key={metric} metric={metric} result={result} />
              ))}
            </div>
            <RawNote meta={read.data?.meta} />
          </>
        )}
      </Card>
      <Card
        title={messages.health.slowTitle}
        help={<InfoDot label={messages.health.slowTitle} text={messages.health.slowNote} />}
      >
        <div className={styles.cardBar}>
          <Choice<VitalMetric>
            label={messages.health.sortBy}
            options={VITAL_METRICS.map((id) => ({ id, label: id }))}
            value={sort.tab}
            onChange={sort.set}
          />
        </div>
        {read.isPending ? (
          <div className={styles.loading}>
            <Skeleton height={28} />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        ) : read.isError ? (
          <ErrorState error={read.error} onRetry={() => void read.refetch()} />
        ) : result === undefined || result.pages.length === 0 ? (
          <EmptyState message={messages.health.pagesNone} />
        ) : (
          <SlowPages result={result} />
        )}
      </Card>
    </>
  );
}

function SlowPages({ result }: { result: VitalsResult }): JSX.Element {
  return (
    <>
      <div className={styles.scroll} tabIndex={0} role="group" aria-label={messages.health.slowCaption}>
        <table className={styles.table}>
          <caption className="sr-only">{messages.health.slowCaption}</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.headCell}>
                {messages.health.page}
              </th>
              {VITAL_METRICS.map((metric) => (
                <th
                  key={metric}
                  scope="col"
                  className={[styles.headCell, styles.num, metric === result.sort ? styles.sorted : '']
                    .filter(Boolean)
                    .join(' ')}
                  {...(metric === result.sort ? { 'aria-sort': 'descending' as const } : {})}
                >
                  <abbr title={METRIC_NAMES[metric]}>{metric}</abbr>
                </th>
              ))}
              <th scope="col" className={[styles.headCell, styles.num].join(' ')}>
                {messages.health.samplesColumn}
              </th>
            </tr>
          </thead>
          <tbody>
            {result.pages.map((page) => (
              <tr key={page.page}>
                <th scope="row" className={styles.pageCell} title={page.page}>
                  {page.page === '' ? messages.health.noPage : page.page}
                </th>
                {VITAL_METRICS.map((metric) => {
                  const figure = page.metrics[metric];
                  const value = figureValue(metric, figure);
                  return (
                    <td key={metric} className={[styles.cell, styles.num].join(' ')}>
                      {figure === undefined ? (
                        <span className={styles.dim}>{messages.health.dash}</span>
                      ) : value === null || figure.rating === null ? (
                        <span className={styles.dim}>{messages.health.tooFewShort}</span>
                      ) : (
                        <span className={styles.cellValue}>
                          {value}
                          <RatingMark rating={figure.rating} />
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className={[styles.cell, styles.num, styles.dim].join(' ')}>
                  {formatCount(page.samples)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        {result.pagesTotal > result.pages.length
          ? format(messages.health.pagesMore, {
              shown: formatExact(result.pages.length),
              total: formatExact(result.pagesTotal),
              min: formatExact(result.minSamples),
            })
          : format(messages.health.pagesMin, { min: formatExact(result.minSamples) })}
      </p>
    </>
  );
}

// -------------------------------------------------------------------- errors

function Errors({ days }: { days: number }): JSX.Element {
  const { client, site, now } = useApp();
  const timezone = site.settings.timezone;
  const window = useMemo(() => healthWindow(now, days, timezone), [now, days, timezone]);
  const read = useErrors(client, site.id, window);
  const data: ErrorsResult | undefined = read.data?.data;
  const capture = read.data?.meta?.errorCapture === true;
  const failed = read.isError ? () => void read.refetch() : undefined;

  return (
    <>
      <KpiRow>
        <KpiTile
          label={messages.health.errorsTotal}
          value={data === undefined ? null : formatCount(data.total)}
          loading={read.isPending}
          {...(failed === undefined ? {} : { onRetry: failed })}
        />
        <KpiTile
          label={messages.health.errorsPeople}
          value={data === undefined ? null : formatCount(data.visitors)}
          help={messages.health.errorsPeopleHelp}
          loading={read.isPending}
          {...(failed === undefined ? {} : { onRetry: failed })}
        />
        <KpiTile
          label={messages.health.errorsKinds}
          value={data === undefined ? null : formatCount(data.groupsTotal)}
          loading={read.isPending}
          {...(failed === undefined ? {} : { onRetry: failed })}
        />
      </KpiRow>
      <Card
        title={messages.health.errorsTitle}
        help={<InfoDot label={messages.health.errorsTitle} text={messages.health.errorsNote} />}
      >
        {read.isFetching && !read.isPending && <Working />}
        {read.isPending ? (
          <div className={styles.loading}>
            <Skeleton height={44} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        ) : read.isError ? (
          <ErrorState error={read.error} onRetry={() => void read.refetch()} />
        ) : data === undefined || data.groups.length === 0 ? (
          capture ? (
            <EmptyState message={messages.health.errorsNone} />
          ) : (
            <div className={styles.empty}>
              <EmptyState message={messages.health.errorsOff} />
              <ScriptLine file="e.js" />
              <Link className={styles.link} to={`/${site.id}/settings`}>
                {messages.health.errorsTurnOn}
              </Link>
            </div>
          )
        ) : (
          <>
            {!capture && (
              <p className={styles.notice} role="note">
                {messages.health.errorsNowOff}
              </p>
            )}
            <ul className={styles.groups}>
              {data.groups.map((group) => (
                <li key={group.message}>
                  <ErrorRow group={group} now={now} timezone={timezone} />
                </li>
              ))}
            </ul>
            {data.groupsTotal > data.groups.length && (
              <p className={styles.note}>
                {format(messages.health.errorsMore, {
                  shown: formatExact(data.groups.length),
                  total: formatExact(data.groupsTotal),
                })}
              </p>
            )}
            <RawNote meta={read.data?.meta} />
          </>
        )}
      </Card>
    </>
  );
}

function ErrorRow({
  group,
  now,
  timezone,
}: {
  group: ErrorGroup;
  now: number;
  timezone: string;
}): JSX.Element {
  return (
    <details className={styles.group}>
      <summary className={styles.summary}>
        <code className={styles.message}>{group.message === '' ? messages.health.noMessage : group.message}</code>
        <span className={styles.groupFacts}>
          <span>{format(messages.health.times, { count: formatExact(group.count) })}</span>
          <span>{format(messages.health.people, { count: formatExact(group.visitors) })}</span>
          <span>
            {format(messages.health.lastSeen, { when: formatLastSeen(group.lastSeen, now, timezone) })}
          </span>
        </span>
      </summary>
      <div className={styles.detail}>
        <dl className={styles.facts}>
          <dt>{messages.health.firstSeen}</dt>
          <dd>{formatLastSeen(group.firstSeen, now, timezone)}</dd>
          <dt>{messages.health.pages}</dt>
          <dd>
            <ul className={styles.inline}>
              {group.pages.map((page) => (
                <li key={page.page}>
                  <span className={styles.mono}>{page.page === '' ? messages.health.noPage : page.page}</span>{' '}
                  <span className={styles.dim}>{formatExact(page.count)}</span>
                </li>
              ))}
            </ul>
          </dd>
          <dt>{messages.health.browsers}</dt>
          <dd>
            <ul className={styles.inline}>
              {group.browsers.map((browser) => (
                <li key={browser.browser}>
                  {browser.browser === '' ? messages.health.unknownBrowser : browser.browser}{' '}
                  <span className={styles.dim}>{formatExact(browser.count)}</span>
                </li>
              ))}
            </ul>
          </dd>
          {group.sample.frame !== undefined && (
            <>
              <dt>{messages.health.frame}</dt>
              <dd className={styles.mono}>{group.sample.frame}</dd>
            </>
          )}
        </dl>
        {group.sample.stack !== undefined && (
          <pre className={styles.code} tabIndex={0} aria-label={messages.health.stack}>
            <code>{group.sample.stack}</code>
          </pre>
        )}
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ coverage

const COVERAGE_REASONS: Readonly<Record<Exclude<CoverageResult['state'], 'ok'>, string>> = {
  no_server_events: messages.health.coverageNoServer,
  no_browser_identity: messages.health.coverageNoIdentity,
  too_few: messages.health.coverageTooFew,
};

function Coverage({ days }: { days: number }): JSX.Element {
  const { client, site, now } = useApp();
  const timezone = site.settings.timezone;
  const window = useMemo(() => healthWindow(now, days, timezone), [now, days, timezone]);
  const read = useCoverage(client, site.id, window);
  const data = read.data?.data;

  return (
    <Card
      title={messages.health.coverageTitle}
      help={<InfoDot label={messages.health.coverageTitle} text={messages.health.coverageNote} />}
    >
      {read.isFetching && !read.isPending && <Working />}
      {read.isPending ? (
        <div className={styles.loading}>
          <Skeleton height={60} />
          <Skeleton height={28} />
        </div>
      ) : read.isError || data === undefined ? (
        <ErrorState error={read.error} onRetry={() => void read.refetch()} />
      ) : (
        <div className={styles.coverage}>
          {data.state === 'ok' && data.share !== null ? (
            <>
              <p className={styles.bigNumber}>{formatRate(data.share)}</p>
              <p className={styles.coverageLine}>
                {format(messages.health.coverageShare, {
                  count: formatExact(data.serverOnly),
                  total: formatExact(data.people),
                })}
              </p>
              <div className={styles.bar} aria-hidden="true">
                <span className={[styles.segment, styles.seen].join(' ')} style={{ flexGrow: data.seenInBrowser }} />
                <span className={[styles.segment, styles.unseen].join(' ')} style={{ flexGrow: data.serverOnly }} />
              </div>
              <p className={styles.note}>{messages.health.coverageCaveat}</p>
            </>
          ) : (
            <>
              <EmptyState message={COVERAGE_REASONS[data.state === 'ok' ? 'too_few' : data.state]} />
              {data.state === 'too_few' && (
                <p className={styles.coverageLine}>
                  {format(messages.health.coverageCounts, {
                    count: formatExact(data.serverOnly),
                    total: formatExact(data.people),
                    min: formatExact(data.minPeople),
                  })}
                </p>
              )}
            </>
          )}
          <RawNote meta={read.data?.meta} />
        </div>
      )}
    </Card>
  );
}
