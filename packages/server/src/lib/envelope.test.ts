import { describe, expect, it } from 'vitest';

import { fail, ok } from './envelope.js';

describe('ok', () => {
  it('wraps data without a meta key when no meta is given', () => {
    expect(ok({ status: 'ok' })).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('carries meta when it is given', () => {
    expect(ok([1, 2], { total: 2 })).toEqual({
      success: true,
      data: [1, 2],
      meta: { total: 2 },
    });
  });
});

describe('fail', () => {
  it('wraps a code and a message', () => {
    expect(fail('NOT_FOUND', 'Route GET /nope not found')).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route GET /nope not found' },
    });
  });

  it('carries details when they are given', () => {
    expect(fail('BAD_REQUEST', 'Invalid body', [{ path: 'siteId' }])).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid body', details: [{ path: 'siteId' }] },
    });
  });
});
