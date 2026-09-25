import { useCallback, useMemo, type JSX } from 'react';
import { useLocation, useSearch } from 'wouter';

import { useApp } from '../app/context.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { toggleFilter } from '../lib/filters.js';
import { api } from '../lib/api.js';
import { exportName } from '../lib/download.js';
import { formatCount, formatExact } from '../lib/format.js';
import { toStatsParams } from '../lib/query.js';
import { useEvents, useProperties } from '../lib/queries.js';
import { format, messages } from '../messages/en.js';
import { ReportPage } from '../reports/ReportPage.js';
import { Breakdown, type BreakdownRowView } from '../ui/Breakdown.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { InfoDot } from '../ui/InfoDot.js';
import { Popover } from '../ui/Popover.js';
import popover from '../ui/Popover.module.css';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';
import styles from './Events.module.css';

// What pages and servers said happened, and what each of those things carried.
//
// The first card is every custom event of the range by name. A page timing is
// not in it: v.js sends its measurements as vitals, and a list where LCP sits
// between signup and checkout is a list that has mixed two kinds of fact. The
// second card breaks one event down by one of its properties, and which event
// is the filter on the page, so choosing one is clicking its row, the same as
// every other report, and the view is a link like every other view.
//
// Both read raw events, because a rollup keeps visitors per event name and
// never how many times, and a property is not a dimension at all. Neither takes
// a goal: the server refuses one on both, and a list of events counted against
// a goal is a question nobody asked.

const ROWS = 20;

// How many property names are tabs. A property name is whatever a page passed,
// so the rest go in a list behind one button rather than a strip of tabs that
// wraps across the card.
const PROPERTY_TABS = 8;

// Where the chosen property is kept. Its own parameter rather than a tab id
// known in advance, because the names are only known once the read answers.
const PROPERTY_PARAM = 'prop';

// The line that sends an event with a property. Code rather than English, so it
// is built here the way the add-site page builds its script tag and not kept in
// the messages file: a translation of it would not run, and its braces are not
// placeholders.
export function eventSnippet(name: string): string {
  return `pa('event', '${name.replace(/[\\']/g, (quote) => `\\${quote}`)}', { plan: 'pro' });`;
}

function rowsOf(
  rows: { key: string; visitors: number; events: number }[],
  onClick?: (key: string) => void,
): BreakdownRowView[] {
  const top = rows.reduce((best, row) => Math.max(best, row.visitors), 0);
  return rows.map((row) => ({
    key: row.key,
    label: row.key,
    value: formatCount(row.visitors),
    title: formatExact(row.visitors),
    secondary: formatCount(row.events),
    secondaryTitle: formatExact(row.events),
    share: top === 0 ? 0 : row.visitors / top,
    unknown: row.key === '',
    ...(onClick === undefined ? {} : { onClick: () => onClick(row.key) }),
  }));
}

function Loading(): JSX.Element {
  return (
    <div className={styles.loading}>
      {[0, 1, 2, 3, 4].map((index) => (
        <Skeleton key={index} height={26} width={`${100 - index * 12}%`} />
      ))}
    </div>
  );
}

function RawNote({ days }: { days: number }): JSX.Element {
  return <p className={styles.note}>{format(messages.metricHelp.rawOnly, { days })}</p>;
}

function retentionOf(meta: Record<string, unknown> | undefined, fallback: number): number {
  return typeof meta?.retentionDays === 'number' ? meta.retentionDays : fallback;
}

function EventsCard(): JSX.Element {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  const result = useEvents({ client, siteId: site.id, query, now }, ROWS);

  const rows = useMemo(
    () =>
      rowsOf(result.data?.data.rows ?? [], (key) =>
        set({ ...query, filters: toggleFilter(query.filters, { dim: 'event', op: 'is', value: key }) }),
      ),
    [result.data, set, query],
  );

  const body = (): JSX.Element => {
    if (result.isPending) {
      return <Loading />;
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
        <div className={styles.convention}>
          <p>{messages.events.empty}</p>
          <p>{messages.events.emptyLede}</p>
          <pre className={styles.snippet}>
            <code>{eventSnippet('signup')}</code>
          </pre>
        </div>
      );
    }
    return (
      <Breakdown
        rows={rows}
        dimensionLabel={messages.dimensions.event}
        valueLabel={messages.metrics.visitors}
        secondaryLabel={messages.metrics.events}
        showHead
        caption={messages.events.title}
      />
    );
  };

  return (
    <Card
      title={messages.events.title}
      help={<InfoDot label={messages.events.title} text={messages.events.help} />}
      download={{
        csvHref: api.exportUrl(client, site.id, toStatsParams(query), { report: 'events' }),
        json: () => result.data?.data,
        name: exportName(site.id, 'events', undefined, query.range),
        title: messages.events.title,
      }}
    >
      {body()}
      <RawNote days={retentionOf(result.data?.meta, site.settings.retentionDays)} />
    </Card>
  );
}

// The chosen property, read from and written to the link. Written the way a tab
// is, so the most used property, which is what the read answers when none is
// named, is left out of the link.
function usePropertyParam(): { asked: string | null; choose: (next: string, first: string) => void } {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const asked = new URLSearchParams(search).get(PROPERTY_PARAM);

  const choose = useCallback(
    (next: string, first: string) => {
      const params = new URLSearchParams(search);
      if (next === first) {
        params.delete(PROPERTY_PARAM);
      } else {
        params.set(PROPERTY_PARAM, next);
      }
      const text = params.toString();
      const target = `${location}${text === '' ? '' : `?${text}`}`;
      if (target !== `${location}${search === '' ? '' : `?${search}`}`) {
        navigate(target);
      }
    },
    [search, location, navigate],
  );

  return { asked: asked === '' ? null : asked, choose };
}

function PropertiesCard({ event }: { event: string | null }): JSX.Element {
  const { client, site, now } = useApp();
  const { query } = useViewQuery();
  const { asked, choose } = usePropertyParam();
  const result = useProperties({ client, siteId: site.id, query, now }, event, asked);
  const data = result.data?.data;

  const names = useMemo(() => (data?.properties ?? []).map((property) => property.key), [data]);
  const first = names[0] ?? '';
  const shown = names.slice(0, PROPERTY_TABS);
  const rest = names.slice(PROPERTY_TABS);
  const current = data?.property ?? null;
  const rows = useMemo(() => rowsOf(data?.rows ?? []), [data]);

  if (event === null) {
    return (
      <Card title={messages.events.propertiesTitle}>
        <EmptyState message={messages.events.propertiesPick} />
      </Card>
    );
  }

  const title = format(messages.events.properties, { event });

  const body = (): JSX.Element => {
    if (result.isPending) {
      return <Loading />;
    }
    if (result.isError) {
      return <ErrorState error={result.error} onRetry={() => result.refetch()} />;
    }
    if (current === null || names.length === 0) {
      return (
        <div className={styles.convention}>
          <p>{format(messages.events.propertiesEmpty, { event })}</p>
          <pre className={styles.snippet}>
            <code>{eventSnippet(event)}</code>
          </pre>
        </div>
      );
    }
    return (
      <>
        {rest.length > 0 && (
          <div className={styles.more}>
            <Popover
              align="left"
              label={messages.events.propertiesMore}
              trigger={({ open, toggle }) => (
                <Button variant="quiet" onClick={toggle} aria-expanded={open} aria-haspopup="true">
                  {rest.includes(current) ? current : messages.events.propertiesMore}
                </Button>
              )}
            >
              {({ close }) => (
                <>
                  <p className={popover.heading}>{messages.events.propertiesMore}</p>
                  {rest.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={[popover.item, name === current ? popover.itemCurrent : '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => {
                        choose(name, first);
                        close();
                      }}
                    >
                      <span>{name}</span>
                    </button>
                  ))}
                </>
              )}
            </Popover>
          </div>
        )}
        <Breakdown
          rows={rows}
          dimensionLabel={messages.dimensions.propertyValue}
          valueLabel={messages.metrics.visitors}
          secondaryLabel={messages.metrics.events}
          showHead
          caption={`${title}: ${current}`}
        />
        {/*
          Why these rows do nothing when clicked, on a page where every other
          row narrows the report: a property is not a dimension the store can
          filter by, and the card says so rather than looking broken.
        */}
        <p className={styles.note}>{messages.events.notFilterable}</p>
      </>
    );
  };

  return (
    <Card
      title={title}
      download={{
        csvHref: api.exportUrl(client, site.id, toStatsParams(query), {
          report: 'properties',
          event,
          ...(current === null ? {} : { property: current }),
        }),
        json: () => data,
        name: exportName(site.id, 'properties', event, query.range),
        title,
      }}
      {...(shown.length > 0
        ? {
            tabs: shown.map((name) => ({ id: name, label: name })),
            tab: current ?? '',
            onTab: (id: string) => choose(id, first),
          }
        : {})}
    >
      {body()}
      <RawNote days={retentionOf(result.data?.meta, site.settings.retentionDays)} />
    </Card>
  );
}

export function Events(): JSX.Element {
  const { query } = useViewQuery();
  // The event the page is filtered to is the event the second card is about.
  // Only an "is": an event that is not signup is not one event.
  const event = query.filters.find((filter) => filter.dim === 'event' && filter.op === 'is');

  return (
    <ReportPage title={messages.events.title}>
      <EventsCard />
      <PropertiesCard event={event?.value ?? null} />
    </ReportPage>
  );
}
