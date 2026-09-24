import type { JSX } from 'react';

import { messages } from '../messages/en.js';
import { DimensionCard } from '../reports/DimensionCard.js';
import { ReportPage } from '../reports/ReportPage.js';
import { InfoDot } from '../ui/InfoDot.js';

// Where visits came from, channel first.
//
// Channel first is the position this product takes and it is not the usual one.
// A list of referrers puts google.com, google.co.uk, news.google.com and
// t.co in four rows and leaves the reader to add up; a channel has already
// answered the question somebody actually asked, which is whether the traffic
// was earned, bought, sent by somebody else or typed in. The referrer list is
// still here, one card below, because "which page linked to me" is a real
// question too, it is just the second one.

const CHANNEL_TABS = [
  { id: 'channel', dim: 'channel' as const, label: messages.dimensions.channel },
];

const REFERRER_TABS = [
  { id: 'referrer', dim: 'referrer' as const, label: messages.dimensions.referrer },
];

const CAMPAIGN_TABS = [
  {
    id: 'source',
    dim: 'utm_source' as const,
    label: messages.reports.tabSource,
    dimensionLabel: messages.dimensions.utm_source,
  },
  {
    id: 'medium',
    dim: 'utm_medium' as const,
    label: messages.reports.tabMedium,
    dimensionLabel: messages.dimensions.utm_medium,
  },
  {
    id: 'campaign',
    dim: 'utm_campaign' as const,
    label: messages.reports.tabCampaign,
    dimensionLabel: messages.dimensions.utm_campaign,
  },
  {
    id: 'term',
    dim: 'utm_term' as const,
    label: messages.reports.tabTerm,
    dimensionLabel: messages.dimensions.utm_term,
  },
  {
    id: 'content',
    dim: 'utm_content' as const,
    label: messages.reports.tabContent,
    dimensionLabel: messages.dimensions.utm_content,
  },
];

export function Sources(): JSX.Element {
  return (
    <ReportPage title={messages.reports.sourcesTitle}>
      {/*
        A channel is a property of a whole visit, and a click on one narrows
        every report to the visits that came in that way: the store answers
        the filter by the stays that match it.
      */}
      <DimensionCard
        title={messages.reports.channels}
        tabs={CHANNEL_TABS}
        param="channels"
        secondary="bounceRate"
        note={messages.reports.channelsAiNote}
        help={
          <InfoDot label={messages.reports.channels} text={messages.reports.channelsHelp} />
        }
      />
      <DimensionCard
        title={messages.reports.referrers}
        tabs={REFERRER_TABS}
        param="referrers"
        secondary="pageviews"
        note={messages.reports.referrersNote}
      />
      <DimensionCard
        title={messages.reports.campaigns}
        tabs={CAMPAIGN_TABS}
        param="utm"
        secondary="pageviews"
      />
    </ReportPage>
  );
}
