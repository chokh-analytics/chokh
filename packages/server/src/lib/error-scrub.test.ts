import { describe, expect, it } from 'vitest';

import { errorPath, scrubErrorText, scrubbedErrorField } from './error-scrub.js';

describe('scrubErrorText', () => {
  it('takes the query string and fragment off URLs and paths, keeping the page', () => {
    expect(scrubErrorText('Failed to fetch https://api.test/v1/me?token=abc&x=1#frag')).toBe(
      'Failed to fetch https://api.test/v1/me',
    );
    expect(scrubErrorText('at load (https://cdn.test/app.js?v=3:10:5)')).toBe(
      'at load (https://cdn.test/app.js:10:5)',
    );
    expect(scrubErrorText('GET /api/users?email=a@b.test failed')).toBe('GET /api/users failed');
    // A question mark in prose is not a query string.
    expect(scrubErrorText('Is it defined? No')).toBe('Is it defined? No');
  });

  it('replaces addresses, tokens, ids and long numbers', () => {
    expect(scrubErrorText('No account for rafi.ahmed+x@mail.example.com')).toBe('No account for [email]');
    expect(scrubErrorText('Bad jwt eyJhbGciOi.eyJzdWIiOiIx.c2ln')).toBe('Bad jwt [token]');
    expect(scrubErrorText('user 3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b missing')).toBe('user [id] missing');
    expect(scrubErrorText('doc 64f1a2b3c4d5e6f7a8b9c0d1 gone')).toBe('doc [token] gone');
    expect(scrubErrorText('call 01712 345 678 now')).toBe('call [number] now');
    expect(scrubErrorText('card 4111-1111-1111-1111')).toBe('card [number]');
  });

  it('redacts the value after anything named like a secret', () => {
    expect(scrubErrorText('apiKey: sk_live_abc failed')).toBe('apiKey: [redacted] failed');
    expect(scrubErrorText('{"access_token":"xyz","n":1}')).toBe('{"access_token":"[redacted]","n":1}');
    expect(scrubErrorText('Authorization: Bearer abc.def')).toBe('Authorization: [redacted]');
    expect(scrubErrorText('sent Bearer abc.def')).toBe('sent Bearer [redacted]');
    expect(scrubErrorText('password=hunter2')).toBe('password=[redacted]');
  });

  it('leaves an ordinary message, line numbers and short words alone', () => {
    for (const message of [
      "TypeError: Cannot read properties of undefined (reading 'map')",
      'SyntaxError: Unexpected token < in JSON at position 0',
      'Request failed with status code 500',
    ]) {
      expect(scrubErrorText(message)).toBe(message);
    }
    expect(scrubErrorText('at render (https://a.test/main.js:120:33)')).toBe(
      'at render (https://a.test/main.js:120:33)',
    );
  });
});

describe('scrubbedErrorField', () => {
  it('scrubs before it cuts', () => {
    const text = `${'x'.repeat(190)} a@b.test and more`;
    expect(scrubbedErrorField(text, 199)).toBe(`${'x'.repeat(190)} [email] `);
  });
});

describe('errorPath', () => {
  it('keeps the page and drops any query or fragment', () => {
    expect(errorPath('/reset?token=abc')).toBe('/reset');
    expect(errorPath('/a#b')).toBe('/a');
    expect(errorPath('/plain')).toBe('/plain');
  });
});
