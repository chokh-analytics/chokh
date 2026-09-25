import { describe, expect, it } from 'vitest';

import type { DeliveryEnv } from '../license/env.js';
import { BREVO_SEND_URL, createDeliverer, type Mail } from './deliver.js';

// A mail with a body and a file (AN-RPT01), the two ways this install sends:
// Brevo's API takes the HTML and the attachment as base64, nodemailer takes
// them as its own fields. An alert's mail is the same call with less in it.

const MAIL: Mail = {
  subject: 'Chokh: Example on 2026-09-24',
  text: 'Visitors 3',
  html: '<p>Visitors <strong>3</strong></p>',
  attachments: [{ name: 'example-daily-2026-09-24.pdf', content: new Uint8Array([37, 80, 68, 70]), type: 'application/pdf' }],
};

describe('sendMail', () => {
  it('goes over Brevo with the HTML and the file as base64 when the key is set', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const env: DeliveryEnv = {
      smtpUrl: undefined,
      brevoApiKey: 'xkeysib-test',
      mailFrom: 'chokh@example.test',
      telegramBotToken: undefined,
      publicUrl: undefined,
    };
    const deliverer = createDeliverer({
      env,
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response('{}', { status: 201 }));
      }) as unknown as typeof fetch,
    });
    expect(await deliverer.sendMail('ops@example.test', MAIL)).toBeNull();
    expect(calls[0]?.url).toBe(BREVO_SEND_URL);
    expect(calls[0]?.body).toEqual({
      sender: { email: 'chokh@example.test' },
      to: [{ email: 'ops@example.test' }],
      subject: MAIL.subject,
      textContent: MAIL.text,
      htmlContent: MAIL.html,
      attachment: [{ name: 'example-daily-2026-09-24.pdf', content: 'JVBERg==' }],
    });
  });

  it('goes over SMTP with nodemailer fields otherwise, and says what the install lacks', async () => {
    const sent: unknown[] = [];
    const env: DeliveryEnv = {
      smtpUrl: 'smtp://user:pass@mail.example.test:587',
      brevoApiKey: undefined,
      mailFrom: 'chokh@example.test',
      telegramBotToken: undefined,
      publicUrl: undefined,
    };
    const deliverer = createDeliverer({
      env,
      mailer: {
        sendMail(mail) {
          sent.push(mail);
          return Promise.resolve({ accepted: true });
        },
      },
    });
    expect(await deliverer.sendMail('ops@example.test', MAIL)).toBeNull();
    expect(sent[0]).toMatchObject({
      from: 'chokh@example.test',
      to: 'ops@example.test',
      subject: MAIL.subject,
      text: MAIL.text,
      html: MAIL.html,
    });
    const attachments = (sent[0] as { attachments: { filename: string; contentType: string; content: Buffer }[] }).attachments;
    expect(attachments[0]?.filename).toBe('example-daily-2026-09-24.pdf');
    expect(attachments[0]?.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(attachments[0]?.content)).toBe(true);

    const bare = createDeliverer({
      env: { ...env, smtpUrl: undefined, mailFrom: undefined },
    });
    expect(await bare.sendMail('ops@example.test', MAIL)).toBe(
      'CHOKH_SMTP_URL or CHOKH_BREVO_API_KEY and CHOKH_MAIL_FROM not set on this install',
    );
  });
});
