import { z } from 'zod';
import {
  addDays,
  dayBounds,
  dayKey,
  wallClock,
  DIGEST_CADENCES,
  MAX_DIGEST_RECIPIENTS,
  type Digest,
  type DigestCadence,
} from '@chokh/store';

// When a digest goes and what it covers (AN-RPT01, the paid half).
//
// A period is a whole number of the site's own days ending yesterday: a daily
// digest is yesterday, a weekly one the seven days ending yesterday. Its key
// is what the claim is made on, so it sorts the way time does within a
// cadence, and a process that reads a later key than the row holds may send
// and one that reads the same or an earlier one may not.

export const DIGESTS_FEATURE = 'digests';

export interface DigestPeriod {
  key: string;
  from: number;
  to: number;
  // The first and last day of the period, as the site's own day keys.
  firstDay: string;
  lastDay: string;
}

export function periodFor(cadence: DigestCadence, now: number, timezone: string): DigestPeriod {
  const lastDay = addDays(dayKey(now, timezone), -1);
  const firstDay = cadence === 'daily' ? lastDay : addDays(lastDay, -6);
  return {
    key: `${cadence === 'daily' ? 'd' : 'w'}:${lastDay}`,
    from: dayBounds(firstDay, timezone).start,
    to: dayBounds(lastDay, timezone).end,
    firstDay,
    lastDay,
  };
}

// 0 Sunday to 6 Saturday, of a day key, which is a calendar question and not
// a zone question: the key is already the site's own day.
export function weekdayOf(dayKeyValue: string): number {
  const [year, month, day] = dayKeyValue.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Whether this digest's hour has come today in the site's zone, and, for a
// weekly one, whether today is its day. The claim decides the rest.
export function isDue(digest: Pick<Digest, 'cadence' | 'hour' | 'weekday'>, now: number, timezone: string): boolean {
  const clock = wallClock(now, timezone);
  if (clock.hour < digest.hour) {
    return false;
  }
  if (digest.cadence === 'weekly') {
    return weekdayOf(dayKey(now, timezone)) === (digest.weekday ?? 1);
  }
  return true;
}

const address = z.string().trim().min(3).max(254).email('That is not an address');

export const createDigestSchema = z
  .object({
    cadence: z.enum(DIGEST_CADENCES as [DigestCadence, ...DigestCadence[]]),
    to: z
      .array(address)
      .min(1, 'A digest needs an address')
      .max(MAX_DIGEST_RECIPIENTS, `A digest goes to at most ${MAX_DIGEST_RECIPIENTS} addresses`),
    hour: z.number().int().min(0).max(23).default(8),
    weekday: z.number().int().min(0).max(6).optional(),
  })
  .strict();

export type CreateDigestInput = z.infer<typeof createDigestSchema>;

export const digestParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
  digestId: z.string().min(1).max(64),
});
