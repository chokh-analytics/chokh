import { StoreQueryError } from '../store/AnalyticsStore.js';

// What a refused store read or write is on the wire.
//
// The store speaks in codes and knows nothing about HTTP, which is the layering
// rule working: a code means the same thing to a job, a test and a route. This
// is the one table that turns those codes into statuses, so no controller
// invents its own, and every one of them still answers with the envelope.

export interface Refusal {
  status: number;
  code: string;
  message: string;
}

export type Outcome<T> = { ok: true; data: T } | ({ ok: false } & Refusal);

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // The caller named something that is not there.
  UNKNOWN_SITE: 404,
  UNKNOWN_USER: 404,
  UNKNOWN_TEAM: 404,
  // The caller named something that is already there.
  SITE_EXISTS: 409,
  TEAM_EXISTS: 409,
  EMAIL_EXISTS: 409,
  DOMAIN_TAKEN: 409,
  KEY_EXISTS: 409,
  // The caller asked for something the store cannot answer as asked.
  DOMAIN_REQUIRED: 400,
  RANGE_TOO_LONG: 400,
  UNSUPPORTED_FILTER: 400,
  MISSING_DIMENSION: 400,
};

export function refusalOf(error: unknown): Refusal | null {
  if (!(error instanceof StoreQueryError)) {
    return null;
  }
  return {
    // An unmapped code is the store refusing for a reason this table has not
    // learned yet. 400 rather than 500: the store declined, it did not break.
    status: STATUS_BY_CODE[error.code] ?? 400,
    code: error.code,
    message: error.message,
  };
}

// Run a store call and turn a refusal into an outcome. Anything that is not a
// StoreQueryError is a fault of ours and is rethrown, so the error handler logs
// it and answers 500 rather than a route quietly reporting a database outage as
// a bad request.
export async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) {
      throw error;
    }
    return { ok: false, ...refusal };
  }
}
