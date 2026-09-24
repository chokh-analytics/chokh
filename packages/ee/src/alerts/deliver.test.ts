import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { DeliveryEnv } from '../license/env.js';
import {
  RETRY_AFTER_MS,
  SIGNATURE_HEADER,
  availableChannels,
  createDeliverer,
  targetOf,
} from './deliver.js';
import type { AlertMessage } from './messages.js';

// The three ways out, against a fetch that remembers what it was asked and a
// mailer that is a function. What a real server would answer is scripted per
// case, so the retry, the signature and the wording of a failure are proved
// without a socket.

const ENV: DeliveryEnv = {
  smtpUrl: 'smtp://user:pass@mail.example.test:587',
  mailFrom: 'chokh@example.test',
  telegramBotToken: '123456:not-a-real-token',
  publicUrl: 'https://analytics.example.test',
};

const MESSAGE: AlertMessage = {
  subject: 'Chokh alert: Big drop on Example',
  text: 'Visitors on Example fell 62% in the hour to 14:00 UTC: 41 against a usual 108.',
  payload: { event: 'alert.fired', text: 'Visitors fell.' },
};

interface Call {
  url: string;
  init: RequestInit;
}

function scripted(answers: Array<() => Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) {
      return Promise.reject(new Error('nothing scripted'));
    }
    const answer = next();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('what an install can send on', () => {
  it('names email only with both SMTP variables, Telegram only with a token, and a webhook always', () => {
    expect(availableChannels(ENV)).toEqual(['email', 'telegram', 'webhook']);
    expect(availableChannels({ ...ENV, mailFrom: undefined })).toEqual(['telegram', 'webhook']);
    expect(availableChannels({ ...ENV, smtpUrl: undefined, telegramBotToken: undefined })).toEqual(['webhook']);
  });

  it('names a target a row may keep: the address, the chat, the host and never a query', () => {
    expect(targetOf({ kind: 'email', to: 'ops@example.test' })).toBe('ops@example.test');
    expect(targetOf({ kind: 'telegram', chatId: '-100123' })).toBe('-100123');
    expect(targetOf({ kind: 'webhook', url: 'https://hooks.example.test/a/b?token=secret' })).toBe(
      'hooks.example.test',
    );
  });
});

describe('email', () => {
  it('hands the mailer the from, the to, the subject and the text', async () => {
    const sent: unknown[] = [];
    const deliverer = createDeliverer({
      env: ENV,
      mailer: { sendMail: (mail) => { sent.push(mail); return Promise.resolve({}); } },
      sleep: noSleep,
    });
    const outcome = await deliverer.send({ kind: 'email', to: 'ops@example.test' }, MESSAGE);
    expect(outcome).toEqual({ channel: 'email', target: 'ops@example.test', ok: true });
    expect(sent).toEqual([
      { from: ENV.mailFrom, to: 'ops@example.test', subject: MESSAGE.subject, text: MESSAGE.text },
    ]);
  });

  it('writes the mailer refusal down and never throws', async () => {
    const deliverer = createDeliverer({
      env: ENV,
      mailer: { sendMail: () => Promise.reject(new Error('535 Authentication failed')) },
      sleep: noSleep,
    });
    const outcome = await deliverer.send({ kind: 'email', to: 'ops@example.test' }, MESSAGE);
    expect(outcome).toEqual({
      channel: 'email',
      target: 'ops@example.test',
      ok: false,
      error: '535 Authentication failed',
    });
  });

  it('names the variables an install without SMTP is missing', async () => {
    const deliverer = createDeliverer({ env: { ...ENV, smtpUrl: undefined }, sleep: noSleep });
    const outcome = await deliverer.send({ kind: 'email', to: 'ops@example.test' }, MESSAGE);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('CHOKH_SMTP_URL');
  });
});

describe('Telegram', () => {
  it('posts the text to the chat through the Bot API', async () => {
    const { fetch: fetchFn, calls } = scripted([() => json(200, { ok: true })]);
    const deliverer = createDeliverer({ env: ENV, fetch: fetchFn, sleep: noSleep });
    const outcome = await deliverer.send({ kind: 'telegram', chatId: '-100123' }, MESSAGE);
    expect(outcome).toEqual({ channel: 'telegram', target: '-100123', ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${ENV.telegramBotToken}/sendMessage`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      chat_id: '-100123',
      text: MESSAGE.text,
      disable_web_page_preview: true,
    });
  });

  it("keeps Telegram's own reason and does not retry a refusal", async () => {
    const { fetch: fetchFn, calls } = scripted([
      () => json(400, { ok: false, description: 'Bad Request: chat not found' }),
    ]);
    const deliverer = createDeliverer({ env: ENV, fetch: fetchFn, sleep: noSleep });
    const outcome = await deliverer.send({ kind: 'telegram', chatId: '-100123' }, MESSAGE);
    expect(outcome).toEqual({
      channel: 'telegram',
      target: '-100123',
      ok: false,
      error: 'Bad Request: chat not found',
    });
    expect(calls).toHaveLength(1);
  });

  it('names the variable an install without a bot token is missing, and asks nothing of the network', async () => {
    const { fetch: fetchFn, calls } = scripted([]);
    const deliverer = createDeliverer({ env: { ...ENV, telegramBotToken: undefined }, fetch: fetchFn, sleep: noSleep });
    const outcome = await deliverer.send({ kind: 'telegram', chatId: '-100123' }, MESSAGE);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('CHOKH_TELEGRAM_BOT_TOKEN');
    expect(calls).toHaveLength(0);
  });
});

describe('a webhook', () => {
  const hook = { kind: 'webhook', url: 'https://hooks.example.test/chokh', secret: 'a-shared-secret-long-enough' } as const;

  it('posts the payload as JSON, signed with the secret', async () => {
    const { fetch: fetchFn, calls } = scripted([() => new Response(null, { status: 204 })]);
    const deliverer = createDeliverer({ env: ENV, fetch: fetchFn, sleep: noSleep });
    const outcome = await deliverer.send(hook, MESSAGE);
    expect(outcome).toEqual({ channel: 'webhook', target: 'hooks.example.test', ok: true });
    const call = calls[0];
    expect(call?.url).toBe(hook.url);
    const body = String(call?.init.body);
    expect(JSON.parse(body)).toEqual(MESSAGE.payload);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('Chokh');
    // The signature a receiver recomputes: HMAC-SHA256 of the exact body.
    expect(headers[SIGNATURE_HEADER]).toBe(
      `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`,
    );
  });

  it('sends no signature header without a secret', async () => {
    const { fetch: fetchFn, calls } = scripted([() => new Response('', { status: 200 })]);
    const deliverer = createDeliverer({ env: ENV, fetch: fetchFn, sleep: noSleep });
    await deliverer.send({ kind: 'webhook', url: hook.url }, MESSAGE);
    expect((calls[0]?.init.headers as Record<string, string>)[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('tries once more after a network error or a 5xx, and then writes the failure down', async () => {
    const slept: number[] = [];
    const sleep = (ms: number): Promise<void> => { slept.push(ms); return Promise.resolve(); };

    const recovered = scripted([() => new Error('ECONNRESET'), () => new Response('', { status: 200 })]);
    expect((await createDeliverer({ env: ENV, fetch: recovered.fetch, sleep }).send(hook, MESSAGE)).ok).toBe(true);
    expect(recovered.calls).toHaveLength(2);
    expect(slept).toEqual([RETRY_AFTER_MS]);

    const down = scripted([() => new Response('', { status: 503 }), () => new Response('', { status: 503 })]);
    const outcome = await createDeliverer({ env: ENV, fetch: down.fetch, sleep }).send(hook, MESSAGE);
    expect(outcome).toEqual({
      channel: 'webhook',
      target: 'hooks.example.test',
      ok: false,
      error: 'The receiver answered 503',
    });
    expect(down.calls).toHaveLength(2);
  });

  it('does not retry a refusal the receiver meant', async () => {
    const { fetch: fetchFn, calls } = scripted([() => new Response('', { status: 401 })]);
    const outcome = await createDeliverer({ env: ENV, fetch: fetchFn, sleep: noSleep }).send(hook, MESSAGE);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('The receiver answered 401');
    expect(calls).toHaveLength(1);
  });
});
