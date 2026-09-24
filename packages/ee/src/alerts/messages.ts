import type { Alert, AlertCondition, Site } from '@chokh/store';
import { wallClock } from '@chokh/store/time';

import type { Decision } from './conditions.js';

// Every sentence an alert says, in one file, the way the dashboard keeps its
// strings in one file: so another language can follow without a hunt, and so
// the message a phone shows at three in the morning was written on purpose.
//
// A message is a sentence and its numbers. No exclamation marks, no colour
// words, no "urgent": the reader decides how urgent it is, and the numbers
// are what they decide with.

export type AlertEvent = 'fired' | 'recovered' | 'test';

export interface AlertMessage {
  subject: string;
  text: string;
  // What a webhook receives. The text is in it too, so a receiver that only
  // forwards has nothing to compose.
  payload: Record<string, unknown>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// A window, said the way a person says it.
export function windowWords(minutes: number): string {
  if (minutes === 60) return 'an hour';
  if (minutes === 1440) return '24 hours';
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour', 'hours');
  return plural(minutes, 'minute', 'minutes');
}

// "in the last hour", "in the last 15 minutes".
function lastWindow(minutes: number): string {
  return minutes === 60 ? 'in the last hour' : `in the last ${windowWords(minutes)}`;
}

function metricWord(metric: 'visitors' | 'pageviews'): string {
  return metric === 'visitors' ? 'Visitors' : 'Pageviews';
}

function statusWords(statuses: '4xx' | '5xx' | 'any'): string {
  return statuses === 'any' ? 'an error' : `a ${statuses}`;
}

// What an alert watches, as one sentence for a list and for the test message.
export function describeCondition(condition: AlertCondition, goalName?: string): string {
  switch (condition.kind) {
    case 'traffic':
      return `${metricWord(condition.metric)} ${condition.direction === 'up' ? 'rise' : 'fall'} ${condition.percent}% against the usual for the hour, once either side reaches ${condition.minimum}`;
    case 'goal': {
      const name = goalName ?? condition.goalId;
      return condition.direction === 'above'
        ? `${name} happens ${plural(condition.count, 'time', 'times')} or more in ${windowWords(condition.window)}`
        : `${name} happens fewer than ${plural(condition.count, 'time', 'times')} in ${windowWords(condition.window)}`;
    }
    case 'errors':
      return `${plural(condition.count, 'page', 'pages')} or more answer ${statusWords(condition.statuses)} in ${windowWords(condition.window)}`;
    case 'silence':
      return `No pageview for ${windowWords(condition.minutes)}`;
  }
}

function clock(ts: number, timezone: string): string {
  const wall = wallClock(ts, timezone);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(wall.hour)}:${two(wall.minute)} ${timezone}`;
}

// The fact the numbers state, for a firing or a recovery.
export function factSentence(
  alert: Alert,
  site: Site,
  decision: Decision,
  at: number,
  goalName?: string,
): string {
  const condition = alert.condition;
  const timezone = site.settings.timezone;
  switch (condition.kind) {
    case 'traffic': {
      const baseline = decision.baseline ?? 0;
      const hourEnd = Math.floor(at / 3_600_000) * 3_600_000;
      const change =
        baseline > 0 ? Math.round((Math.abs(decision.value - baseline) / baseline) * 100) : null;
      const moved =
        change === null
          ? 'moved'
          : decision.value >= baseline
            ? `rose ${change}%`
            : `fell ${change}%`;
      return `${metricWord(condition.metric)} on ${site.name} ${moved} in the hour to ${clock(hourEnd, timezone)}: ${decision.value} against a usual ${Math.round(baseline)}.`;
    }
    case 'goal': {
      const name = goalName ?? condition.goalId;
      const asks =
        condition.direction === 'above'
          ? `${condition.count} or more`
          : `fewer than ${condition.count}`;
      return `${name} happened ${plural(decision.value, 'time', 'times')} on ${site.name} ${lastWindow(condition.window)}. The alert asks for ${asks}.`;
    }
    case 'errors':
      return `${plural(decision.value, 'page', 'pages')} answered ${statusWords(condition.statuses)} on ${site.name} ${lastWindow(condition.window)}. The alert asks for ${condition.count} or more.`;
    case 'silence':
      return decision.firing
        ? `No pageview on ${site.name} for ${windowWords(condition.minutes)}.`
        : `${plural(decision.value, 'pageview', 'pageviews')} on ${site.name} ${lastWindow(condition.minutes)}.`;
  }
}

export interface MessageInput {
  event: AlertEvent;
  alert: Alert;
  site: Site;
  // Absent for a test message, which has measured nothing.
  decision: Decision | null;
  at: number;
  publicUrl?: string | undefined;
  goalName?: string | undefined;
}

export function messageFor(input: MessageInput): AlertMessage {
  const { event, alert, site, decision, at } = input;
  const link = input.publicUrl === undefined ? null : `${input.publicUrl}/${site.id}/alerts`;
  const watches = describeCondition(alert.condition, input.goalName);

  let subject: string;
  let body: string;
  if (event === 'test') {
    subject = `Chokh: a test from "${alert.name}" on ${site.name}`;
    body = `This is a test message from the alert "${alert.name}" on ${site.name}. It watches: ${watches}. If you are reading this, the channel works.`;
  } else if (event === 'fired') {
    subject = `Chokh alert: ${alert.name} on ${site.name}`;
    body = decision === null ? watches : factSentence(alert, site, decision, at, input.goalName);
  } else {
    subject = `Chokh: ${alert.name} on ${site.name} is back to normal`;
    body = `Back to normal. ${decision === null ? watches : factSentence(alert, site, decision, at, input.goalName)}`;
  }
  const text = link === null ? body : `${body}\n${link}`;

  return {
    subject,
    text,
    payload: {
      event: `alert.${event}`,
      site: { id: site.id, name: site.name },
      alert: { id: alert.id, name: alert.name, condition: alert.condition },
      at,
      value: decision?.value ?? null,
      baseline: decision?.baseline ?? null,
      text: body,
      url: link,
    },
  };
}
