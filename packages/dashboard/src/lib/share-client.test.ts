import { describe, expect, it, vi } from 'vitest';

import { createClient } from './client.js';
import { shareClient } from './share-client.js';

// The shared page's client: a site path becomes the share's path, and nothing
// else about the request changes.

describe('shareClient', () => {
  it('rewrites a site path to the share and leaves the query alone', async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ success: true, data: { ok: 1 } }),
      } as unknown as Response),
    );
    const client = shareClient(createClient({ fetch: fetcher }), 'tok_abc');
    await client.get('/api/sites/share:tok_abc/stats/aggregate', { from: 1, to: 2 });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('/api/share/tok_abc/stats/aggregate?from=1&to=2');
    expect(client.url('/api/sites/anything/annotations', { from: 1, to: 2 })).toBe(
      '/api/share/tok_abc/annotations?from=1&to=2',
    );
  });

  it('leaves a path that is not a site path alone, and escapes the token', () => {
    const client = shareClient(createClient(), 'a b/c');
    expect(client.url('/api/me')).toBe('/api/me');
    expect(client.url('/api/sites/s_1/stats/goals')).toBe('/api/share/a%20b%2Fc/stats/goals');
  });
});
