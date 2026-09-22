import { describe, expect, it } from 'vitest';

import { refusalOf, STATUS_BY_CODE } from './store-error.js';
import { StoreQueryError } from '../store/AnalyticsStore.js';

// Which status a refusal from the store becomes.
//
// The fallback is 400, which is right often enough that a code missing from the
// table looks fine: UNSUPPORTED_DIMENSION reached a 400 for a year by accident
// rather than by decision. The next one to go missing will be the one that
// should have been a 404, and it will look fine too, so every code the store
// can raise is named here and asserted.
const EXPECTED: Readonly<Record<string, number>> = {
  UNKNOWN_SITE: 404,
  UNKNOWN_USER: 404,
  UNKNOWN_TEAM: 404,
  GOAL_NOT_FOUND: 404,
  SITE_EXISTS: 409,
  TEAM_EXISTS: 409,
  EMAIL_EXISTS: 409,
  DOMAIN_TAKEN: 409,
  KEY_EXISTS: 409,
  GOAL_EXISTS: 409,
  GOAL_LIMIT: 409,
  DOMAIN_REQUIRED: 400,
  RANGE_TOO_LONG: 400,
  UNSUPPORTED_FILTER: 400,
  UNSUPPORTED_DIMENSION: 400,
  MISSING_DIMENSION: 400,
  UNSUPPORTED_GOAL: 400,
};

describe('refusalOf', () => {
  it.each(Object.entries(EXPECTED))('answers %s with %i', (code, status) => {
    expect(refusalOf(new StoreQueryError(code, 'why'))).toMatchObject({ code, status });
    // By the table and not by the fallback. Every code above answers 400 when
    // it is missing too, so the status alone proves nothing: this is the
    // assertion that would have caught UNSUPPORTED_DIMENSION.
    expect(STATUS_BY_CODE[code]).toBe(status);
  });

  it('names every code the store can raise, so none reaches a status by accident', () => {
    expect(Object.keys(STATUS_BY_CODE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('keeps the message the store wrote', () => {
    expect(refusalOf(new StoreQueryError('UNKNOWN_SITE', 'No site answers to s_x'))?.message).toBe(
      'No site answers to s_x',
    );
  });

  // Anything that is not a StoreQueryError is a fault of ours, and turning it
  // into a 400 would tell the caller they asked wrongly when they did not.
  it('is not a refusal at all for a fault', () => {
    expect(refusalOf(new Error('a driver fell over'))).toBeNull();
    expect(refusalOf('a string')).toBeNull();
  });
});
