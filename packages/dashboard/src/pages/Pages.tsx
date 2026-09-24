import { Suspense, lazy, useMemo, type JSX } from 'react';

import { useApp } from '../app/context.js';
import { useTabParam } from '../app/useTabParam.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { formatCount, formatDuration, formatPercentPoints } from '../lib/format.js';
import { useBreakdown, useEngagement } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { DimensionCard } from '../reports/DimensionCard.js';
import { ReportPage } from '../reports/ReportPage.js';
import { Card } from '../ui/Card.js';
import { InfoDot } from '../ui/InfoDot.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import styles from './Pages.module.css';

// What people read, how far down they got, and what they asked for and did not
// find.
//
// The first card is the ranking. The second is the one an analytics product
// usually leaves out because it is awkward to measure: a page is only finished
// when somebody leaves it, so time on page and scroll depth come from the leave
// event and a page nobody has closed yet has no number rather than a zero. The
// third is a card about a thing this product cannot see at all, which is worth
// a card of its own rather than silence.

// The Routes tab is the page list with the site's route rules applied: every
// course under /courses/:slug as one row. Drawn always, and with no rule on
// the site it says so and where to add one, rather than being missing.
const PAGE_TABS = [
  { id: 'all', dim: 'page' as const, label: messages.reports.tabAll },
  { id: 'routes', dim: 'route' as const, label: messages.reports.tabRoutes },
  { id: 'entry', dim: 'entry' as const, label: messages.reports.tabEntry },
  { id: 'exit', dim: 'exit' as const, label: messages.reports.tabExit },
];

// The fourth tab, beside Entry and Exit because a journey runs from one to the
// other. It is not a breakdown, so it is not a DimensionCard tab: the card
// draws it in its head, and this page draws the flow in the card's place.
const JOURNEYS_TAB = { id: 'journeys', label: messages.reports.tabJourneys };
const TAB_IDS = ['all', 'routes', 'entry', 'exit', 'journeys'] as const;
const ALL_TABS = [...PAGE_TABS.map(({ id, label }) => ({ id, label })), JOURNEYS_TAB];

// Its own chunk, fetched the first time somebody opens the tab and never by a
// visit to Pages that does not.
const Journeys = lazy(async () => ({ default: (await import('./Journeys.js')).Journeys }));

function TopPages(): JSX.Element {
  const { site } = useApp();
  const { tab, set } = useTabParam('pages', TAB_IDS);
  const noRules = tab === 'routes' && site.settings.routeGroups.length === 0;
  const choose = (id: string): void =>
    set(TAB_IDS.find((candidate) => candidate === id) ?? 'all');
  if (tab === 'journeys') {
    return (
      // The rest of the report stays drawn while the chunk arrives: this
      // boundary holds only the card that is waiting.
      <Suspense
        fallback={
          <Card title={messages.reports.topPages} tabs={ALL_TABS} tab="journeys" onTab={choose}>
            <Skeleton height={320} />
          </Card>
        }
      >
        <Journeys title={messages.reports.topPages} tabs={ALL_TABS} onTab={choose} />
      </Suspense>
    );
  }
  return (
    <DimensionCard
      title={messages.reports.topPages}
      tabs={PAGE_TABS}
      param="pages"
      secondary="pageviews"
      moreTabs={[JOURNEYS_TAB]}
      {...(noRules ? { note: messages.reports.routesEmpty } : {})}
    />
  );
}

// Ten rows, the same as the ranking above it, so the two cards read as two
// views of one list rather than two lists.
const ENGAGEMENT_ROWS = 10;

function Engagement(): JSX.Element {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  const result = useEngagement({ client, siteId: site.id, query, now }, 'page', ENGAGEMENT_ROWS);
  const rows = result.data?.data.rows ?? [];

  return (
    <Card
      title={messages.reports.engagement}
      help={<InfoDot label={messages.reports.engagement} text={messages.reports.engagementHelp} />}
    >
      {result.isPending ? (
        <div className={styles.loading}>
          {Array.from({ length: ENGAGEMENT_ROWS }, (_row, index) => (
            <Skeleton key={index} height={26} />
          ))}
        </div>
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => result.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={messages.states.empty} />
      ) : (
        // Four columns and a path are wider than a phone, so the table scrolls
        // inside its card, the way the goal and visitor tables do, rather than
        // moving the page and the navigation sideways.
        <div
          className={styles.scroll}
          tabIndex={0}
          role="group"
          aria-label={messages.reports.engagement}
        >
          <table className={styles.table}>
            <caption className="sr-only">{messages.reports.engagement}</caption>
            <thead className={styles.head}>
              <tr>
                <th scope="col">{messages.dimensions.page}</th>
                <th scope="col" className={styles.right}>
                  {messages.metrics.scrollDepth}
                </th>
                <th scope="col" className={styles.right}>
                  {messages.metrics.timeOnPage}
                </th>
                <th scope="col" className={styles.right}>
                  {messages.reports.engagementLeaves}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className={styles.cell}>
                    <span className={styles.path}>{row.key}</span>
                  </td>
                  <td className={[styles.cell, styles.right].join(' ')}>
                    {/*
                      A quarter is a quarter: a bar rather than a percentage,
                      because "62%" of a page whose length nobody controls is a
                      number with a false precision on it.
                    */}
                    {row.avgScrollDepth === null ? (
                      <span className={styles.absent}>{messages.states.notAvailable}</span>
                    ) : (
                      <Depth value={row.avgScrollDepth} />
                    )}
                  </td>
                  <td className={[styles.cell, styles.right, styles.mono].join(' ')}>
                    {formatDuration(row.avgTimeOnPageMs) ?? (
                      <span className={styles.absent}>{messages.states.notAvailable}</span>
                    )}
                  </td>
                  <td className={[styles.cell, styles.right, styles.mono].join(' ')}>
                    {formatCount(row.leaves)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>
        {format(messages.metricHelp.rawOnly, { days: site.settings.retentionDays })}
      </p>
    </Card>
  );
}

// Four quarters, filled to where people got. The number is beside it because a
// picture of a quarter is not a measurement.
//
// The value is a percentage and not a fraction, all the way from the tracker:
// it reports a quartile as 0, 25, 50, 75 or 100 and the store averages those
// numbers, so the average of a 50 and a 100 is 75 and not 0.75. Rendering it
// through the rate formatter multiplied it by a hundred again and put "5,513%"
// on every row of a real install. This file has the same trap written down
// once already, on a bounce rate that rounded to 1: assert a unit against the
// source, not against what the number looks like.
const QUARTERS = [25, 50, 75, 100];

// Half a quarter, so a bar lights when the average has reached the middle of
// the band it stands for.
const QUARTER_TOLERANCE = 12.5;

function Depth({ value }: { value: number }): JSX.Element {
  return (
    <span className={styles.depth}>
      <span className={styles.depthBars} aria-hidden="true">
        {QUARTERS.map((edge) => (
          <span
            key={edge}
            className={value >= edge - QUARTER_TOLERANCE ? styles.quarterOn : styles.quarterOff}
          />
        ))}
      </span>
      <span className={styles.mono}>{formatPercentPoints(value)}</span>
    </span>
  );
}

// The card about the one thing only the page itself knows.
//
// A tracker in a browser cannot see the status code the page came back with: a
// 404 page is a pageview of a page that happens to say "not found". So the page
// says what it answered, in one line, and this counts it. An install that
// predates that line, or cannot add it, sends an event named 404 instead and is
// counted the same way, which is how this card read before the status existed
// and how Umami answers the same question today.
//
// The status wins when there is one, rather than the two being added: a page
// that does both would otherwise count every miss twice.
const NOT_FOUND_ROWS = 50;
const NOT_FOUND_KEY = '404';

function hits(rows: { key: string; metrics: { pageviews: number } }[]): number {
  return rows
    .filter((row) => row.key === NOT_FOUND_KEY)
    .reduce((sum, row) => sum + row.metrics.pageviews, 0);
}

function NotFound(): JSX.Element {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  const context = { client, siteId: site.id, query, now };
  const declared = useBreakdown(context, 'status', NOT_FOUND_ROWS);
  const events = useBreakdown(context, 'event', NOT_FOUND_ROWS);

  const fromStatus = useMemo(() => hits(declared.data?.data.rows ?? []), [declared.data]);
  const fromEvent = useMemo(() => hits(events.data?.data.rows ?? []), [events.data]);
  const total = fromStatus > 0 ? fromStatus : fromEvent;

  const pending = declared.isPending || events.isPending;
  // One of the two failing still leaves an answer worth drawing, so this is
  // red only when neither read came back.
  const failed = declared.isError && events.isError;

  return (
    <Card
      title={messages.reports.notFound}
      help={<InfoDot label={messages.reports.notFound} text={messages.reports.notFoundHelp} />}
    >
      {failed ? (
        <ErrorState
          error={declared.error}
          onRetry={() => {
            void declared.refetch();
            void events.refetch();
          }}
        />
      ) : pending ? (
        <Skeleton height={64} />
      ) : total === 0 ? (
        <div className={styles.convention}>
          <p>{messages.reports.notFoundEmpty}</p>
          <pre className={styles.snippet}>
            <code>{messages.reports.notFoundSnippet}</code>
          </pre>
          <p>{messages.reports.notFoundSnippetNote}</p>
          <p>{messages.reports.notFoundFallbackNote}</p>
          <pre className={styles.snippet}>
            <code>{messages.reports.notFoundFallbackSnippet}</code>
          </pre>
        </div>
      ) : (
        <div className={styles.convention}>
          <p className={styles.bigNumber}>{formatCount(total)}</p>
          <p>
            {fromStatus > 0
              ? messages.reports.notFoundFromStatus
              : messages.reports.notFoundFromEvent}
          </p>
        </div>
      )}
    </Card>
  );
}

export function Pages(): JSX.Element {
  return (
    <ReportPage title={messages.reports.pagesTitle}>
      <TopPages />
      <Engagement />
      <NotFound />
    </ReportPage>
  );
}
