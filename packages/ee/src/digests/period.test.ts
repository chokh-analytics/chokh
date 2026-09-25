import { describe, expect, it } from 'vitest';

import { createDigestSchema, isDue, periodFor, weekdayOf } from './period.js';

// The period arithmetic in the site's own zone: yesterday is the site's
// yesterday, and a week ends there too.

const DHAKA = 'Asia/Dhaka';
// 2026-09-25 03:30 in Dhaka, which is 2026-09-24 21:30 UTC.
const EARLY = Date.UTC(2026, 8, 24, 21, 30);
// 2026-09-25 08:05 in Dhaka.
const MORNING = Date.UTC(2026, 8, 25, 2, 5);

describe('periodFor', () => {
  it('is yesterday in the site zone for a daily digest, with its bounds', () => {
    const period = periodFor('daily', EARLY, DHAKA);
    expect(period.key).toBe('d:2026-09-24');
    expect(period.firstDay).toBe('2026-09-24');
    expect(period.lastDay).toBe('2026-09-24');
    // Dhaka midnight is 18:00 UTC the evening before.
    expect(period.from).toBe(Date.UTC(2026, 8, 23, 18));
    expect(period.to).toBe(Date.UTC(2026, 8, 24, 18));
    expect(periodFor('daily', EARLY, 'UTC').key).toBe('d:2026-09-23');
  });

  it('is the seven days ending yesterday for a weekly one', () => {
    const period = periodFor('weekly', MORNING, DHAKA);
    expect(period.key).toBe('w:2026-09-24');
    expect(period.firstDay).toBe('2026-09-18');
    expect(period.lastDay).toBe('2026-09-24');
    expect(period.to - period.from).toBe(7 * 86_400_000);
  });

  it('keys sort the way time does within a cadence', () => {
    expect('d:2026-09-24' < 'd:2026-09-25').toBe(true);
    expect('w:2026-09-24' < 'w:2026-10-01').toBe(true);
  });
});

describe('isDue', () => {
  it('waits for the hour in the site zone', () => {
    expect(isDue({ cadence: 'daily', hour: 8 }, EARLY, DHAKA)).toBe(false);
    expect(isDue({ cadence: 'daily', hour: 8 }, MORNING, DHAKA)).toBe(true);
    expect(isDue({ cadence: 'daily', hour: 3 }, EARLY, DHAKA)).toBe(true);
    // The same instant read in UTC is still the day before, at 21:30.
    expect(isDue({ cadence: 'daily', hour: 22 }, EARLY, 'UTC')).toBe(false);
  });

  it('waits for the weekday too, for a weekly one, Monday unless said otherwise', () => {
    // 2026-09-25 is a Friday.
    expect(weekdayOf('2026-09-25')).toBe(5);
    expect(isDue({ cadence: 'weekly', hour: 8 }, MORNING, DHAKA)).toBe(false);
    expect(isDue({ cadence: 'weekly', hour: 8, weekday: 5 }, MORNING, DHAKA)).toBe(true);
    // Monday the 28th, 08:05 in Dhaka.
    const monday = Date.UTC(2026, 8, 28, 2, 5);
    expect(isDue({ cadence: 'weekly', hour: 8 }, monday, DHAKA)).toBe(true);
  });
});

describe('createDigestSchema', () => {
  it('takes a cadence, one to five addresses, an hour and a weekday', () => {
    expect(createDigestSchema.parse({ cadence: 'daily', to: ['ops@example.test'] })).toEqual({
      cadence: 'daily',
      to: ['ops@example.test'],
      hour: 8,
    });
    expect(createDigestSchema.safeParse({ cadence: 'hourly', to: ['ops@example.test'] }).success).toBe(false);
    expect(createDigestSchema.safeParse({ cadence: 'daily', to: [] }).success).toBe(false);
    expect(createDigestSchema.safeParse({ cadence: 'daily', to: ['not an address'] }).success).toBe(false);
    expect(createDigestSchema.safeParse({ cadence: 'daily', to: ['a@b.co'], hour: 24 }).success).toBe(false);
    expect(
      createDigestSchema.safeParse({ cadence: 'weekly', to: ['a@b.co'], weekday: 7 }).success,
    ).toBe(false);
    expect(
      createDigestSchema.safeParse({
        cadence: 'daily',
        to: ['a@b.co', 'c@d.co', 'e@f.co', 'g@h.co', 'i@j.co', 'k@l.co'],
      }).success,
    ).toBe(false);
  });
});
