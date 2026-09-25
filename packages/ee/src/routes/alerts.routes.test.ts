import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type ServerExtension } from '@chokh/server';
import { createMemoryStore } from '@chokh/server/store/memory';
import { defaultSiteSettings } from '@chokh/server/store';
import { alertIdFor, goalIdFor, type Alert, type AlertChannel, type AlertDelivery } from '@chokh/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALERTS_FEATURE } from '../alerts/conditions.js';
import type { Deliverer } from '../alerts/deliver.js';
import type { AlertMessage } from '../alerts/messages.js';
import { buildExtension } from '../extension.js';
import { ALL_FEATURES, type LicensePayload } from '../license/payload.js';
import { publicKeyToBase64, signLicense } from '../license/token.js';

// The alert routes over HTTP, against the real server: who may keep an alert,
// what one may hold, which channels this install refuses, and what the test
// route answers. Delivery is a fake that remembers; nothing here opens a
// socket.

const SITE_ID = 's_test';
const TEAM_ID = 'default';
const OWNER = { email: 'owner@test.example', password: 'a-password-long-enough' };
const VIEWER = { email: 'viewer@test.example', password: 'a-password-long-enough' };
const DAY = 86_400;
const SIGNUP = goalIdFor(SITE_ID, 'event', 'signup');

const DROP = { kind: 'traffic', metric: 'visitors', direction: 'down', percent: 50, minimum: 20 } as const;
const HOOK: AlertChannel = { kind: 'webhook', url: 'https://hooks.example.test/chokh' };

function pair(): { privateKey: string; publicKey: string } {
  const generated = generateKeyPairSync('ed25519');
  return {
    privateKey: generated.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKeyToBase64(
      generated.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    ),
  };
}

function payload(): LicensePayload {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    id: 'lic_test',
    licensee: 'A Test Company Ltd.',
    plan: 'pro',
    features: [ALL_FEATURES],
    seats: null,
    sites: null,
    issuedAt,
    expiresAt: issuedAt + 365 * DAY,
  };
}

interface Sent {
  channel: AlertChannel;
  message: AlertMessage;
}

function fakeDeliverer(): Deliverer & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    // No SMTP on this install: email is refused at create time.
    available: ['telegram', 'webhook'],
    sent,
    sendMail: () => Promise.resolve('no mail in this test'),
    send(channel, message) {
      sent.push({ channel, message });
      const outcome: AlertDelivery =
        channel.kind === 'telegram'
          ? { channel: 'telegram', target: 'chat', ok: false, error: 'Bad Request: chat not found' }
          : { channel: 'webhook', target: 'hooks.example.test', ok: true };
      return Promise.resolve(outcome);
    },
  };
}

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
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: OWNER,
  });
  const owner = cookieOf(registered);
  await store.createSite({
    id: SITE_ID,
    name: 'Test site',
    domains: ['test.example'],
    teamId: TEAM_ID,
    settings: defaultSiteSettings({ timezone: 'UTC' }),
  });
  await store.createGoal({
    siteId: SITE_ID,
    id: SIGNUP,
    name: 'Signed up',
    kind: 'event',
    match: 'signup',
    createdBy: 'u_1',
    createdAt: Date.now(),
  });

  // A second account, added by the owner, given a viewer's seat.
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

function body<T>(response: { body: string }): { success: boolean; data?: T; meta?: Record<string, unknown>; error?: { code: string; details?: unknown } } {
  return JSON.parse(response.body) as never;
}

const alerts = `/api/sites/${SITE_ID}/ee/alerts`;

describe('the alert routes on an install with no key', () => {
  let here: Install;

  beforeAll(async () => {
    here = await install((deliver) => buildExtension({ raw: undefined, publicKeys: [] }, { deliver }));
  });

  afterAll(async () => {
    await here.close();
  });

  it('answers 403 LICENSE_REQUIRED naming the feature, once the scope is proved', async () => {
    const response = await here.app.inject({ method: 'GET', url: alerts, headers: { cookie: here.owner } });
    expect(response.statusCode).toBe(403);
    expect(body(response).error).toEqual({
      code: 'LICENSE_REQUIRED',
      message: 'This install has no licence key, so this feature is not enabled',
      details: { feature: ALERTS_FEATURE, reason: 'missing' },
    });

    // No session: refused for that, and never told what lives here.
    const stranger = await here.app.inject({ method: 'GET', url: alerts });
    expect(stranger.statusCode).toBe(401);
    expect(stranger.body).not.toContain('LICENSE_REQUIRED');
    expect(stranger.body).not.toContain(ALERTS_FEATURE);
  });
});

describe('the alert routes on a licensed install', () => {
  let here: Install;
  const issuer = pair();

  beforeAll(async () => {
    here = await install((deliver) =>
      buildExtension(
        { raw: signLicense(issuer.privateKey, payload()), publicKeys: [issuer.publicKey] },
        {
          deliver,
          delivery: {
            smtpUrl: undefined,
            brevoApiKey: undefined,
            mailFrom: undefined,
            telegramBotToken: 'x',
            publicUrl: 'https://analytics.example.test',
          },
        },
      ),
    );
  });

  afterAll(async () => {
    await here.close();
  });

  it('lists nothing yet, and says which channels this install can send on', async () => {
    const response = await here.app.inject({ method: 'GET', url: alerts, headers: { cookie: here.viewer } });
    expect(response.statusCode).toBe(200);
    const parsed = body<{ alerts: Alert[] }>(response);
    expect(parsed.data).toEqual({ alerts: [] });
    expect(parsed.meta).toEqual({ siteId: SITE_ID, max: 20, channels: ['telegram', 'webhook'] });
  });

  it('adds an alert for an owner, with an id derived from the question', async () => {
    const response = await here.app.inject({
      method: 'POST',
      url: alerts,
      headers: { cookie: here.owner },
      payload: { name: 'Big drop', condition: DROP, channels: [HOOK, { kind: 'telegram', chatId: '-100123' }] },
    });
    expect(response.statusCode).toBe(201);
    const alert = body<{ alert: Alert }>(response).data?.alert;
    expect(alert).toMatchObject({
      siteId: SITE_ID,
      id: alertIdFor(SITE_ID, DROP),
      name: 'Big drop',
      condition: DROP,
      channels: [HOOK, { kind: 'telegram', chatId: '-100123' }],
      state: { firing: false },
      recent: [],
    });

    const listed = await here.app.inject({ method: 'GET', url: alerts, headers: { cookie: here.viewer } });
    const rows = body<{ alerts: Array<Alert & { watches: string }> }>(listed).data?.alerts ?? [];
    expect(rows.map((row) => row.name)).toEqual(['Big drop']);
    expect(rows[0]?.watches).toBe(
      'Visitors fall 50% against the usual for the hour, once either side reaches 20',
    );
  });

  it('refuses the same question asked again under another name, naming the alert', async () => {
    const response = await here.app.inject({
      method: 'POST',
      url: alerts,
      headers: { cookie: here.owner },
      payload: { name: 'Another name', condition: { ...DROP }, channels: [HOOK] },
    });
    expect(response.statusCode).toBe(409);
    expect(body(response).error).toMatchObject({ code: 'ALERT_EXISTS', details: { alertId: alertIdFor(SITE_ID, DROP) } });
  });

  it('refuses a channel this install cannot send on, naming the variable', async () => {
    const response = await here.app.inject({
      method: 'POST',
      url: alerts,
      headers: { cookie: here.owner },
      payload: { name: 'Mail me', condition: { kind: 'silence', minutes: 30 }, channels: [{ kind: 'email', to: 'ops@example.test' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(body(response).error).toEqual({
      code: 'CHANNEL_UNAVAILABLE',
      message: 'This install cannot send email: set CHOKH_SMTP_URL or CHOKH_BREVO_API_KEY and CHOKH_MAIL_FROM',
      details: { channel: 'email', variable: 'CHOKH_SMTP_URL or CHOKH_BREVO_API_KEY and CHOKH_MAIL_FROM' },
    });
  });

  it('names the goal an alert watches, and refuses a goal that is not there', async () => {
    const known = await here.app.inject({
      method: 'POST',
      url: alerts,
      headers: { cookie: here.owner },
      payload: { name: 'No signups', condition: { kind: 'goal', goalId: SIGNUP, direction: 'below', count: 1, window: 1440 }, channels: [HOOK] },
    });
    expect(known.statusCode).toBe(201);
    const listed = await here.app.inject({ method: 'GET', url: alerts, headers: { cookie: here.owner } });
    const rows = body<{ alerts: Array<Alert & { watches: string }> }>(listed).data?.alerts ?? [];
    expect(rows.find((row) => row.name === 'No signups')?.watches).toBe('Signed up happens fewer than 1 time in 24 hours');

    const unknown = await here.app.inject({
      method: 'POST',
      url: alerts,
      headers: { cookie: here.owner },
      payload: { name: 'x', condition: { kind: 'goal', goalId: 'g_gone', direction: 'below', count: 1, window: 1440 }, channels: [HOOK] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(body(unknown).error?.code).toBe('INVALID_ALERT');
  });

  it.each([
    ['no channels', { name: 'x', condition: DROP, channels: [] }],
    ['a percent too small', { name: 'x', condition: { ...DROP, percent: 5 }, channels: [HOOK] }],
    ['a window there is not', { name: 'x', condition: { kind: 'errors', statuses: '5xx', count: 5, window: 45 }, channels: [HOOK] }],
    ['a kind there is not', { name: 'x', condition: { kind: 'replay' }, channels: [HOOK] }],
    ['a webhook that is not http', { name: 'x', condition: DROP, channels: [{ kind: 'webhook', url: 'ftp://x' }] }],
    ['a field nobody asked for', { name: 'x', condition: DROP, channels: [HOOK], extra: 1 }],
  ])('refuses %s with the envelope', async (_why, payload) => {
    const response = await here.app.inject({ method: 'POST', url: alerts, headers: { cookie: here.owner }, payload });
    expect(response.statusCode).toBe(400);
    expect(body(response).error?.code).toBe('INVALID_ALERT');
  });

  it('lets a viewer read the list and refuses them every write', async () => {
    const id = alertIdFor(SITE_ID, DROP);
    for (const [method, url] of [
      ['POST', alerts],
      ['DELETE', `${alerts}/${id}`],
      ['POST', `${alerts}/${id}/test`],
    ] as const) {
      const response = await here.app.inject({ method, url, headers: { cookie: here.viewer }, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(body(response).error?.code).toBe('SCOPE_REQUIRED');
    }
  });

  it('sends a test message on every channel and answers each outcome', async () => {
    const id = alertIdFor(SITE_ID, DROP);
    const response = await here.app.inject({ method: 'POST', url: `${alerts}/${id}/test`, headers: { cookie: here.owner } });
    expect(response.statusCode).toBe(200);
    expect(body(response).data).toEqual({
      deliveries: [
        { channel: 'webhook', target: 'hooks.example.test', ok: true },
        { channel: 'telegram', target: 'chat', ok: false, error: 'Bad Request: chat not found' },
      ],
    });
    expect(here.deliverer.sent).toHaveLength(2);
    expect(here.deliverer.sent[0]?.message.subject).toBe('Chokh: a test from "Big drop" on Test site');
    expect(here.deliverer.sent[0]?.message.text).toBe(
      'This is a test message from the alert "Big drop" on Test site. It watches: Visitors fall 50% against the usual for the hour, once either side reaches 20. If you are reading this, the channel works.\nhttps://analytics.example.test/s_test/alerts',
    );
    expect(here.deliverer.sent[0]?.message.payload).toMatchObject({ event: 'alert.test', value: null });

    const missing = await here.app.inject({ method: 'POST', url: `${alerts}/al_nobody/test`, headers: { cookie: here.owner } });
    expect(missing.statusCode).toBe(404);
    expect(body(missing).error?.code).toBe('ALERT_NOT_FOUND');
  });

  it('deletes once, then says there is no such alert', async () => {
    const id = alertIdFor(SITE_ID, DROP);
    const first = await here.app.inject({ method: 'DELETE', url: `${alerts}/${id}`, headers: { cookie: here.owner } });
    expect(body(first)).toEqual({ success: true, data: { deleted: true } });
    const again = await here.app.inject({ method: 'DELETE', url: `${alerts}/${id}`, headers: { cookie: here.owner } });
    expect(again.statusCode).toBe(404);
    expect(body(again).error?.code).toBe('ALERT_NOT_FOUND');
  });
});
