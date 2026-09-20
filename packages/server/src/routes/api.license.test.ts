import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, envelope, expectFailure, type Harness } from './api.test-utils.js';
import { ok } from '../lib/envelope.js';
import type { LicenseStatus, ServerExtension } from '../plugins/extensions.js';

// What this install may run, and the seam packages/ee hangs off.
//
// Core answers GET /api/license so that a build with no paid half still gives
// the dashboard a true answer, which is what lets it draw "part of Chokh Pro"
// on a feature it does not have. The interesting cases are therefore about the
// core on its own: a stranger gets nothing, a signed-in person gets "no
// licence", and an extension that is there takes the answer over.

describe('GET /api/license, with no extensions', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  // The licensee's name and the expiry date say who runs this install and when
  // they last paid. Neither is a stranger's business, and an install is on the
  // open internet.
  it('refuses a caller with no credentials', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/license' });
    expectFailure(response, 401, 'UNAUTHENTICATED');
    expect(response.body).not.toContain('licensee');
  });

  it('tells a signed-in person there is no licence, rather than nothing', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: harness.owner.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = envelope<LicenseStatus>(response.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      licensed: false,
      plan: null,
      licensee: null,
      expiresAt: null,
      features: [],
    });
  });
});

describe('an extension', () => {
  const licensed: LicenseStatus = {
    licensed: true,
    plan: 'pro',
    licensee: 'A Test Company Ltd.',
    expiresAt: Date.UTC(2027, 8, 20),
    features: ['a-fixture'],
  };

  function fixture(over: Partial<ServerExtension> = {}): ServerExtension {
    return {
      name: 'fixture',
      register: async (app) => {
        app.get('/api/fixture', () => ok({ reached: true }));
      },
      license: () => licensed,
      ...over,
    };
  }

  it('answers the licence question when it offers one', async () => {
    const harness = await createHarness({ extensions: [fixture()] });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: harness.owner.cookie },
    });

    expect(envelope<LicenseStatus>(response.body).data).toEqual(licensed);
    await harness.close();
  });

  // Registered after every core route and before the not found handler, which
  // answers any path it is given and would otherwise swallow this one. The
  // ordering is the kind of thing that is obvious until somebody moves a line.
  it('has its routes served rather than swallowed by the not found handler', async () => {
    const harness = await createHarness({ extensions: [fixture()] });
    const response = await harness.app.inject({ method: 'GET', url: '/api/fixture' });

    expect(response.statusCode).toBe(200);
    expect(envelope<{ reached: boolean }>(response.body).data?.reached).toBe(true);
    await harness.close();
  });

  // An extension is allowed to add routes and say nothing about licensing. The
  // core must not then claim a licence it has no word on.
  it('leaves the licence unlicensed when it offers no opinion', async () => {
    const bare = fixture();
    delete bare.license;
    const harness = await createHarness({ extensions: [bare] });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/license',
      headers: { cookie: harness.owner.cookie },
    });

    expect(envelope<LicenseStatus>(response.body).data?.licensed).toBe(false);
    await harness.close();
  });
});
