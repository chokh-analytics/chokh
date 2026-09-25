import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Dimension } from '@chokh/store/contract';

import { AppContext, useApp, type AppContextValue } from '../app/context.js';
import { useNow } from '../app/useNow.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { api, type PublicSite, type ShareHead } from '../lib/api.js';
import { ChokhError, type Client } from '../lib/client.js';
import { toggleFilter } from '../lib/filters.js';
import {
  countryName,
  delta,
  deltaPoints,
  formatCount,
  formatExact,
  formatRatio,
  GOOD_WHEN,
  viewsPerVisit,
} from '../lib/format.js';
import { METRIC_EXACT, METRIC_FORMAT, METRIC_LABELS, valueOf } from '../lib/kpi.js';
import { METRICS } from '../lib/query.js';
import {
  annotationSpan,
  useAggregate,
  useAnnotations,
  useBreakdown,
  useTimeseries,
} from '../lib/queries.js';
import { defaultInterval, isLive, resolvePreset, type Preset } from '../lib/range.js';
import { shareClient } from '../lib/share-client.js';
import { format, messages } from '../messages/en.js';
import { Breakdown, Code, type BreakdownRowView } from '../ui/Breakdown.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { KpiRow, KpiTile } from '../ui/KpiTile.js';
import { Splash } from '../ui/Splash.js';
import { EmptyState, ErrorState, Skeleton, Working } from '../ui/State.js';
import { CHART_HEIGHT, TimeChart, type ChartMark, type ChartPoint } from '../ui/TimeChart.js';
import { Wordmark } from '../ui/Wordmark.js';
import styles from './Share.module.css';

// The shared page (AN-RPT01, founder decision D2): the Overview's numbers,
// chart and four cards for whoever holds the link, and nothing about a person.
//
// It is outside the shell and the boot: no GET /api/me, no navigation, no
// site switcher. What it draws is the Overview's own components over the
// Overview's own hooks, given a client that reads the share's routes and a
// synthetic site that carries the name and the zone the share answered with,
// so the two pages cannot drift apart. The range presets are the four the
// range bar offers; the rest of the bar (a custom window, a goal, a segment)
// is a question for somebody signed in.

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: messages.range.today },
  { id: 'yesterday', label: messages.range.yesterday },
  { id: '7d', label: messages.range.last7 },
  { id: '30d', label: messages.range.last30 },
];

// Nobody, as far as the hooks are concerned: a share has no account, no team
// and no site list, and every hook that reads one reads an empty one.
const SHARE_ME: AppContextValue['me'] = {
  actor: { kind: 'key', id: 'share' },
  user: null,
  sites: [],
  teams: [],
};

function syntheticSite(token: string, head: ShareHead['site']): PublicSite {
  return {
    id: `share:${token}`,
    name: head.name,
    domains: [],
    teamId: 'share',
    settings: {
      ipMode: 'none',
      visitorIdMode: 'cookieless',
      botFilter: true,
      retentionDays: 0,
      timezone: head.timezone,
      allowUnsignedIdentify: false,
      excludeIps: [],
      excludePaths: [],
      excludeQueryParams: [],
      routeGroups: [],
    },
  };
}

export function Share({ client, token }: { client: Client; token: string }): JSX.Element {
  const now = useNow();
  const head = useQuery({
    queryKey: ['share', token],
    queryFn: () => api.share(client, token),
    retry: false,
  });
  const name = head.data?.data.site.name;

  useEffect(() => {
    document.title =
      name === undefined
        ? messages.app.name
        : `${format(messages.share.documentTitle, { name })} · ${messages.app.name}`;
  }, [name]);

  if (head.isPending) {
    return <Splash />;
  }
  if (head.isError) {
    const gone = head.error instanceof ChokhError && head.error.status === 404;
    return (
      <Frame>
        <div className={styles.notice}>
          <h1 className={styles.noticeTitle}>
            {gone ? messages.share.notFound : messages.states.error}
          </h1>
          {gone ? (
            <p className={styles.noticeLede}>{messages.share.notFoundLede}</p>
          ) : (
            <ErrorState error={head.error} onRetry={() => head.refetch()} />
          )}
        </div>
      </Frame>
    );
  }

  const answer = head.data.data;
  if (answer.protected && !answer.unlocked) {
    return (
      <Frame>
        <Unlock
          client={client}
          token={token}
          name={answer.site.name}
          onUnlocked={() => void head.refetch()}
        />
      </Frame>
    );
  }

  const value: AppContextValue = {
    client: shareClient(client, token),
    me: SHARE_ME,
    site: syntheticSite(token, answer.site),
    now,
  };
  return (
    <AppContext.Provider value={value}>
      <Frame>
        <SharedOverview name={answer.site.name} />
      </Frame>
    </AppContext.Provider>
  );
}

// The page around whatever is drawn: the wordmark above, the line below.
function Frame({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className={styles.frame}>
      <header className={styles.top}>
        <a
          className={styles.brand}
          href={messages.share.poweredByHref}
          rel="noreferrer"
          target="_blank"
        >
          <Wordmark />
        </a>
        <span className={styles.badge}>{messages.share.lede}</span>
      </header>
      <main className={styles.main} aria-label={messages.a11y.mainLandmark}>
        {children}
      </main>
      <footer className={styles.foot}>
        <a href={messages.share.poweredByHref} rel="noreferrer" target="_blank">
          {messages.share.poweredBy}
        </a>
      </footer>
    </div>
  );
}

function Unlock({
  client,
  token,
  name,
  onUnlocked,
}: {
  client: Client;
  token: string;
  name: string;
  onUnlocked: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password === '') {
      setProblem(messages.share.wrongPassword);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.unlockShare(client, token, password);
      onUnlocked();
    } catch (error) {
      setProblem(
        error instanceof ChokhError && error.status === 401
          ? messages.share.wrongPassword
          : error instanceof ChokhError
            ? error.message
            : messages.states.error,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.notice} onSubmit={submit} noValidate>
      <h1 className={styles.noticeTitle}>{messages.share.locked}</h1>
      <p className={styles.noticeLede}>{format(messages.share.lockedLede, { name })}</p>
      <Field
        label={messages.share.password}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.currentTarget.value)}
        {...(problem === null ? {} : { problem })}
        autoFocus
      />
      <div className={styles.noticeActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? messages.share.unlocking : messages.share.unlock}
        </Button>
      </div>
    </form>
  );
}

function useCard(
  dim: Dimension,
  label: (key: string) => string,
  icon?: (key: string) => JSX.Element | undefined,
) {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  const result = useBreakdown({ client, siteId: site.id, query, now }, dim, 5, false);
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
      unknown: row.key === '',
      // The same rule as the Overview: any row narrows the page.
      onClick: () =>
        set({ ...query, filters: toggleFilter(query.filters, { dim, op: 'is', value: row.key }) }),
    }));
  }, [result.data, label, icon, dim, set, query]);
  return { result, rows };
}

function CardBody({
  result,
  rows,
  dimensionLabel,
  caption,
  hasFilters,
  onClearFilters,
}: {
  result: { isPending: boolean; isError: boolean; error: unknown; refetch: () => void };
  rows: BreakdownRowView[];
  dimensionLabel: string;
  caption: string;
  hasFilters: boolean;
  onClearFilters: () => void;
}): JSX.Element {
  if (result.isPending) {
    return (
      <div className={styles.loading}>
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
  return (
    <Breakdown
      rows={rows}
      dimensionLabel={dimensionLabel}
      valueLabel={messages.metrics.visitors}
      caption={caption}
    />
  );
}

function SharedOverview({ name }: { name: string }): JSX.Element {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  const context = { client, siteId: site.id, query, now };
  const timezone = site.settings.timezone;

  const totals = useAggregate(context);
  const series = useTimeseries(context);
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
  const previousPoints: ChartPoint[] | null = useMemo(
    () =>
      series.data?.data.previous === null || series.data?.data.previous === undefined
        ? null
        : series.data.data.previous.map((point) => ({
            start: point.start,
            value: valueOf(point.metrics, query.metric) ?? 0,
          })),
    [series.data, query.metric],
  );

  const pages = useCard('page', (key) => key);
  const channels = useCard(
    'channel',
    (key) => (messages.channels as Record<string, string>)[key] ?? key,
  );
  const countries = useCard(
    'country',
    (key) => countryName(key) ?? key,
    (key) => <Code>{key}</Code>,
  );
  const devices = useCard(
    'device',
    (key) => (messages.devices as Record<string, string>)[key] ?? key,
  );

  const loading = totals.isPending;
  const hasFilters = query.filters.length > 0;
  const clear = (): void => set({ ...query, filters: [] });
  const ratio = metrics === undefined ? null : viewsPerVisit(metrics.pageviews, metrics.visits);
  const previousRatio =
    previous === null ? null : viewsPerVisit(previous.pageviews, previous.visits);

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>{name}</h1>
        <div className={styles.presets} role="group" aria-label={messages.range.presets}>
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
        </div>
      </div>
      {hasFilters && (
        <p className={styles.filtered}>
          <Button variant="quiet" onClick={clear}>
            {messages.filters.clear}
          </Button>
        </p>
      )}

      {totals.isError ? (
        <ErrorState error={totals.error} onRetry={() => totals.refetch()} />
      ) : (
        <div className={styles.headline}>
          {(totals.isFetching || series.isFetching) && !loading && <Working />}
          <KpiRow>
            {METRICS.map((metric) => {
              const raw = metrics === undefined ? null : valueOf(metrics, metric);
              const previousRaw = previous === null ? null : valueOf(previous, metric);
              return (
                <KpiTile
                  key={metric}
                  label={METRIC_LABELS[metric]}
                  value={raw === null ? null : METRIC_FORMAT[metric](raw)}
                  title={
                    metric === 'visitors' || metric === 'pageviews'
                      ? formatExact(raw ?? 0)
                      : undefined
                  }
                  help={(messages.metricHelp as Record<string, string>)[metric]}
                  loading={loading}
                  selected={query.metric === metric}
                  onSelect={() => set({ ...query, metric })}
                  delta={
                    metric === 'bounceRate'
                      ? deltaPoints(raw, previousRaw, GOOD_WHEN.bounceRate)
                      : delta(raw, previousRaw, GOOD_WHEN[metric])
                  }
                />
              );
            })}
            <KpiTile
              label={messages.metrics.viewsPerVisit}
              value={ratio === null ? null : formatRatio(ratio)}
              help={messages.metricHelp.viewsPerVisit}
              loading={loading}
              delta={delta(ratio, previousRatio, 'up')}
            />
          </KpiRow>
          {series.isError ? (
            <div className={styles.chartPanel} style={{ minHeight: CHART_HEIGHT }}>
              <ErrorState error={series.error} onRetry={() => series.refetch()} />
            </div>
          ) : (
            <TimeChart
              title={METRIC_LABELS[query.metric]}
              metricLabel={METRIC_LABELS[query.metric]}
              points={points}
              previous={previousPoints}
              interval={interval}
              timezone={timezone}
              formatValue={METRIC_FORMAT[query.metric]}
              formatExactValue={METRIC_EXACT[query.metric]}
              loading={series.isPending}
              comparing={query.compare !== null}
              live={isLive(query.range, now)}
              marks={marks}
              rangeEnd={annotationSpan(query, now).to}
            />
          )}
        </div>
      )}

      <div className={styles.cards}>
        <Card title={messages.overview.topPages} metric={messages.metrics.visitors}>
          <CardBody
            result={pages.result}
            rows={pages.rows}
            dimensionLabel={messages.dimensions.page}
            caption={messages.overview.topPages}
            hasFilters={hasFilters}
            onClearFilters={clear}
          />
        </Card>
        <Card title={messages.overview.sources} metric={messages.metrics.visitors}>
          <CardBody
            result={channels.result}
            rows={channels.rows}
            dimensionLabel={messages.dimensions.channel}
            caption={messages.overview.sources}
            hasFilters={hasFilters}
            onClearFilters={clear}
          />
        </Card>
        <Card title={messages.overview.countries} metric={messages.metrics.visitors}>
          <CardBody
            result={countries.result}
            rows={countries.rows}
            dimensionLabel={messages.dimensions.country}
            caption={messages.overview.countries}
            hasFilters={hasFilters}
            onClearFilters={clear}
          />
        </Card>
        <Card title={messages.overview.deviceTypes} metric={messages.metrics.visitors}>
          <CardBody
            result={devices.result}
            rows={devices.rows}
            dimensionLabel={messages.dimensions.device}
            caption={messages.overview.deviceTypes}
            hasFilters={hasFilters}
            onClearFilters={clear}
          />
        </Card>
      </div>
    </div>
  );
}
