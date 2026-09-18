import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  type Harness,
} from './api.test-utils.js';
import type { AuditRecord, RealtimeSnapshot, StoredEvent } from '../store/AnalyticsStore.js';

// Who is here now: the snapshot, and the stream.
//
// The stream needs a real socket, so those cases listen on a port rather than using
// inject: an SSE response stays open for as long as the dashboard does, and inject
// buffers a response until it ends.

// The SSE framing, named rather than written inline.
const FRAME_END = '\n\n';
const LINE_END = '\n';
const DATA = 'data: ';

function live(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    siteId: SITE_ID,
    ts: NOW - 5000,
    receivedAt: NOW - 5000,
    type: 'pageview',
    visitorId: 'v_1',
    path: '/pricing',
    hostname: 'test.example',
    bot: false,
    ip: '203.0.113.7',
    ua: { browser: 'Chrome', os: 'Windows', device: 'desktop' },
    geo: { country: 'BD', city: 'Dhaka' },
    ...overrides,
  };
}

describe('GET /api/sites/:siteId/realtime', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    await harness.store.ingest([live(), live({ visitorId: 'v_2', userId: 'u_42' })]);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('counts who is online and says where they are', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/realtime`,
      headers: { cookie: harness.owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const snapshot = envelope<RealtimeSnapshot>(response.body).data;
    expect(snapshot?.online).toBe(2);
    expect(snapshot?.signedIn).toBe(1);
    expect(snapshot?.anonymous).toBe(1);
    expect(snapshot?.byPage).toEqual([{ key: '/pricing', visitors: 2 }]);
    expect(snapshot?.byCountry).toEqual([{ key: 'BD', visitors: 2 }]);
    expect(snapshot?.visitors[0]?.ip).toBe('203.0.113.7');
  });

  // The founder's ruling on the two halves of the artifact: the list stays, the
  // address and the name go. Section 7.2 gates the IP column, not the list.
  it('keeps the live list for a viewer with the address and the name removed', async () => {
    const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/realtime`,
      headers: { cookie: viewer.cookie },
    });
    const parsed = envelope<RealtimeSnapshot>(response.body);
    expect(parsed.data?.online).toBe(2);
    expect(parsed.data?.visitors).toHaveLength(2);
    expect(parsed.data?.visitors[0]?.path).toBe('/pricing');
    expect(parsed.data?.visitors[0]?.city).toBe('Dhaka');
    expect(response.body).not.toContain('203.0.113.7');
    expect(response.body).not.toContain('u_42');
    expect(parsed.meta).toMatchObject({ identity: false });
  });

  it('writes one audit row for a read that carried an address', async () => {
    await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/realtime`,
      headers: { cookie: harness.owner.cookie },
    });
    const rows: AuditRecord[] = await harness.store.auditTrail(SITE_ID, 0, NOW + 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: 'GET /api/sites/:siteId/realtime',
      fields: ['ip', 'userId'],
    });
    expect(rows[0]?.target).toBeUndefined();
  });

  it('counts nobody who stopped sending a minute ago', async () => {
    const quiet = await createHarness();
    await quiet.store.ingest([live({ ts: NOW - 120_000, receivedAt: NOW - 120_000 })]);
    const response = await quiet.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/realtime`,
      headers: { cookie: quiet.owner.cookie },
    });
    expect(envelope<RealtimeSnapshot>(response.body).data?.online).toBe(0);
    await quiet.close();
  });
});

interface Stream {
  next(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

describe('GET /api/sites/:siteId/realtime/stream', () => {
  let harness: Harness;
  let origin: string;
  let opened: Stream[];

  beforeEach(async () => {
    harness = await createHarness();
    opened = [];
    origin = await harness.app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    // Every stream, whether the case remembered or not: Fastify will not close
    // while a connection that is not idle is open, and an SSE one never is.
    await Promise.all(opened.splice(0).map((stream) => stream.close()));
    await harness.close();
  });

  // One frame per read, so a case can say "the next thing the dashboard saw".
  function reading(body: ReadableStream<Uint8Array>): Stream {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const stream: Stream = {
      async next(): Promise<Record<string, unknown>> {
        for (;;) {
          const at = buffered.indexOf(FRAME_END);
          if (at !== -1) {
            const raw = buffered.slice(0, at);
            buffered = buffered.slice(at + FRAME_END.length);
            // A keepalive comment is not a frame.
            if (!raw.startsWith(':')) {
              const line = raw.split(LINE_END).find((candidate) => candidate.startsWith(DATA));
              if (line !== undefined) {
                return JSON.parse(line.slice(DATA.length)) as Record<string, unknown>;
              }
            }
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error('the stream ended');
          }
          buffered += decoder.decode(chunk.value, { stream: true });
        }
      },
      close: async () => {
        await reader.cancel();
      },
    };
    opened.push(stream);
    return stream;
  }

  async function open(
    headers: Record<string, string>,
  ): Promise<{ response: Response; stream: Stream }> {
    const response = await fetch(`${origin}/api/sites/${SITE_ID}/realtime/stream`, { headers });
    return { response, stream: reading(response.body as ReadableStream<Uint8Array>) };
  }

  // A batch the way the tracker posts one: JSON under text/plain, because a beacon
  // cannot be preflighted.
  function collect(path: string): Promise<Response> {
    return fetch(`${origin}/api/collect`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://test.example' },
      body: JSON.stringify({
        siteId: SITE_ID,
        sentAt: Date.now(),
        hostname: 'test.example',
        events: [{ type: 'pageview', ts: Date.now(), path }],
      }),
    });
  }

  it('opens with the state of the world, so a page is not blank until somebody arrives', async () => {
    await harness.store.ingest([live()]);
    const { response, stream } = await open({ cookie: harness.owner.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    // Nginx buffers a proxied response by default, which for a stream means nothing
    // arrives until it decides it has enough.
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const first = (await stream.next()) as { success: boolean; data: RealtimeSnapshot };
    // Each frame's data is the success envelope, so a client parses a frame the way
    // it parses a poll.
    expect(first.success).toBe(true);
    expect(first.data.online).toBe(1);
    await stream.close();
  });

  // The ticket's verify line: a frame observed within one second of ingest.
  it('delivers a frame within a second of a batch reaching the collector', async () => {
    const { stream } = await open({ cookie: harness.owner.cookie });
    await stream.next();

    const started = Date.now();
    expect((await collect('/live')).status).toBe(202);

    const frame = (await stream.next()) as { success: boolean; data: RealtimeSnapshot };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(frame.success).toBe(true);
    expect(frame.data.byPage.map((row) => row.key)).toContain('/live');
    await stream.close();
  });

  // A frame a second would make the audit log a metronome and bury the reads
  // somebody actually wants to find.
  it('writes one audit row when the stream opens and not one per frame', async () => {
    const { stream } = await open({ cookie: harness.owner.cookie });
    await stream.next();
    await collect('/live');
    await stream.next();

    const rows = await harness.store.auditTrail(SITE_ID, 0, Date.now() + 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: 'GET /api/sites/:siteId/realtime/stream',
      fields: ['ip', 'userId'],
    });
    await stream.close();
  });

  it('strips the address for a viewer and writes no row at all', async () => {
    const viewer = await harness.account({ email: 'viewer@test.example', role: 'viewer' });
    await harness.store.ingest([live()]);
    const { stream } = await open({ cookie: viewer.cookie });
    const first = (await stream.next()) as { data: RealtimeSnapshot };

    expect(first.data.online).toBe(1);
    expect(first.data.visitors[0]).not.toHaveProperty('ip');
    expect(await harness.store.auditTrail(SITE_ID, 0, Date.now() + 60_000)).toEqual([]);
    await stream.close();
  });

  it('refuses nobody with the envelope rather than opening a stream', async () => {
    const response = await fetch(`${origin}/api/sites/${SITE_ID}/realtime/stream`);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expectFailure(
      { statusCode: response.status, body: await response.text() },
      401,
      'UNAUTHENTICATED',
    );
  });

  // The one thing between a long lived server and a listener leak.
  it('stops listening for nudges when the dashboard goes away', async () => {
    const { stream } = await open({ cookie: harness.owner.cookie });
    await stream.next();
    await stream.close();

    // A tick for the close handler, then a nudge has to reach nobody rather than
    // writing to a socket that has gone.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(harness.bus.publish(SITE_ID)).resolves.toBeUndefined();
  });
});
