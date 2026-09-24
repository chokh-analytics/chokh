import { createHmac } from 'node:crypto';
import type { AlertChannel, AlertChannelKind, AlertDelivery } from '@chokh/store';

import type { DeliveryEnv } from '../license/env.js';
import type { AlertMessage } from './messages.js';

// Where a message goes: an address over SMTP, a Telegram chat through the Bot
// API, or a webhook. One interface, so the evaluator and the test route send
// the same way and a test hands in a fake instead of a mail server.
//
// Nothing here retries for long. A message about a spike that arrives an hour
// later is a message about a spike that is over, so an HTTP delivery is tried
// twice with five seconds between and then written down as failed; the row
// keeps the outcome and the page shows it.

export interface Deliverer {
  // The kinds this install can send on. A channel of another kind is refused
  // when the alert is created, never quietly kept.
  available: readonly AlertChannelKind[];
  send(channel: AlertChannel, message: AlertMessage): Promise<AlertDelivery>;
}

// The one call this needs of a mail library, so a test hands in a function
// and nothing here opens a socket.
export interface Mailer {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface DelivererOptions {
  env: DeliveryEnv;
  fetch?: typeof fetch;
  mailer?: Mailer;
  // Between the two tries of an HTTP delivery.
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export const RETRY_AFTER_MS = 5_000;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const SIGNATURE_HEADER = 'x-chokh-signature';

export function availableChannels(env: DeliveryEnv): AlertChannelKind[] {
  const kinds: AlertChannelKind[] = [];
  if (env.smtpUrl !== undefined && env.mailFrom !== undefined) {
    kinds.push('email');
  }
  if (env.telegramBotToken !== undefined) {
    kinds.push('telegram');
  }
  kinds.push('webhook');
  return kinds;
}

// What a row keeps of a failure: enough to act on, never a secret. A URL may
// carry a token in its query, so the target of a webhook is its host.
export function targetOf(channel: AlertChannel): string {
  switch (channel.kind) {
    case 'email':
      return channel.to;
    case 'telegram':
      return channel.chatId;
    case 'webhook':
      try {
        return new URL(channel.url).host;
      } catch {
        return 'webhook';
      }
  }
}

function brief(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// Whether a failed HTTP delivery is worth one more try: the network, or the
// receiver saying it is the one having a bad minute.
function retryable(status: number | null): boolean {
  return status === null || status >= 500;
}

export function createDeliverer(options: DelivererOptions): Deliverer {
  const { env } = options;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  let mailer: Promise<Mailer> | null = options.mailer === undefined ? null : Promise.resolve(options.mailer);

  // The transport is built on the first message and kept, so a boot with no
  // SMTP configured never loads the library, and a boot with one does not
  // connect until there is something to say.
  function mailerFor(url: string): Promise<Mailer> {
    if (mailer === null) {
      mailer = import('nodemailer').then((nodemailer) => nodemailer.createTransport(url));
    }
    return mailer;
  }

  // One HTTP delivery, tried twice at most.
  async function post(
    url: string,
    headers: Record<string, string>,
    body: string,
    accept: (response: Response) => Promise<string | null>,
  ): Promise<string | null> {
    let lastError = 'not sent';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await sleep(RETRY_AFTER_MS);
      }
      let status: number | null = null;
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        const problem = await accept(response);
        if (problem === null) {
          return null;
        }
        lastError = problem;
      } catch (error) {
        lastError = brief(error);
      }
      if (!retryable(status)) {
        break;
      }
    }
    return lastError;
  }

  async function sendEmail(to: string, message: AlertMessage): Promise<string | null> {
    if (env.smtpUrl === undefined || env.mailFrom === undefined) {
      return 'CHOKH_SMTP_URL and CHOKH_MAIL_FROM are not set on this install';
    }
    try {
      const transport = await mailerFor(env.smtpUrl);
      await transport.sendMail({ from: env.mailFrom, to, subject: message.subject, text: message.text });
      return null;
    } catch (error) {
      return brief(error);
    }
  }

  function sendTelegram(chatId: string, message: AlertMessage): Promise<string | null> {
    const token = env.telegramBotToken;
    if (token === undefined) {
      return Promise.resolve('CHOKH_TELEGRAM_BOT_TOKEN is not set on this install');
    }
    return post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { 'content-type': 'application/json' },
      JSON.stringify({ chat_id: chatId, text: message.text, disable_web_page_preview: true }),
      async (response) => {
        // Telegram says why in the body, and the body never carries the token.
        const parsed = (await response.json().catch(() => null)) as
          | { ok?: boolean; description?: string }
          | null;
        if (response.ok && parsed?.ok === true) {
          return null;
        }
        return parsed?.description ?? `Telegram answered ${response.status}`;
      },
    );
  }

  function sendWebhook(channel: Extract<AlertChannel, { kind: 'webhook' }>, message: AlertMessage): Promise<string | null> {
    const body = JSON.stringify(message.payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'Chokh',
    };
    if (channel.secret !== undefined) {
      headers[SIGNATURE_HEADER] = signBody(channel.secret, body);
    }
    return post(channel.url, headers, body, (response) =>
      Promise.resolve(response.ok ? null : `The receiver answered ${response.status}`),
    );
  }

  return {
    available: availableChannels(env),

    async send(channel, message) {
      const target = targetOf(channel);
      let error: string | null;
      switch (channel.kind) {
        case 'email':
          error = await sendEmail(channel.to, message);
          break;
        case 'telegram':
          error = await sendTelegram(channel.chatId, message);
          break;
        case 'webhook':
          error = await sendWebhook(channel, message);
          break;
      }
      return error === null
        ? { channel: channel.kind, target, ok: true }
        : { channel: channel.kind, target, ok: false, error };
    },
  };
}
