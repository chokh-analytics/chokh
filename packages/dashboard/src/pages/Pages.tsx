import { useMemo, type JSX } from 'react';

import { useApp } from '../app/context.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { formatCount, formatDuration, formatRate } from '../lib/format.js';
import { useBreakdown, useEngagement } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { DimensionCard } from '../reports/DimensionCard.js';
import { ReportPage } from '../reports/ReportPage.js';
import { Card } from '../ui/Card.js';
import { Code } from '../ui/Breakdown.js';
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

const PAGE_TABS = [
  { id: 'all', dim: 'page' as const, label: messages.reports.tabAll },
  { id: 'entry', dim: 'entry' as const, label: messages.reports.tabEntry },
  { id: 'exit', dim: 'exit' as const, label: messages.reports.tabExit },
];

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
      )}
      <p className={styles.note}>
        {format(messages.metricHelp.rawOnly, { days: site.settings.retentionDays })}
      </p>
    </Card>
  );
}

// Four quarters, filled to where people got. The number is beside it because a
// picture of a quarter is not a measurement.
function Depth({ value }: { value: number }): JSX.Element {
  const quarters = [0.25, 0.5, 0.75, 1];
  return (
    <span className={styles.depth}>
      <span className={styles.depthBars} aria-hidden="true">
        {quarters.map((edge) => (
          <span
            key={edge}
            className={value >= edge - 0.125 ? styles.quarterOn : styles.quarterOff}
          />
        ))}
      </span>
      <span className={styles.mono}>{formatRate(value)}</span>
    </span>
  );
}

// The card about the thing Chokh cannot see.
//
// A tracker in a page has no idea what status code the server sent: a 404 page
// is a pageview of a page that happens to say "not found". Rather than guessing
// from the path, or quietly not having the report at all, this says what the
// convention is and counts it when somebody follows it.
function NotFound(): JSX.Element {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  const result = useBreakdown({ client, siteId: site.id, query, now }, 'event', 50);
  const rows = useMemo(
    () => (result.data?.data.rows ?? []).filter((row) => row.key === '404'),
    [result.data],
  );
  const total = rows.reduce((sum, row) => sum + row.metrics.pageviews, 0);

  return (
    <Card
      title={messages.reports.notFound}
      help={<InfoDot label={messages.reports.notFound} text={messages.reports.notFoundHelp} />}
    >
      {result.isError ? (
        <ErrorState error={result.error} onRetry={() => result.refetch()} />
      ) : result.isPending ? (
        <Skeleton height={64} />
      ) : total === 0 ? (
        <div className={styles.convention}>
          <p>{messages.reports.notFoundEmpty}</p>
          <pre className={styles.snippet}>
            <code>{messages.reports.notFoundSnippet}</code>
          </pre>
        </div>
      ) : (
        <div className={styles.convention}>
          <p className={styles.bigNumber}>{formatCount(total)}</p>
          <p>
            <Code>404</Code> {messages.reports.notFoundHelp}
          </p>
        </div>
      )}
    </Card>
  );
}

export function Pages(): JSX.Element {
  return (
    <ReportPage title={messages.reports.pagesTitle}>
      <DimensionCard
        title={messages.reports.topPages}
        tabs={PAGE_TABS}
        param="pages"
        secondary="pageviews"
      />
      <Engagement />
      <NotFound />
    </ReportPage>
  );
}
