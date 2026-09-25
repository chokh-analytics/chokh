import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type ServerExtension } from '@chokh/server';
import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings } from '@chokh/server/store';
import { digestIdFor, type Digest } from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Deliverer, Mail } from '../alerts/deliver.js';
import type { DeliveryEnv } from '../license/env.js';
import { buildExtension } from '../extension.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';

// The digest routes (AN-RPT01) over HTTP: gated by their own feature, read by
// anybody who reads the site, added and sent by an owner, refused on an
// install that cannot mail, and one per cadence.

const SITE_ID = 's_test';
const TEAM_ID = 'default';
const OWNER = { email: 'owner@test.example', password: 'a-password-long-enough' };
const VIEWER = { email: 'viewer@test.example', password: 'a-password-long-enough' };
const DAY = 86_400;

function pair(): { privateKey: string; publicKey: string } {
  const generated = generateKeyPairSync('ed25519');
  return {
    privateKey: generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKeyToBase64(
      generated.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    ),
  };
}

function payload(features: string[] = [ALL_FEATURES]): LicensePayload {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    id: 'lic_test',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features,
    seats: null,
    sites: null,
    issuedAt,
    expiresAt: issuedAt + 365 * DAY,
  };
}

interface Sent {
  to: string;
  mail: Mail;
}

function fakeDeliverer(): Deliverer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    available: ['email', 'webhook'],
    sent,
    send: () => Promise.reject(new Error('not a channel test')),
    sendMail(to, mail) {
      sent.push({ to, mail });
      return Promise.resolve(to.startsWith('bounce') ? 'Mailbox unavailable' : null);
    },
  };
}

const MAIL_ENV: DeliveryEnv = {
  smtpUrl: undefined,
  brevoApiKey: 'xkeysib-test',
  mailFrom: 'chokh@test.example',
  telegramBotToken: undefined,
  publicUrl: 'https://analytics.test.example',
};

const NO_MAIL_ENV: DeliveryEnv = {
  smtpUrl: undefined,
  brevoApiKey: undefined,
  mailFrom: undefined,
  telegramBotToken: undefined,
  publicUrl: undefined,
};

interface Install {
  app: FastifyInstance;
  owner: string;
  viewer: string;
  deliverer: ReturnType<typeof fakeDeliverer>;
  close(): Promise<void>;
}

async function install(extension: (deliverer: Deliverer) => ServerExtension): Promise<Install> {
  const store = createMemoryStore();
  const deliverer = fakeDeliverer();
  const app = await buildApp({ store, extensions: [extension(deliverer)] });
  await app.ready();

  const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }): string =>
    `${response.cookies[0]?.name}=${response.cookies[0]?.value}`;
  const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: OWNER });
  const owner = cookieOf(registered);
  await store.createSite({
    id: SITE_ID,
    name: 'Test site',
    domains: ['test.example'],
    teamId: TEAM_ID,
    settings: defaultSiteSettings({ timezone: 'Asia/Dhaka' }),
  });
  const added = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: VIEWER,
    headers: { cookie: owner },
  });
  const viewerId = (JSON.parse(added.body) as { data: { user: { id: string } } }).data.user.id;
  await store.setTeamMember(TEAM_ID, { userId: viewerId, role: 'viewer', identity: false });
  const signedIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: VIEWER });
  const viewer = cookieOf(signedIn);
  return { app, owner, viewer, deliverer, close: () => app.close() };
}

function body<T>(response: { body: string }): {
  success: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
} {
  return JSON.parse(response.body) as never;
}

const digests = `/api/sites/${SITE_ID}/ee/digests`;

describe('the digest routes on an install with no key', () => {
  let here: Install;

  beforeAll(async () => {
    here = await install((deliver) =>
      buildExtension({ raw: undefined, publicKeys: [] }, { deliver, delivery: MAIL_ENV }),
    );
  });

  afterAll(async () => {
    await here.close();
  });

  it('answers 403 LICENSE_REQUIRED naming the feature, once the scope is proved', async () => {
    const response = await here.app.inject({ method: 'GET', url: digests, headers: { cookie: here.owner } });
    expect(response.statusCode).toBe(403);
    expect(body(response).error).toMatchObject({
      code: 'LICENSE_REQUIRED',
      details: { feature: 'digests', reason: 'missing' },
    });
    const nobody = await here.app.inject({ method: 'GET', url: digests });
    expect(body(nobody).error?.code).toBe('UNAUTHENTICATED');
  });
});

describe('the digest routes on a licensed install', () => {
  let here: Install;

  beforeAll(async () => {
    const keys = pair();
    here = await install((deliver) =>
      buildExtension(
        { raw: signLicense(keys.privateKey, payload()), publicKeys: [keys.publicKey] },
        { deliver, delivery: MAIL_ENV },
      ),
    );
  });

  afterAll(async () => {
    await here.close();
  });

  it('lists nothing at first, and says this install can mail', async () => {
    const response = await here.app.inject({ method: 'GET', url: digests, headers: { cookie: here.viewer } });
    expect(response.statusCode).toBe(200);
    expect(body(response).data).toEqual({ digests: [] });
    expect(body(response).meta).toMatchObject({ siteId: SITE_ID, maxRecipients: 5, mail: true, needs: [] });
  });

  it('adds a digest for an owner and not for a viewer, one per cadence', async () => {
    const refused = await here.app.inject({
      method: 'POST',
      url: digests,
      headers: { cookie: here.viewer },
      payload: { cadence: 'daily', to: ['ops@test.example'] },
    });
    expect(refused.statusCode).toBe(403);
    expect(body(refused).error?.code).toBe('SCOPE_REQUIRED');

    const made = await here.app.inject({
      method: 'POST',
      url: digests,
      headers: { cookie: here.owner },
      payload: { cadence: 'daily', to: ['ops@test.example', 'bounce@test.example'] },
    });
    expect(made.statusCode).toBe(201);
    const digest = body<{ digest: Digest }>(made).data?.digest;
    expect(digest).toMatchObject({
      siteId: SITE_ID,
      id: digestIdFor(SITE_ID, 'daily'),
      cadence: 'daily',
      to: ['ops@test.example', 'bounce@test.example'],
      hour: 8,
    });

    const again = await here.app.inject({
      method: 'POST',
      url: digests,
      headers: { cookie: here.owner },
      payload: { cadence: 'daily', to: ['other@test.example'], hour: 9 },
    });
    expect(again.statusCode).toBe(409);
    expect(body(again).error).toMatchObject({
      code: 'DIGEST_EXISTS',
      details: { digestId: digestIdFor(SITE_ID, 'daily') },
    });

    const invalid = await here.app.inject({
      method: 'POST',
      url: digests,
      headers: { cookie: here.owner },
      payload: { cadence: 'weekly', to: ['not an address'] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(body(invalid).error?.code).toBe('INVALID_DIGEST');
  });

  it('sends the last complete period now, one mail per address, and writes down each outcome', async () => {
    const sent = await here.app.inject({
      method: 'POST',
      url: `${digests}/${digestIdFor(SITE_ID, 'daily')}/send`,
      headers: { cookie: here.owner },
    });
    expect(sent.statusCode).toBe(200);
    const answer = body<{ deliveries: unknown[]; period: string }>(sent).data;
    expect(answer?.period).toMatch(/^d:\d{4}-\d{2}-\d{2}$/);
    expect(answer?.deliveries).toEqual([
      { channel: 'email', target: 'ops@test.example', ok: true },
      { channel: 'email', target: 'bounce@test.example', ok: false, error: 'Mailbox unavailable' },
    ]);
    expect(here.deliverer.sent).toHaveLength(2);
    expect(here.deliverer.sent[0]?.mail.subject).toMatch(/^Chokh: Test site on /);
    expect(here.deliverer.sent[0]?.mail.attachments?.[0]?.type).toBe('application/pdf');
    expect(here.deliverer.sent[0]?.mail.text).toContain('https://analytics.test.example/s_test');

    const listed = await here.app.inject({ method: 'GET', url: digests, headers: { cookie: here.viewer } });
    const rows = body<{ digests: Digest[] }>(listed).data?.digests ?? [];
    expect(rows[0]?.last?.deliveries).toHaveLength(2);
    // A send now does not claim the period: the scheduled one still goes.
    expect(rows[0]?.lastPeriod).toBeUndefined();

    const missing = await here.app.inject({
      method: 'POST',
      url: `${digests}/dg_nobody/send`,
      headers: { cookie: here.owner },
    });
    expect(missing.statusCode).toBe(404);
    expect(body(missing).error?.code).toBe('DIGEST_NOT_FOUND');
  });

  it('deletes a digest, and says so once', async () => {
    const id = digestIdFor(SITE_ID, 'daily');
    const removed = await here.app.inject({
      method: 'DELETE',
      url: `${digests}/${id}`,
      headers: { cookie: here.owner },
    });
    expect(removed.statusCode).toBe(200);
    expect(body<{ deleted: boolean }>(removed).data?.deleted).toBe(true);
    const again = await here.app.inject({
      method: 'DELETE',
      url: `${digests}/${id}`,
      headers: { cookie: here.owner },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('the digest routes on an install that cannot mail', () => {
  let here: Install;

  beforeAll(async () => {
    const keys = pair();
    here = await install((deliver) =>
      buildExtension(
        { raw: signLicense(keys.privateKey, payload()), publicKeys: [keys.publicKey] },
        { deliver, delivery: NO_MAIL_ENV },
      ),
    );
  });

  afterAll(async () => {
    await here.close();
  });

  it('says what it lacks in the list, and refuses a digest naming the variable', async () => {
    const listed = await here.app.inject({ method: 'GET', url: digests, headers: { cookie: here.owner } });
    expect(body(listed).meta).toMatchObject({
      mail: false,
      needs: ['CHOKH_SMTP_URL or CHOKH_BREVO_API_KEY', 'CHOKH_MAIL_FROM'],
    });
    const made = await here.app.inject({
      method: 'POST',
      url: digests,
      headers: { cookie: here.owner },
      payload: { cadence: 'daily', to: ['ops@test.example'] },
    });
    expect(made.statusCode).toBe(400);
    expect(body(made).error).toMatchObject({
      code: 'CHANNEL_UNAVAILABLE',
      details: { channel: 'email', variable: 'CHOKH_SMTP_URL or CHOKH_BREVO_API_KEY and CHOKH_MAIL_FROM' },
    });
  });
});

describe('a key that names alerts alone', () => {
  it('does not carry digests', async () => {
    const keys = pair();
    const here = await install((deliver) =>
      buildExtension(
        { raw: signLicense(keys.privateKey, payload(['alerts'])), publicKeys: [keys.publicKey] },
        { deliver, delivery: MAIL_ENV },
      ),
    );
    const response = await here.app.inject({ method: 'GET', url: digests, headers: { cookie: here.owner } });
    expect(response.statusCode).toBe(403);
    expect(body(response).error?.details).toMatchObject({ feature: 'digests', reason: 'not_licensed' });
    await here.close();
  });
});
