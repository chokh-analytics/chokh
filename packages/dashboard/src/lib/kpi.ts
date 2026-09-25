import type { Metrics } from '@chokh/store/contract';

import { formatCount, formatDuration, formatExact, formatRate } from './format.js';
import { messages } from '../messages/en.js';
import type { MetricName } from './query.js';

// The four headline metrics as the Overview and the shared page both draw
// them: the label, the value off a metrics row, and how it is written, so a
// tile, a chart axis, a hover card and the hidden table say the same thing.

export const METRIC_LABELS: Record<MetricName, string> = {
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
export function valueOf(metrics: Metrics, name: MetricName): number | null {
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
export const METRIC_FORMAT: Record<MetricName, (value: number) => string> = {
  visitors: formatCount,
  pageviews: formatCount,
  bounceRate: (value) => formatRate(value) ?? '',
  avgDuration: (value) => formatDuration(value) ?? '',
};

export const METRIC_EXACT: Record<MetricName, (value: number) => string> = {
  visitors: formatExact,
  pageviews: formatExact,
  bounceRate: (value) => formatRate(value) ?? '',
  avgDuration: (value) => formatDuration(value) ?? '',
};
