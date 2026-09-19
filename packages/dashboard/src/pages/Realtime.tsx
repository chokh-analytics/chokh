import { useMemo, type JSX } from 'react';
import { useLocation } from 'wouter';
import type { RealtimeSnapshot, RealtimeVisitor } from '@chokh/store/contract';

import { useApp } from '../app/context.js';
import { api, identityAllowed } from '../lib/api.js';
import { useEventStream, type StreamOptions } from '../lib/sse.js';
import { formatCount } from '../lib/format.js';
import { REALTIME_POLL_MS, useRealtime, useTimeseries } from '../lib/queries.js';
import type { DateRange } from '../lib/range.js';
import { DEFAULT_METRIC, type ViewQuery } from '../lib/query.js';
import { format, messages } from '../messages/en.js';
import { Breakdown, type BreakdownRowView } from '../ui/Breakdown.js';
import { Card } from '../ui/Card.js';
import { KpiRow, KpiTile, LiveDot, LiveValue } from '../ui/KpiTile.js';
import { Sparkline } from '../ui/Sparkline.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import { VisitorList } from '../ui/VisitorList.js';
import { WorldMap, type MapCity } from '../ui/WorldMap.js';
import styles from './Realtime.module.css';

// Who is here now.
//
// The report neither Plausible nor Fathom has: they both show a count and a
// thirty minute chart, and neither shows who. That is a deliberate position on
// their part and this is a deliberate position on ours, which is why the
// address is behind a permission, every read of it is logged, and the page says
// so on screen rather than in a policy.
//
// Two lists, and the second is the founder's decision: online first, then the
// rest of the half hour in a muted tone, because a page that empties at three
// in the morning reads as broken.

const MINUTES = 30;

// The window the sparkline draws, resolved once per render against the clock
// the shell holds. Its own query rather than the view's, because this page has
// no range bar: it is always the last half hour.
function lastHalfHour(now: number): DateRange {
  return { preset: 'custom', from: now - MINUTES * 60_000, to: now };
}

function minuteQuery(now: number): ViewQuery {
  return {
    range: lastHalfHour(now),
    compare: null,
    filters: [],
    interval: 'minute',
    metric: DEFAULT_METRIC,
  };
}

function countRows(
  rows: { key: string; visitors: number }[],
  label: (key: string) => string,
): BreakdownRowView[] {
  const top = rows.reduce((best, row) => Math.max(best, row.visitors), 0);
  return rows.map((row) => ({
    key: row.key,
    label: label(row.key),
    value: formatCount(row.visitors),
    share: top === 0 ? 0 : row.visitors / top,
  }));
}

export interface RealtimeProps {
  // How the stream is opened. The page makes its own EventSource in a browser;
  // a test hands one in, because jsdom has no EventSource and a page that only
  // ever polls never exercises the live half of this file.
  stream?: StreamOptions;
}

export function Realtime({ stream: streamOptions }: RealtimeProps = {}): JSX.Element {
  const { client, site, now } = useApp();
  const [, navigate] = useLocation();

  // The stream first, the poll behind it. Both answer the same envelope, which
  // is why the server framed a frame that way, so the page reads one shape.
  const stream = useEventStream<RealtimeSnapshot>(
    api.streamUrl(client, site.id),
    streamOptions ?? {},
  );
  const polled = useRealtime(client, site.id, stream.state === 'live' ? false : REALTIME_POLL_MS);
  const snapshot = stream.data ?? polled.data?.data ?? null;

  // Whether the payload carries an address, from the server's own meta rather
  // than from a missing field: absent and withheld look identical and mean
  // different things. The stream says so when it opens; until a poll has
  // answered, the safe reading is that it does not.
  const identity = identityAllowed(polled.data?.meta);

  const series = useTimeseries({ client, siteId: site.id, query: minuteQuery(now), now });
  const perMinute = useMemo(
    () => (series.data?.data.points ?? []).map((point) => point.metrics.pageviews),
    [series.data],
  );

  const cities: MapCity[] = useMemo(
    () =>
      (snapshot?.byCity ?? []).map((row) => ({
        key: row.key,
        visitors: row.visitors,
        ...(row.country === undefined ? {} : { country: row.country }),
        ...(row.lat === undefined ? {} : { lat: row.lat }),
        ...(row.lon === undefined ? {} : { lon: row.lon }),
      })),
    [snapshot],
  );

  const toPeople = (visitor: RealtimeVisitor): void =>
    navigate(`/${site.id}/people/v/${encodeURIComponent(visitor.visitorId)}`);

  const failed = polled.isError && stream.data === null;
  const loading = snapshot === null && !failed;
  const nobody = snapshot !== null && snapshot.visitors.length === 0 && snapshot.recent.length === 0;

  return (
    <div className={styles.page}>
      <h1 className="sr-only">{messages.realtime.title}</h1>

      {/*
        Which of the two is running, said on screen. Somebody reading a page
        that calls itself live deserves to know whether it is, and a page that
        quietly fell back to polling is a page that looks live and is a few
        seconds behind.
      */}
      <p className={styles.status}>
        <LiveDot on={stream.state === 'live' && !failed} />
        {stream.state === 'live'
          ? messages.realtime.live
          : stream.state === 'connecting'
            ? messages.realtime.connecting
            : format(messages.realtime.polling, { seconds: REALTIME_POLL_MS / 1000 })}
      </p>

      {failed ? (
        <ErrorState error={polled.error} onRetry={() => void polled.refetch()} />
      ) : (
        <>
          <div className={styles.headline}>
            <KpiRow>
              <KpiTile
                label={messages.metrics.onlineNow}
                value={String(snapshot?.online ?? 0)}
                help={messages.metricHelp.onlineNow}
                loading={loading}
                live={
                  <LiveValue
                    count={snapshot?.online ?? 0}
                    note={format(messages.metrics.signedInSplit, {
                      signedIn: snapshot?.signedIn ?? 0,
                      anonymous: snapshot?.anonymous ?? 0,
                    })}
                  />
                }
              />
            </KpiRow>
            <div className={styles.spark}>
              <p className={styles.sparkTitle}>{messages.realtime.sparkline}</p>
              <Sparkline
                values={perMinute}
                label={messages.realtime.sparkline}
                now={perMinute[perMinute.length - 1] ?? 0}
                loading={series.isPending}
              />
            </div>
          </div>

          <div className={styles.split}>
            <Card title={messages.realtime.whereTheyAre}>
              {loading ? (
                <Skeleton height={260} />
              ) : (
                <WorldMap
                  cities={cities}
                  onSelect={(city) =>
                    navigate(`/${site.id}/geo?filters=${encodeURIComponent(`city==${city.key}`)}`)
                  }
                />
              )}
            </Card>

            <div className={styles.stack}>
              <Card title={messages.realtime.onPages} metric={messages.metrics.visitors}>
                {snapshot === null || snapshot.byPage.length === 0 ? (
                  <EmptyState message={messages.states.empty} />
                ) : (
                  <Breakdown
                    rows={countRows(snapshot.byPage, (key) => key)}
                    dimensionLabel={messages.dimensions.page}
                    valueLabel={messages.metrics.visitors}
                    caption={messages.realtime.onPages}
                  />
                )}
              </Card>
              <Card title={messages.realtime.fromCountries} metric={messages.metrics.visitors}>
                {snapshot === null || snapshot.byCountry.length === 0 ? (
                  <EmptyState message={messages.states.empty} />
                ) : (
                  <Breakdown
                    rows={countRows(snapshot.byCountry, (key) => key)}
                    dimensionLabel={messages.dimensions.country}
                    valueLabel={messages.metrics.visitors}
                    caption={messages.realtime.fromCountries}
                  />
                )}
              </Card>
            </div>
          </div>

          <Card title={messages.realtime.listCaption}>
            {loading ? (
              <Skeleton height={180} />
            ) : nobody ? (
              <EmptyState message={messages.realtime.nobody} />
            ) : (
              <>
                <VisitorList
                  online={snapshot?.visitors ?? []}
                  recent={snapshot?.recent ?? []}
                  identity={identity}
                  now={now}
                  onSelect={toPeople}
                />
                {/*
                  Said either way. Without the permission the column is absent
                  rather than blank, with a line saying which permission shows
                  it; with it, the page says the read was logged, because making
                  the audit visible to the person it protects is the point of
                  having one.
                */}
                <p className={styles.identity}>
                  {identity ? messages.identity.granted : messages.identity.columnHidden}
                </p>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
