import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NOW, SITE_ID, createHarness, envelope, type Harness } from './api.test-utils.js';

// What a fault of the database is on the wire, whichever database it was.
//
// A store refuses with a StoreQueryError and a code, which the routes turn into
// a 4xx. Anything else is a fault: a driver that fell over, a server that went
// away, a statement the server cancelled because it outlived its limit. Those
// carry the driver's own code and text, and none of it is the caller's
// business, so every one of them is the same 500 and the same envelope. This
// holds the two drivers to one answer: the PostgreSQL adapter runs every
// statement under a timeout, and what that produces must read exactly as a
// failed MongoDB read does.

// As `pg` raises it when the server cancels a statement.
function cancelledStatement(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), {
    name: 'error',
    code: '57014',
    severity: 'ERROR',
    routine: 'ProcessInterrupts',
    where: 'SELECT count(*) FROM events WHERE site_id = $1',
  });
}

// As the MongoDB driver raises an operation that ran out of time.
function expiredOperation(): Error {
  return Object.assign(new Error('operation exceeded time limit'), {
    name: 'MongoServerError',
    code: 50,
    codeName: 'MaxTimeMSExpired',
  });
}

describe('a fault of the database', () => {
  let harness: Harness;
  const url = `/api/sites/${SITE_ID}/stats/aggregate?from=${NOW - 3_600_000}&to=${NOW}`;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function readWith(fault: Error): Promise<{ statusCode: number; body: string }> {
    const real = harness.store.aggregate;
    harness.store.aggregate = () => Promise.reject(fault);
    try {
      return await harness.app.inject({ method: 'GET', url, headers: { cookie: harness.owner.cookie } });
    } finally {
      harness.store.aggregate = real;
    }
  }

  it('answers a statement PostgreSQL cancelled with the envelope and INTERNAL_ERROR', async () => {
    const response = await readWith(cancelledStatement());
    expect(response.statusCode).toBe(500);
    expect(envelope(response.body)).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    // Nothing of the driver's reaches the caller: not its code, not its text,
    // not the statement.
    expect(response.body).not.toContain('57014');
    expect(response.body).not.toContain('statement');
    expect(response.body).not.toContain('events');
  });

  it('answers it exactly as it answers a MongoDB read that ran out of time', async () => {
    const postgres = await readWith(cancelledStatement());
    const mongo = await readWith(expiredOperation());
    expect(postgres.statusCode).toBe(mongo.statusCode);
    expect(postgres.body).toBe(mongo.body);
  });

  it('and the route answers again once the database does', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url,
      headers: { cookie: harness.owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(envelope(response.body).success).toBe(true);
  });
});
