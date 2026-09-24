import { useMemo, type JSX } from 'react';
import type { Dimension, Metrics } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { RangeBar } from '../app/RangeBar.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { toggleFilter } from '../lib/filters.js';
import {
  delta,
  deltaPoints,
  countryName,
  formatCount,
  formatDuration,
  formatExact,
  formatRate,
  formatRatio,
  viewsPerVisit,
  GOOD_WHEN,
} from '../lib/format.js';
import {
  useAggregate,
  useAnnotations,
  useBreakdown,
  useHasAnyData,
  useRealtime,
  useSegmentTimeseries,
  useTimeseries,
} from '../lib/queries.js';
import { defaultInterval, isLive } from '../lib/range.js';
import { METRICS, type MetricName } from '../lib/query.js';
import { format, messages } from '../messages/en.js';
import { Breakdown, Code, conversionColumn, type BreakdownRowView } from '../ui/Breakdown.js';
import { Card } from '../ui/Card.js';
import { KpiRow, KpiTile, LiveValue } from '../ui/KpiTile.js';
import { EmptyState, ErrorState, Skeleton, Working } from '../ui/State.js';
import { Waiting } from './Waiting.js';
import { CHART_HEIGHT, TimeChart, type ChartMark, type ChartPoint } from '../ui/TimeChart.js';
import styles from './Overview.module.css';

// Six numbers, one chart, four cards. Nothing else on the first screen.
//
// That is the first of the five rules this dashboard is designed around, and
// every other decision on this page follows from it: the numbers are always
// visible rather than hidden behind a tab strip, every one carries a comparison
// because a number alone is not actionable, there is one accent and green and
// red are reserved for good and bad, and any row can be clicked to filter the
// whole page.

const METRIC_LABELS: Record<MetricName, string> = {
  visitors: messages.metrics.visitors,
  pageviews: messages.metrics.pageviews,
  bounceRate: messages.metrics.bounceRate,
  avgDuration: messages.metrics.avgDuration,
};

// What a metric is, kept nullable all the way to the formatter.
//
// A bounce rate over no visits and an average duration over no visits are both
// null, and turning them into a zero here is what put "not available" in a tile
// beside a red "down 100%": the delta was computed against a zero nobody
// measured. The chart needs a number, so it coalesces at the point of drawing
// and nowhere earlier.
function valueOf(metrics: Metrics, name: MetricName): number | null {
  switch (name) {
    case 'visitors':
      return metrics.visitors;
    case 'pageviews':
      return metrics.pageviews;
    case 'bounceRate':
      return metrics.bounceRate;
    case 'avgDuration':
      return metrics.avgDurationMs;
  }
}

// How each metric is written, so the chart axis, the hover card, the peak line
// and the hidden table say the same thing the tile above them says. Without
// this every series is a count, and the bounce rate chart's axis reads 0, 0, 1
// under a tile that says 30%.
const METRIC_FORMAT: Record<MetricName, (value: number) => string> = {
  visitors: formatCount,
  pageviews: formatCount,
  bounceRate: (value) => formatRate(value) ?? '',
  avgDuration: (value) => formatDuration(value) ?? '',
};

const METRIC_EXACT: Record<MetricName, (value: number) => string> = {
  visitors: formatExact,
  pageviews: formatExact,
  bounceRate: (value) => formatRate(value) ?? '',
  avgDuration: (value) => formatDuration(value) ?? '',
};

// One card's worth of rows, with the shares measured against the biggest row in
// that card rather than against the site total: the point of the bar is to rank
// what is on screen.
function useBreakdownCard(
  dim: Dimension,
  label: (key: string) => string,
  icon?: (key: string) => JSX.Element | undefined,
) {
  const { client, siteId, query, now, filters } = useOverviewContext();
  const result = useBreakdown({ client, siteId, query, now }, dim, 5, true);
  const { set } = useViewQuery();

  const rows: BreakdownRowView[] = useMemo(() => {
    const data = result.data?.data.rows ?? [];
    const top = data.reduce((best, row) => Math.max(best, row.metrics.visitors), 0);
    return data.map((row) => ({
      key: row.key,
      label: label(row.key),
      value: formatCount(row.metrics.visitors),
      title: formatExact(row.metrics.visitors),
      share: top === 0 ? 0 : row.metrics.visitors / top,
      icon: icon?.(row.key),
      // One column on the Overview, and a second only once a goal is chosen.
      ...(query.goal === null ? {} : conversionColumn(row.conversion)),
      onClick: () =>
        set({ ...query, filters: toggleFilter(filters, { dim, op: 'is', value: row.key }) }),
    }));
  }, [result.data, label, icon, dim, set, query, filters]);

  return { result, rows };
}

// The page's own reading of the shell context, so the card helper above does
// not take six arguments.
function useOverviewContext() {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  return { client, siteId: site.id, query, now, filters: query.filters };
}

function BreakdownBody({
  result,
  rows,
  dimensionLabel,
  caption,
  hasFilters,
  onClearFilters,
  converting,
}: {
  result: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
    data?: { meta?: Record<string, unknown> | undefined } | undefined;
  };
  rows: BreakdownRowView[];
  dimensionLabel: string;
  caption: string;
  hasFilters: boolean;
  onClearFilters: () => void;
  converting: boolean;
}): JSX.Element {
  if (result.isPending) {
    // Five rows at the height five rows will be, so nothing moves when they
    // arrive.
    return (
      <div style={{ display: 'grid', gap: 6, padding: '4px 8px' }}>
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} height={26} width={`${100 - index * 12}%`} />
        ))}
      </div>
    );
  }
  if (result.isError) {
    return <ErrorState error={result.error} onRetry={() => result.refetch()} />;
  }
  if (rows.length === 0) {
    return hasFilters ? (
      <EmptyState
        message={messages.states.emptyFiltered}
        action={{ label: messages.filters.clear, onClick: onClearFilters }}
      />
    ) : (
      <EmptyState message={messages.states.empty} />
    );
  }
  const retentionDays = result.data?.meta?.retentionDays;
  return (
    <>
      {/*
        With a goal the card has two columns, so it names them: the head the
        card's own corner cannot hold. Without one it stays the one column the
        corner already names.
      */}
      <Breakdown
        rows={rows}
        dimensionLabel={dimensionLabel}
        valueLabel={messages.metrics.visitors}
        {...(converting
          ? { secondaryLabel: messages.metrics.conversionRate, showHead: true }
          : {})}
        caption={caption}
      />
      {converting && typeof retentionDays === 'number' && (
        <p className={styles.note}>{format(messages.metricHelp.rawOnly, { days: retentionDays })}</p>
      )}
    </>
  );
}

export function Overview(): JSX.Element {
  const { client, site, now, segments } = useApp();
  const { query, set } = useViewQuery();
  const context = { client, siteId: site.id, query, now };
  const timezone = site.settings.timezone;

  const totals = useAggregate(context);
  const series = useTimeseries(context);
  // The segment compared against, when the link names one the site has. Its
  // series takes the second line; the previous period steps aside (D3).
  const compared = query.vs === null ? undefined : segments?.find((each) => each.id === query.vs);
  const segmentSeries = useSegmentTimeseries(context, compared);
  const live = useRealtime(client, site.id, 10_000);
  // The marks for the range: a deploy, a campaign, an outage, a note. A read
  // that failed draws no marks and says nothing; the chart is the report.
  const notes = useAnnotations(context);
  const marks: ChartMark[] = useMemo(
    () =>
      (notes.data?.data.annotations ?? []).map((annotation) => ({
        at: annotation.at,
        kind: messages.annotations.kinds[annotation.kind],
        label: annotation.text,
      })),
    [notes.data],
  );

  const metrics = totals.data?.data.metrics;
  const previous = totals.data?.data.previous ?? null;
  const interval = query.interval ?? defaultInterval(query.range);

  const points: ChartPoint[] = useMemo(
    () =>
      (series.data?.data.points ?? []).map((point) => ({
        start: point.start,
        value: valueOf(point.metrics, query.metric) ?? 0,
      })),
    [series.data, query.metric],
  );
  const previousPoints: ChartPoint[] | null = useMemo(() => {
    if (compared !== undefined) {
      return (segmentSeries.data?.data.points ?? []).map((point) => ({
        start: point.start,
        value: valueOf(point.metrics, query.metric) ?? 0,
      }));
    }
    return series.data?.data.previous === null || series.data?.data.previous === undefined
      ? null
      : series.data.data.previous.map((point) => ({
          start: point.start,
          value: valueOf(point.metrics, query.metric) ?? 0,
        }));
  }, [series.data, segmentSeries.data, compared, query.metric]);

  const pages = useBreakdownCard('page', (key) => key);
  const channels = useBreakdownCard(
    'channel',
    (key) => (messages.channels as Record<string, string>)[key] ?? key,
  );
  // The code beside the name, because "GB" and "United Kingdom" are the same
  // row and somebody reading a list of codes should not have to translate.
  const countries = useBreakdownCard(
    'country',
    (key) => countryName(key) ?? key,
    (key) => <Code>{key}</Code>,
  );
  const devices = useBreakdownCard(
    'device',
    (key) => (messages.devices as Record<string, string>)[key] ?? key,
  );

  const loading = totals.isPending;
  const converting = query.goal !== null;
  const clear = (): void => set({ ...query, filters: [] });
  const hasFilters = query.filters.length > 0;

  // A range with nothing in it is two different screens, and which one depends
  // on a question this page cannot answer from the numbers in front of it: has
  // this site ever been visited? Asked once, and only when the answer matters.
  const rangeIsEmpty =
    metrics !== undefined && metrics.pageviews === 0 && metrics.visitors === 0 && !hasFilters;
  const ever = useHasAnyData(client, site, now, rangeIsEmpty);
  const neverVisited =
    rangeIsEmpty && ever.data !== undefined && ever.data.data.metrics.pageviews === 0;

  const ratio = metrics === undefined ? null : viewsPerVisit(metrics.pageviews, metrics.visits);
  const previousRatio =
    previous === null ? null : viewsPerVisit(previous.pageviews, previous.visits);

  if (neverVisited) {
    return (
      <div className={styles.page}>
        <h1 className="sr-only">{messages.overview.title}</h1>
        <Waiting
          client={client}
          siteId={site.id}
          domain={site.domains[0] ?? site.name}
          origin={typeof location === 'undefined' ? '' : location.origin}
          onArrived={() => void totals.refetch()}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/*
        Named, but not drawn. The navigation above already says which report
        this is and a title repeating it would be a line of chrome above the
        numbers. A page with no h1 is still a page a screen reader cannot place
        and a heading order audit fails, so it is here and it is hidden.
      */}
      <h1 className="sr-only">{messages.overview.title}</h1>
      <RangeBar />

      {totals.isError ? (
        <ErrorState error={totals.error} onRetry={() => totals.refetch()} />
      ) : (
        <div className={styles.headline}>
          {(totals.isFetching || series.isFetching) && !loading && <Working />}
          <KpiRow>
            {/*
              A realtime read that failed is not nobody being here. Drawn as
              "0 online" with a grey dot it is indistinguishable from a quiet
              minute, which is the most confident kind of wrong a live tile can
              be.
            */}
            <KpiTile
              label={messages.metrics.onlineNow}
              value={live.isError ? null : String(live.data?.data.online ?? 0)}
              help={messages.metricHelp.onlineNow}
              loading={live.isPending}
              {...(live.isError ? { onRetry: () => void live.refetch() } : {})}
              live={
                live.isError ? null : (
                  <LiveValue
                    count={live.data?.data.online ?? 0}
                    note={format(messages.metrics.signedInSplit, {
                      signedIn: live.data?.data.signedIn ?? 0,
                      anonymous: live.data?.data.anonymous ?? 0,
                    })}
                  />
                )
              }
            />
            {METRICS.map((name) => {
              const raw = metrics === undefined ? null : valueOf(metrics, name);
              const previousRaw = previous === null ? null : valueOf(previous, name);
              return (
                <KpiTile
                  key={name}
                  label={METRIC_LABELS[name]}
                  // Null stays null all the way here, so a duration nobody
                  // measured reads "not available" rather than 0s.
                  value={raw === null ? null : METRIC_FORMAT[name](raw)}
                  title={
                    name === 'visitors' || name === 'pageviews' ? formatExact(raw ?? 0) : undefined
                  }
                  help={(messages.metricHelp as Record<string, string>)[name]}
                  loading={loading}
                  selected={query.metric === name}
                  onSelect={() => set({ ...query, metric: name })}
                  delta={
                    // A rate moves in points and everything else moves in
                    // percent, because a bounce rate rising from 38 to 41 moved
                    // three points and "up 7.9%" is true and useless. Both take
                    // the nullable value, so an unmeasured number has no delta
                    // rather than a delta against a zero.
                    name === 'bounceRate'
                      ? deltaPoints(raw, previousRaw, GOOD_WHEN.bounceRate)
                      : delta(raw, previousRaw, GOOD_WHEN[name])
                  }
                />
              );
            })}
            <KpiTile
              label={messages.metrics.viewsPerVisit}
              value={formatRatio(ratio)}
              help={messages.metricHelp.viewsPerVisit}
              loading={loading}
              delta={delta(ratio, previousRatio, GOOD_WHEN.viewsPerVisit)}
            />
          </KpiRow>

          {series.isError ? (
            // A failed series is not an empty range. Drawn as "No data in this
            // range" it is a statement about the site rather than about the
            // request, and it is the statement somebody acts on.
            <div className={styles.chartPanel} style={{ minHeight: CHART_HEIGHT }}>
              <ErrorState error={series.error} onRetry={() => series.refetch()} />
            </div>
          ) : (
            // The chart draws its own loading state, so the head, the gap and
            // the legend are the same elements before and after the numbers
            // land and the panel is the same height in both. A rectangle of
            // the plot's height somewhere else is a shift of everything the
            // chrome around it is worth.
            <TimeChart
              title={METRIC_LABELS[query.metric]}
              metricLabel={METRIC_LABELS[query.metric]}
              points={points}
              previous={previousPoints}
              {...(compared === undefined ? {} : { previousLabel: compared.name })}
              interval={interval}
              timezone={timezone}
              formatValue={METRIC_FORMAT[query.metric]}
              formatExactValue={METRIC_EXACT[query.metric]}
              loading={series.isPending || (compared !== undefined && segmentSeries.isPending)}
              comparing={compared !== undefined || query.compare !== null}
              live={isLive(query.range, now)}
              marks={marks}
              rangeEnd={query.range.to}
            />
          )}
        </div>
      )}

      <div className={styles.cards}>
        <Card
          title={messages.overview.topPages}
          {...(converting ? {} : { metric: messages.metrics.visitors })}
          footer={{ to: `/${site.id}/pages`, label: messages.overview.viewAllPages }}
        >
          <BreakdownBody
            result={pages.result}
            rows={pages.rows}
            dimensionLabel={messages.dimensions.page}
            caption={messages.overview.topPages}
            hasFilters={hasFilters}
            onClearFilters={clear}
            converting={converting}
          />
        </Card>

        <Card
          title={messages.overview.sources}
          {...(converting ? {} : { metric: messages.metrics.visitors })}
          footer={{ to: `/${site.id}/sources`, label: messages.overview.viewAllSources }}
        >
          <BreakdownBody
            result={channels.result}
            rows={channels.rows}
            dimensionLabel={messages.dimensions.channel}
            caption={messages.overview.sources}
            hasFilters={hasFilters}
            onClearFilters={clear}
            converting={converting}
          />
        </Card>

        <Card
          title={messages.overview.countries}
          {...(converting ? {} : { metric: messages.metrics.visitors })}
          footer={{ to: `/${site.id}/geo`, label: messages.overview.viewGeography }}
        >
          <BreakdownBody
            result={countries.result}
            rows={countries.rows}
            dimensionLabel={messages.dimensions.country}
            caption={messages.overview.countries}
            hasFilters={hasFilters}
            onClearFilters={clear}
            converting={converting}
          />
        </Card>

        <Card
          title={messages.overview.deviceTypes}
          {...(converting ? {} : { metric: messages.metrics.visitors })}
          footer={{ to: `/${site.id}/devices`, label: messages.overview.viewAllDevices }}
        >
          <BreakdownBody
            result={devices.result}
            rows={devices.rows}
            dimensionLabel={messages.dimensions.device}
            caption={messages.overview.deviceTypes}
            hasFilters={hasFilters}
            onClearFilters={clear}
            converting={converting}
          />
        </Card>
      </div>
    </div>
  );
}
