import { useMemo, useState, type JSX, type ReactNode } from 'react';
import type { Dimension } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { useTabParam } from '../app/useTabParam.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { toggleFilter } from '../lib/filters.js';
import { countryName, formatCount, formatExact, formatRate, languageName } from '../lib/format.js';
import { api } from '../lib/api.js';
import { exportName } from '../lib/download.js';
import { toStatsParams } from '../lib/query.js';
import { useBreakdown } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { Breakdown, Code, conversionColumn, type BreakdownRowView } from '../ui/Breakdown.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import styles from './DimensionCard.module.css';

// One card, one dimension, on the reports that are lists of things.
//
// It is the Overview's card with three differences, and each of them is what
// makes a report a report rather than a bigger summary: the rows are ranked
// against the top row of the whole report and not against the five that fit in
// a card, the column head is drawn because a table with three columns needs
// one, and there is a second column, because on a report screen "700 visitors"
// alone is half an answer.
//
// Clicking a row still filters the page it is on rather than going somewhere,
// which is the fourth of the five rules the product is designed around.

// How many rows a report shows, and how many it shows after somebody asks for
// more. Ten because a report is a ranking and the eleventh row is rarely the
// point; a hundred because that is where the store's own limit sits and asking
// for more would be asking for something nobody can answer.
const ROWS = 10;
const MORE_ROWS = 100;

export interface DimensionTab {
  id: string;
  dim: Dimension;
  label: string;
  // The column head over the keys, when it differs from the tab's own name.
  dimensionLabel?: string;
}

export interface DimensionCardProps {
  title: string;
  tabs: DimensionTab[];
  // A sentence under the rows that is true of this card in particular: what a
  // channel is, or what a referrer list leaves out.
  note?: string;
  // The query parameter the open tab is remembered in. One per card on a page,
  // so two cards on one report do not fight over the same name.
  param: string;
  help?: ReactNode;
  // What the quiet second column says. Pageviews beside visitors almost
  // everywhere; a bounce rate where the dimension is a whole visit.
  secondary?: 'pageviews' | 'bounceRate';
  // Tabs drawn after the card's own that open something other than a
  // breakdown. Choosing one writes it to the same parameter, and the page
  // draws what it opens in place of this card.
  moreTabs?: { id: string; label: string }[];
}

export function DimensionCard({
  title,
  tabs,
  param,
  help,
  note,
  secondary = 'pageviews',
  moreTabs = [],
}: DimensionCardProps): JSX.Element {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  // With a goal chosen the quiet column is the conversion rate, whatever it
  // was: that is what somebody who chose a goal came to read. The rows are
  // still ranked and barred by visitors, so choosing one never reorders a list.
  const converting = query.goal !== null;
  const ids = useMemo(() => tabs.map((candidate) => candidate.id), [tabs]);
  const { tab, set: setTab } = useTabParam(param, ids);
  const [limit, setLimit] = useState(ROWS);

  const current = tabs.find((candidate) => candidate.id === tab) ?? (tabs[0] as DimensionTab);
  const dim = current.dim;

  // One more than is drawn, so "Show more" appears exactly when there is more
  // to show rather than on every full page of rows.
  const result = useBreakdown({ client, siteId: site.id, query, now }, dim, limit + 1, true);
  const data = useMemo(() => result.data?.data.rows ?? [], [result.data]);
  const shown = data.slice(0, limit);
  const hasMore = data.length > limit && limit < MORE_ROWS;

  const rows: BreakdownRowView[] = useMemo(() => {
    // Against the biggest row the read returned rather than the biggest row
    // drawn, so pressing "Show more" cannot rescale the bars that were already
    // on screen whatever order the rows arrive in.
    const top = data.reduce((best, row) => Math.max(best, row.metrics.visitors), 0);
    return shown.map((row) => ({
      key: row.key,
      label: labelFor(dim, row.key),
      value: formatCount(row.metrics.visitors),
      title: formatExact(row.metrics.visitors),
      ...(converting
        ? conversionColumn(row.conversion)
        : {
            secondary:
              secondary === 'pageviews'
                ? formatCount(row.metrics.pageviews)
                : (formatRate(row.metrics.bounceRate) ?? messages.states.notAvailable),
          }),
      share: top === 0 ? 0 : row.metrics.visitors / top,
      unknown: row.key === '',
      // The code beside the name, because a filter is written in codes and
      // somebody reading "United Kingdom" should be able to see what to type.
      ...((dim === 'country' || dim === 'lang') && row.key !== ''
        ? { icon: <Code>{row.key}</Code> }
        : {}),
      // The one channel that is this product's own reading of the web. Every
      // analytics tool files a visit from ChatGPT under referral or search;
      // filing it as neither is a claim, and a claim gets a mark on the row
      // that makes it.
      ...(dim === 'channel' && row.key === 'ai'
        ? { icon: <Code>{messages.reports.aiPill}</Code> }
        : {}),
      // Every row narrows the report it is on, the entry, exit and channel
      // rows included: the store answers those by the stays that match.
      onClick: () =>
        set({
          ...query,
          filters: toggleFilter(query.filters, { dim, op: 'is', value: row.key }),
        }),
    }));
  }, [data, shown, dim, secondary, set, query, converting]);

  // A goal read is raw for its whole range, so this card sees back as far as
  // the site keeps its events. The number comes with the answer.
  const retentionDays = result.data?.meta?.retentionDays;

  const body = (): JSX.Element => {
    if (result.isPending) {
      return (
        <div className={styles.loading}>
          {Array.from({ length: ROWS }, (_row, index) => (
            <Skeleton key={index} height={26} width={`${100 - index * 7}%`} />
          ))}
        </div>
      );
    }
    if (result.isError) {
      return <ErrorState error={result.error} onRetry={() => result.refetch()} />;
    }
    if (rows.length === 0) {
      return query.filters.length > 0 ? (
        <EmptyState
          message={messages.states.emptyFiltered}
          action={{ label: messages.filters.clear, onClick: () => set({ ...query, filters: [] }) }}
        />
      ) : (
        <EmptyState message={messages.states.empty} />
      );
    }
    return (
      <>
        <Breakdown
          rows={rows}
          dimensionLabel={current.dimensionLabel ?? current.label}
          valueLabel={messages.metrics.visitors}
          secondaryLabel={
            converting
              ? messages.metrics.conversionRate
              : secondary === 'pageviews'
                ? messages.metrics.pageviews
                : messages.metrics.bounceRate
          }
          showHead
          caption={`${title}: ${current.label}`}
        />
        {note !== undefined && <p className={styles.note}>{note}</p>}
        {converting && typeof retentionDays === 'number' && (
          <p className={styles.note}>
            {format(messages.metricHelp.rawOnly, { days: retentionDays })}
          </p>
        )}
        {hasMore && (
          <div className={styles.foot}>
            <Button variant="quiet" onClick={() => setLimit(MORE_ROWS)}>
              {format(messages.reports.showMore, { count: MORE_ROWS })}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <Card
      title={title}
      {...(help === undefined ? {} : { help })}
      // A plain link for the CSV rather than a fetch: the server answers with
      // a content-disposition, the session cookie goes with it because it is
      // the same origin, and the URL carries the range and the filters on
      // screen, so what arrives is what was being read. The JSON is the rows
      // the card holds.
      download={{
        csvHref: api.exportUrl(
          client,
          site.id,
          toStatsParams(query, { dim, limit: MORE_ROWS, goal: true }),
          { report: 'breakdown' },
        ),
        json: () => result.data?.data,
        name: exportName(site.id, 'breakdown', dim, query.range),
        title: `${title}: ${current.label}`,
      }}
      {...(tabs.length + moreTabs.length > 1
        ? {
            tabs: [
              ...tabs.map((candidate) => ({ id: candidate.id, label: candidate.label })),
              ...moreTabs,
            ],
            tab,
            onTab: (id: string) => {
              // Back to ten rows with the tab: "show more" was a statement
              // about the list somebody was reading, not a preference.
              setLimit(ROWS);
              setTab(id);
            },
          }
        : { metric: messages.metrics.visitors })}
    >
      {body()}
    </Card>
  );
}

// The human name for a key, per dimension. A channel is "Organic search" and
// not "organic", a country is its name with its code beside it, a device is a
// word rather than a token: the store files what it measured and this is the
// only place that turns it into English.
export function labelFor(dim: Dimension, key: string): string {
  if (key === '') {
    return messages.states.unknown;
  }
  if (dim === 'channel') {
    return (messages.channels as Record<string, string>)[key] ?? key;
  }
  if (dim === 'device') {
    return (messages.devices as Record<string, string>)[key] ?? key;
  }
  if (dim === 'country') {
    return countryName(key) ?? key;
  }
  if (dim === 'lang') {
    return languageName(key) ?? key;
  }
  return key;
}
