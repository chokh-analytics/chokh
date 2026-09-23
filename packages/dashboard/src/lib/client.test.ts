import { describe, expect, it, vi } from 'vitest';

import { ChokhError, createClient, isRetryable, toQueryString } from './client.js';

function respond(status: number, body: unknown, ok = status < 400): Response {
  return {
    status,
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function notJson(status: number): Response {
  return {
    status,
    ok: status < 400,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  } as unknown as Response;
}

describe('toQueryString', () => {
  it('leaves out what nobody asked for', () => {
    // A limit of nothing is the server's default. Sending limit= would be a
    // limit of the empty string, which is a different question.
    expect(toQueryString({ from: 1, to: 2, limit: undefined })).toBe('?from=1&to=2');
  });

  it('is empty when there is nothing to send', () => {
    expect(toQueryString(undefined)).toBe('');
    expect(toQueryString({})).toBe('');
  });

  it('escapes a value that would otherwise break the URL', () => {
    expect(toQueryString({ filters: 'page==/a b&c' })).toBe(
      '?filters=page%3D%3D%2Fa+b%26c',
    );
  });
});

describe('createClient', () => {
  it('unwraps the success envelope and keeps the meta', async () => {
    const fetch = vi.fn().mockResolvedValue(
      respond(200, { success: true, data: { visitors: 12 }, meta: { siteId: 's_1' } }),
    );
    const client = createClient({ fetch });
    const answer = await client.get<{ visitors: number }>('/api/x');
    expect(answer.data).toEqual({ visitors: 12 });
    expect(answer.meta).toEqual({ siteId: 's_1' });
  });

  it('sends the cookie, because the dashboard is the API origin', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(200, { success: true, data: null }));
    await createClient({ fetch }).get('/api/me');
    expect(fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({
      credentials: 'same-origin',
    }));
  });

  // Every failure is one thing to catch, carrying the code the server used, so
  // no page has to read a status or parse English to behave differently.
  it('throws the server code and message, not a status', async () => {
    const fetch = vi.fn().mockResolvedValue(
      respond(400, {
        success: false,
        error: { code: 'RANGE_TOO_LONG', message: 'Ask for days instead.' },
      }),
    );
    await expect(createClient({ fetch }).get('/api/x')).rejects.toMatchObject({
      status: 400,
      code: 'RANGE_TOO_LONG',
      message: 'Ask for days instead.',
    });
  });

  it('keeps the details a refusal carried', async () => {
    const fetch = vi.fn().mockResolvedValue(
      respond(400, {
        success: false,
        error: { code: 'INVALID_QUERY', message: 'No', details: [{ path: ['from'] }] },
      }),
    );
    await createClient({ fetch })
      .get('/api/x')
      .catch((error: ChokhError) => {
        expect(error.details).toEqual([{ path: ['from'] }]);
      });
    expect.assertions(1);
  });

  // The whole session expiry story lives in one callback rather than in every
  // hook noticing a 401 for itself.
  it('tells the application once for every 401, and still throws', async () => {
    const onUnauthenticated = vi.fn();
    const fetch = vi.fn().mockResolvedValue(
      respond(401, { success: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }),
    );
    await expect(
      createClient({ fetch, onUnauthenticated }).get('/api/me'),
    ).rejects.toBeInstanceOf(ChokhError);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  // A proxy error page or a sign in redirect landing here is exactly this, and
  // saying so is more use than a parse error nobody can place.
  it('names a response that is not this API rather than failing to parse it', async () => {
    const fetch = vi.fn().mockResolvedValue(notJson(502));
    await expect(createClient({ fetch }).get('/api/x')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      status: 502,
    });
  });

  it('names a body that parsed but carried no envelope', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(200, { visitors: 12 }));
    await expect(createClient({ fetch }).get('/api/x')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('names a request that never reached a server', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createClient({ fetch }).get('/api/x')).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    });
  });

  it('posts JSON with the header that says so', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(200, { success: true, data: null }));
    await createClient({ fetch }).post('/api/auth/login', { email: 'a@b.c' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: '{"email":"a@b.c"}',
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  // A delete carries no body and no content type, which a server that parses
  // JSON would otherwise refuse as an empty document.
  it('deletes with no body', async () => {
    const fetch = vi.fn().mockResolvedValue(respond(200, { success: true, data: { deleted: true } }));
    const answer = await createClient({ fetch }).delete<{ deleted: boolean }>('/api/sites/s/goals/g');
    expect(answer.data.deleted).toBe(true);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('builds the URL a download or a stream is opened at', () => {
    const client = createClient({ baseUrl: 'http://localhost:4100/' });
    expect(client.url('/api/sites/s_1/export.csv', { dim: 'page' })).toBe(
      'http://localhost:4100/api/sites/s_1/export.csv?dim=page',
    );
  });
});

describe('isRetryable', () => {
  // A 4xx is an answer. Asking again turns one refusal into three and delays
  // the message somebody has to read.
  it('asks again for a fault and never for an answer', () => {
    expect(isRetryable(new ChokhError(0, 'NETWORK', 'no'))).toBe(true);
    expect(isRetryable(new ChokhError(503, 'X', 'no'))).toBe(true);
    expect(isRetryable(new ChokhError(400, 'INVALID_QUERY', 'no'))).toBe(false);
    expect(isRetryable(new ChokhError(403, 'FORBIDDEN', 'no'))).toBe(false);
    expect(isRetryable(new Error('something else'))).toBe(false);
  });
});
