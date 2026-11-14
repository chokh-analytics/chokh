import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser } from '@playwright/test';
import { buildApp } from '@chokh/server';
import { createMemoryStore } from '@chokh/server/store/memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExtension } from '../extension.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';
import { startProvider, type TestProvider } from './provider.test-utils.js';

// The sign-in, in a real browser, with the provider and this server on
// different sites.
//
// Everything else about the flow is proved without a browser. What only a
// browser can say is whether the cookie the flow depends on makes the trip:
// it is set on a response from this server, the browser leaves for another
// site, and it has to come back on the redirect that returns. A cookie that
// was SameSite=Strict, or scoped to the wrong path, or dropped for being set
// on a redirect, would pass every injected request and fail here, where a
// person would meet it.
//
// This server is reached as localhost and the provider as 127.0.0.1, which a
// browser treats as two sites. Run by `pnpm --filter @chokh/ee run
// test:browser`, in the CI job that has a browser installed.

const PASSWORD = 'a-password-long-enough';
const OWNER_EMAIL = 'owner@test.example';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let app: FastifyInstance;
let provider: TestProvider;
let browser: Browser;
let origin: string;
let ownerSession: string;
let ownerId: string;
let store: ReturnType<typeof createMemoryStore>;

beforeAll(async () => {
  provider = await startProvider();
  // As a real provider does: a page of its own, and the person presses on.
  provider.page = true;
  const port = await freePort();
  origin = `http://localhost:${port}`;

  const generated = generateKeyPairSync('ed25519');
  const issuedAt = Math.floor(Date.now() / 1000);
  const license: LicensePayload = {
    v: 1,
    id: 'lic_browser',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features: [ALL_FEATURES],
    seats: null,
    sites: null,
    issuedAt,
    expiresAt: issuedAt + 86_400,
  };
  store = createMemoryStore();
  app = await buildApp({
    store,
    extensions: [
      buildExtension(
        {
          raw: signLicense(generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), license),
          publicKeys: [
            publicKeyToBase64(generated.publicKey.export({ format: 'pem', type: 'spki' }).toString()),
          ],
        },
        {
          oidc: {
            issuer: provider.issuer,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            publicUrl: origin,
          },
        },
      ),
    ],
  });
  // By name, so it listens on whichever loopback addresses the machine has:
  // a browser asked for localhost may try the IPv6 one first.
  await app.listen({ port, host: 'localhost' });

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: OWNER_EMAIL, password: PASSWORD },
  });
  ownerSession = registered.cookies[0]?.value ?? '';
  ownerId = (JSON.parse(registered.body) as { data: { user: { id: string } } }).data.user.id;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser.close();
  await app.close();
  await provider.close();
});

describe('signing in through a provider on another site, in a real browser', () => {
  it('connects an account, then signs it in from a browser with nothing in it', async () => {
    // The owner, signed in, connects their account from this dashboard.
    const mine = await browser.newContext();
    await mine.addCookies([{ name: 'chokh_session', value: ownerSession, url: origin }]);
    const page = await mine.newPage();
    const begun = await page.request.post(`${origin}/api/ee/oidc/link`, { data: {} });
    expect(begun.status()).toBe(200);
    const { url } = ((await begun.json()) as { data: { url: string } }).data;
    expect(new URL(url).origin).toBe(provider.issuer);
    await page.goto(url);
    expect(new URL(page.url()).origin).toBe(provider.issuer);
    await page.click('#continue');
    // Back on this server, having been to the provider.
    expect(new URL(page.url()).origin).toBe(origin);
    expect(await store.identitiesForUser(ownerId)).toHaveLength(1);
    await mine.close();

    // Somebody with no session, in a browser of their own.
    const fresh = await browser.newContext();
    const visitor = await fresh.newPage();
    const returns: { site: string | undefined; cookie: string | undefined }[] = [];
    visitor.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/ee/oidc/callback') {
        void request.allHeaders().then((headers) => {
          returns.push({ site: headers['sec-fetch-site'], cookie: headers['cookie'] });
        });
      }
    });
    await visitor.goto(`${origin}/api/ee/oidc/start`);
    // At the provider, on its own site, with its own page on screen.
    expect(new URL(visitor.url()).origin).toBe(provider.issuer);
    await visitor.click('#continue');
    expect(new URL(visitor.url()).origin).toBe(origin);
    expect(new URL(visitor.url()).pathname).toBe('/');

    // The return came from another site, and the flow's cookie came with it.
    expect(returns).toHaveLength(1);
    expect(returns[0]?.site).toBe('cross-site');
    expect(returns[0]?.cookie).toContain('chokh_oidc=');

    // Signed in as the account that connected itself, and the flow's cookie
    // is gone from the browser.
    const me = await visitor.request.get(`${origin}/api/me`);
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { data: { user: { email: string } } }).data.user.email).toBe(OWNER_EMAIL);
    const names = (await fresh.cookies()).map((cookie) => cookie.name);
    expect(names).toContain('chokh_session');
    expect(names).not.toContain('chokh_oidc');
    await fresh.close();
  }, 60_000);

  it('signs in nobody when the return arrives in a browser that did not begin the flow', async () => {
    // One browser begins a flow and is told where to go.
    const first = await browser.newContext();
    const started = await first.request.get(`${origin}/api/ee/oidc/start`, { maxRedirects: 0 });
    expect(started.status()).toBe(302);
    const authorize = started.headers()['location'] ?? '';

    // Another browser is sent there in its place: it comes back with a code
    // and a state that are real, and no cookie of a flow it began.
    const second = await browser.newContext();
    const victim = await second.newPage();
    await victim.goto(authorize);
    await victim.click('#continue');
    const landed = new URL(victim.url());
    expect(landed.origin).toBe(origin);
    expect(`${landed.pathname}${landed.search}`).toBe('/login?sso=OIDC_STATE');
    expect((await victim.request.get(`${origin}/api/me`)).status()).toBe(401);
    expect((await second.cookies()).map((cookie) => cookie.name)).not.toContain('chokh_session');
    await first.close();
    await second.close();
  }, 60_000);
});
