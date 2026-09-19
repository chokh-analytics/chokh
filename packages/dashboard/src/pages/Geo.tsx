import { useMemo, type JSX } from 'react';

import { useApp } from '../app/context.js';
import { useViewQuery } from '../app/useViewQuery.js';
import { toggleFilter } from '../lib/filters.js';
import { useBreakdown } from '../lib/queries.js';
import { messages } from '../messages/en.js';
import { DimensionCard } from '../reports/DimensionCard.js';
import { ReportPage } from '../reports/ReportPage.js';
import { Card } from '../ui/Card.js';
import { Choropleth } from '../ui/Choropleth.js';
import { EmptyState, ErrorState, Skeleton } from '../ui/State.js';

// Where visitors are, as a map and as three lists.
//
// The map is the picture and the table is the answer: a country three shades
// darker than another is a country with more visitors, and how many more is a
// question only the number can settle. So the map paints five bands and never
// pretends to more precision than a shade can carry, and the ranking sits under
// it with the figures in it.
//
// Clicking a country filters the page rather than opening a country page. The
// rest of the report then answers "which cities, which pages, which browsers,
// in that country", which is what somebody clicking a country wanted.

// Enough countries to paint the map without asking for a list nobody reads: the
// world has fewer than 250 and the store's ceiling is 100, so this is every
// country a site realistically has in a range.
const MAP_LIMIT = 100;

const PLACE_TABS = [
  { id: 'country', dim: 'country' as const, label: messages.reports.tabCountry },
  { id: 'region', dim: 'region' as const, label: messages.reports.tabRegion },
  { id: 'city', dim: 'city' as const, label: messages.reports.tabCity },
];

function Map(): JSX.Element {
  const { client, site, now } = useApp();
  const { query, set } = useViewQuery();
  const result = useBreakdown({ client, siteId: site.id, query, now }, 'country', MAP_LIMIT);

  const countries = useMemo(
    () =>
      (result.data?.data.rows ?? [])
        .filter((row) => row.key !== '')
        .map((row) => ({ key: row.key, visitors: row.metrics.visitors })),
    [result.data],
  );

  return (
    <Card title={messages.reports.map} metric={messages.metrics.visitors}>
      {result.isPending ? (
        // The map's own aspect ratio, so the page does not jump by the height
        // of a world when it lands.
        <Skeleton height={0} style={{ aspectRatio: '960 / 420' }} />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => result.refetch()} />
      ) : countries.length === 0 ? (
        <EmptyState message={messages.reports.mapEmpty} />
      ) : (
        <Choropleth
          countries={countries}
          onSelect={(key) =>
            set({
              ...query,
              filters: toggleFilter(query.filters, { dim: 'country', op: 'is', value: key }),
            })
          }
        />
      )}
    </Card>
  );
}

export function Geo(): JSX.Element {
  return (
    <ReportPage title={messages.reports.geoTitle}>
      <Map />
      <DimensionCard
        title={messages.reports.places}
        tabs={PLACE_TABS}
        param="places"
        secondary="pageviews"
      />
    </ReportPage>
  );
}
