import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, NOW, SITE_ID, type Harness } from './api.test-utils.js';
import { signHs256 } from '../lib/jwt.js';
import { ssoClaimsFor } from '../services/sso.service.js';

// What a log line holds (the review of AN-TEAM01): a request's method, the host
// it was asked of and the route it reached, and nothing else. No query, so no
// SSO token, provider code, `next` or search text; no share token from a path;
// and no address of whoever asked, which on the collector's line is a
// visitor's. Read at the most talkative level, so that nothing hides behind a
// level that happens to be off.

const SECRET = 'test-sso-secret-not-a-real-key-000000';
// The visitor, and the proxy in front of this server. vitest.config.ts trusts
// the loopback, so a request from 127.0.0.1 is one that came through a proxy
// this install believes, and one from anywhere else came with none.
const VISITOR = '198.51.100.73';
const DIRECT_VISITOR = '203.0.113.41';

let harness: Harness;
let logged: string[];

beforeEach(async () => {
  logged = [];
  harness = await createHarness({
    log: { level: 'trace', stream: { write: (line) => void logged.push(line) } },
  });
});

afterEach(async () => {
  await harness.close();
});

// The lines Fastify writes for each request it is asked: the request as the
// serializer gives it.
function requestLines(): { method: string; url: string; host: string }[] {
  return logged
    .map((line) => JSON.parse(line) as { req?: { method: string; url: string; host: string } })
    .flatMap((line) => (line.req === undefined ? [] : [line.req]));
}

// A batch as the tracker sends it, for the test site.
function pageview(path: string) {
  return {
    siteId: SITE_ID,
    sentAt: NOW,
    hostname: 'test.example',
    lang: 'en-US',
    screen: '1920x1080',
    viewport: '1280x720',
    events: [{ type: 'pageview', ts: NOW, path, title: 'Pricing', referrer: 'https://mail.example/?ref=mail' }],
  };
}

const TRACKER = {
  'content-type': 'text/plain;charset=UTF-8',
  origin: 'https://test.example',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

describe('a log line', () => {
  it('holds no SSO token and no next, by either form of the exchange', async () => {
    const token = signHs256(
      SECRET,
      ssoClaimsFor({ sub: 'staff_7', email: 'staff@progsity.test', teamId: 't_test', role: 'viewer', now: NOW, lifetimeSeconds: 300 }),
    );
    const spent = signHs256(
      SECRET,
      ssoClaimsFor({ sub: 'staff_8', email: 'other@progsity.test', teamId: 't_test', role: 'viewer', now: NOW, lifetimeSeconds: 300 }),
    );
    const arrived = await harness.app.inject({
      method: 'GET',
      url: `/api/sso?token=${token}&next=${encodeURIComponent('/s_test/people?q=ana+bose')}`,
    });
    expect(arrived.statusCode).toBe(303);
    await harness.app.inject({ method: 'POST', url: '/api/sso', payload: { token: spent } });

    expect(requestLines()).toContainEqual({ method: 'GET', url: '/api/sso', host: 'localhost:80' });
    expect(requestLines()).toContainEqual({ method: 'POST', url: '/api/sso', host: 'localhost:80' });
    const written = logged.join('\n');
    for (const kept of [token, spent, token.split('.')[2] ?? 'x', 'next=', 'token=', 'ana', 'people']) {
      expect(written).not.toContain(kept);
    }
  });

  it('holds no search text from a report and keeps the site the request was about', async () => {
    await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/people?q=${encodeURIComponent('ana@example.com')}`,
      headers: { cookie: harness.owner.cookie },
    });
    expect(requestLines()).toContainEqual({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/people`,
      host: 'localhost:80',
    });
    expect(logged.join('\n')).not.toContain('ana');
  });

  it("holds no share token, from the API's path or the dashboard page's", async () => {
    const token = 'shr_aVeryPrivateShareToken0123456789';
    await harness.app.inject({ method: 'GET', url: `/api/share/${token}` });
    await harness.app.inject({ method: 'GET', url: `/api/share/${token}/stats/aggregate?period=30d` });
    await harness.app.inject({ method: 'GET', url: `/share/${token}/embed`, headers: { accept: 'text/html' } });

    const urls = requestLines().map((line) => line.url);
    expect(urls).toContain('/api/share/:token');
    expect(urls).toContain('/api/share/:token/stats/aggregate');
    expect(urls).toContain('/share/:token/embed');
    expect(logged.join('\n')).not.toContain('aVeryPrivate');
  });

  // The collector's line, at the default level and every other. Behind a
  // proxy this install trusts, the framework's own line wrote the forwarded
  // address; with no proxy, the socket's peer. Either is the visitor.
  it("holds no visitor's address on the collector's line, behind a proxy and without one", async () => {
    const proxied = await harness.app.inject({
      method: 'POST',
      url: '/api/collect',
      headers: { ...TRACKER, 'x-forwarded-for': VISITOR },
      payload: JSON.stringify(pageview('/pricing')),
    });
    const direct = await harness.app.inject({
      method: 'POST',
      url: '/api/collect',
      remoteAddress: DIRECT_VISITOR,
      headers: TRACKER,
      payload: JSON.stringify(pageview('/')),
    });
    expect(proxied.statusCode).toBeLessThan(300);
    expect(direct.statusCode).toBeLessThan(300);

    expect(requestLines().filter((line) => line.url === '/api/collect')).toHaveLength(2);
    const written = logged.join('\n');
    for (const kept of [VISITOR, DIRECT_VISITOR, '127.0.0.1', 'remoteAddress', 'remotePort', 'ref=mail']) {
      expect(written).not.toContain(kept);
    }
  });
});
