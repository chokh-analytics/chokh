import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings, goalIdFor, type StoredEvent } from '@chokh/store';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  change,
  composeDigest,
  digestHtml,
  digestMail,
  digestText,
  duration,
  headline,
  subjectFor,
  type DigestReport,
} from './compose.js';
import { renderDigestPdf } from './pdf.js';
import { periodFor } from './period.js';

// What a digest says (AN-RPT01): composed from the store the way the
// Overview reads it, against the period before, and written three ways
// that agree.

const SITE_ID = 's_digest';
const DHAKA = 'Asia/Dhaka';
// 2026-09-25 08:05 in Dhaka; yesterday is the 24th, from 18:00 UTC on the
// 23rd to 18:00 UTC on the 24th.
const NOW = Date.UTC(2026, 8, 25, 2, 5);
const YESTERDAY = Date.UTC(2026, 8, 23, 18);
const BEFORE = Date.UTC(2026, 8, 22, 18);
const HOUR = 3_600_000;

function pageview(visitorId: string, path: string, ts: number, over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE_ID,
    ts,
    receivedAt: ts,
    type: 'pageview',
    visitorId,
    path,
    hostname: 'digest.example',
    bot: false,
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    lang: 'en',
    // A search engine's referrer files the visit under organic; none is direct.
    referrer: 'https://www.google.com/',
    ...over,
  };
}

function inflateStreams(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const text = raw.toString('latin1');
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf('stream\n', at);
    if (start === -1) break;
    const end = text.indexOf('endstream', start);
    if (end === -1) break;
    const body = raw.subarray(start + 'stream\n'.length, end);
    try {
      parts.push(inflateSync(body).toString('latin1'));
    } catch {
      parts.push(body.toString('latin1'));
    }
    at = end + 'endstream'.length;
  }
  return parts.join('\n');
}

describe('composeDigest', () => {
  let report: DigestReport;

  beforeAll(async () => {
    const store = createMemoryStore([], { now: () => NOW });
    const site = {
      id: SITE_ID,
      name: 'Progsity',
      domains: ['digest.example'],
      settings: defaultSiteSettings({ timezone: DHAKA }),
    };
    await store.createSite(site);
    await store.createGoal({
      siteId: SITE_ID,
      id: goalIdFor(SITE_ID, 'event', 'signup'),
      name: 'Signed up',
      kind: 'event',
      match: 'signup',
      createdBy: 'u_1',
      createdAt: NOW - 30 * 24 * HOUR,
    });
    await store.ingest([
      // Yesterday: three people, one signs up.
      pageview('v_1', '/pricing', YESTERDAY + 9 * HOUR),
      pageview('v_1', '/', YESTERDAY + 9 * HOUR + 60_000),
      pageview('v_1', '/pricing', YESTERDAY + 9 * HOUR + 120_000, {
        type: 'event',
        name: 'signup',
      }),
      pageview('v_2', '/pricing', YESTERDAY + 14 * HOUR, { referrer: undefined }),
      pageview('v_3', '/blog', YESTERDAY + 20 * HOUR, { geo: { country: 'IN', city: 'Kolkata' } }),
      // The day before: one person.
      pageview('v_9', '/', BEFORE + 10 * HOUR),
    ]);
    // Yesterday and the day before are history, read from their rollups the
    // way production reads them.
    await store.rollupDay(SITE_ID, '2026-09-23');
    await store.rollupDay(SITE_ID, '2026-09-24');
    await store.createAnnotation({
      siteId: SITE_ID,
      id: 'an_deploy',
      at: YESTERDAY + 8 * HOUR,
      kind: 'deploy',
      text: 'backend abc123',
      createdBy: 'u_1',
      createdAt: YESTERDAY + 8 * HOUR,
    });
    report = await composeDigest(store, site, { cadence: 'daily' }, periodFor('daily', NOW, DHAKA));
  });

  it('reads yesterday against the day before, with the shape, the lists, the goals and the marks', () => {
    expect(report.period.key).toBe('d:2026-09-24');
    expect(report.metrics.visitors).toBe(3);
    expect(report.metrics.pageviews).toBe(4);
    expect(report.previous?.visitors).toBe(1);
    expect(report.series).toHaveLength(24);
    expect(report.series.reduce((sum, point) => sum + point.metrics.pageviews, 0)).toBe(4);
    expect(report.pages.map((row) => row.key)).toEqual(['/pricing', '/', '/blog']);
    expect(report.channels.map((row) => row.key)).toEqual(['organic', 'direct']);
    expect(report.countries.map((row) => row.key)).toEqual(['BD', 'IN']);
    expect(report.goals).toEqual([
      { name: 'Signed up', conversion: expect.objectContaining({ visitors: 1, completions: 1 }) },
    ]);
    expect(report.annotations.map((mark) => mark.text)).toEqual(['backend abc123']);
  });

  it('writes the same numbers as text, as HTML and as a subject', () => {
    expect(subjectFor(report)).toBe('Chokh: Progsity on 2026-09-24');
    const lines = headline(report);
    expect(lines[0]).toEqual({ label: 'Visitors', value: '3', change: '+200%' });
    const text = digestText(report, 'https://analytics.example.test/s_digest');
    expect(text).toContain('Progsity, 2026-09-24 (against the period before)');
    expect(text).toContain('Visitors     3  (+200%)');
    expect(text).toContain('/pricing');
    expect(text).toContain('Organic search');
    expect(text).toContain('Signed up');
    expect(text).toContain('deploy');
    expect(text).toContain('Open the dashboard: https://analytics.example.test/s_digest');
    const html = digestHtml(report, null);
    expect(html).toContain('<strong>3</strong>');
    expect(html).toContain('Organic search');
    expect(html).not.toContain('Open the dashboard');
  });

  it('draws one page that says what the text says, and mails it as the attachment', async () => {
    const pdf = await renderDigestPdf(report);
    const bytes = Buffer.from(pdf).toString('latin1');
    expect(bytes.startsWith('%PDF-')).toBe(true);
    // pdf-lib deflates the page's content stream and writes a standard
    // font's text in it as hex strings, so the words are read back by
    // inflating every stream and looking for each word's bytes in hex.
    const inflated = inflateStreams(pdf).toUpperCase();
    const hex = (word: string): string => Buffer.from(word, 'latin1').toString('hex').toUpperCase();
    for (const word of ['Progsity', 'Visitors', 'THE NUMBERS', 'TOP PAGES', '/pricing', 'Signed up', 'GOALS']) {
      expect(inflated, word).toContain(hex(word));
    }
    const mail = await digestMail(report, undefined);
    expect(mail.subject).toBe('Chokh: Progsity on 2026-09-24');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments?.[0]?.name).toBe('s_digest-daily-2026-09-24.pdf');
    expect(mail.attachments?.[0]?.type).toBe('application/pdf');
    expect(mail.html).toContain('Progsity');
  });
});

describe('the words', () => {
  it('say a change as a percentage, and nothing against nothing', () => {
    expect(change(150, 100)).toBe('+50%');
    expect(change(50, 100)).toBe('-50%');
    expect(change(100, 100)).toBe('no change');
    expect(change(3, 0)).toBe('new');
    expect(change(0, 0)).toBe('no change');
    expect(change(null, 100)).toBe('n/a');
    expect(change(100, null)).toBe('n/a');
    expect(duration(null)).toBe('n/a');
    expect(duration(59_000)).toBe('59s');
    expect(duration(140_000)).toBe('2m 20s');
  });
});
