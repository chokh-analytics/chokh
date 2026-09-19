import type { JSX } from 'react';

import { messages } from '../messages/en.js';
import { DimensionCard } from '../reports/DimensionCard.js';
import { ReportPage, ReportRow } from '../reports/ReportPage.js';
import { InfoDot } from '../ui/InfoDot.js';

// What people read the site on.
//
// Four lists, and the last one is the one that changes what somebody does: a
// browser share is interesting and a screen width distribution is actionable,
// because it says which of the breakpoints in the stylesheet actually carry
// traffic. The store buckets the width when the event is written, so this
// report never sees a raw pixel count: a person at 1439 and a person at 1441
// are the same fact about a layout.

const KIND_TABS = [{ id: 'device', dim: 'device' as const, label: messages.dimensions.device }];
const BROWSER_TABS = [{ id: 'browser', dim: 'browser' as const, label: messages.dimensions.browser }];
const OS_TABS = [{ id: 'os', dim: 'os' as const, label: messages.dimensions.os }];
const SCREEN_TABS = [{ id: 'screen', dim: 'screen' as const, label: messages.dimensions.screen }];
const LANG_TABS = [{ id: 'lang', dim: 'lang' as const, label: messages.dimensions.lang }];

export function Devices(): JSX.Element {
  return (
    <ReportPage title={messages.reports.devicesTitle}>
      <ReportRow>
        <DimensionCard title={messages.reports.deviceKinds} tabs={KIND_TABS} param="kind" />
        <DimensionCard
          title={messages.reports.screens}
          tabs={SCREEN_TABS}
          param="screen"
          help={<InfoDot label={messages.reports.screens} text={messages.reports.screensHelp} />}
        />
      </ReportRow>
      <ReportRow>
        <DimensionCard title={messages.reports.browsers} tabs={BROWSER_TABS} param="browser" />
        <DimensionCard title={messages.reports.systems} tabs={OS_TABS} param="os" />
      </ReportRow>
      <DimensionCard title={messages.reports.languages} tabs={LANG_TABS} param="lang" />
    </ReportPage>
  );
}
