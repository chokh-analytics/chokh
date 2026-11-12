import { describe, expect, it } from 'vitest';

import { failureReason } from './failure-reason.js';

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('why something failed, in one line', () => {
  it('is the message of an ordinary error', () => {
    expect(failureReason(new Error('the database "chokh" does not exist'))).toBe(
      'the database "chokh" does not exist',
    );
  });

  // The shape a refused connection has on a host whose name answers on both
  // IPv6 and IPv4: an empty message outside, the reasons inside.
  it('reads the reasons inside an error that has none of its own', () => {
    const refused = Object.assign(
      new AggregateError([
        coded('connect ECONNREFUSED ::1:5432', 'ECONNREFUSED'),
        coded('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(refused.message).toBe('');
    expect(failureReason(refused)).toBe(
      'connect ECONNREFUSED ::1:5432, connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('says a reason once, however many addresses gave it', () => {
    const twice = new AggregateError([new Error('timed out'), new Error('timed out')]);
    expect(failureReason(twice)).toBe('timed out');
  });

  it('names an error by its code when it has nothing else to say', () => {
    expect(failureReason(coded('', 'ECONNRESET'))).toBe('ECONNRESET');
    expect(failureReason(Object.assign(new AggregateError([]), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
  });

  it('never answers with nothing', () => {
    expect(failureReason(new Error(''))).toBe('no reason was given');
    expect(failureReason(new AggregateError([new Error('')]))).toBe('no reason was given');
    expect(failureReason(undefined)).toBe('no reason was given');
    expect(failureReason({ message: 'not an error' })).toBe('no reason was given');
    expect(failureReason('said as a string')).toBe('said as a string');
  });
});
