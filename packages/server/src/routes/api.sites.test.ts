import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  SITE_ID,
  TEAM_ID,
  type Harness,
} from './api.test-utils.js';

// Sites, their settings and their keys.
//
// The two cases this file exists for: a site cannot be created without a domain,
// because the unique multikey index on sites.domains stores one null key for an
// empty list; and the identifySecret is handed over exactly twice in a site's life,
// when it is created and when it is rotated, and never by a GET.

interface Created {
  site: { id: string; domains: string[]; settings: Record<string, unknown> };
  once: { identifySecret: string };
}

describe('POST /api/sites', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  function create(payload: unknown, cookie = harness.owner.cookie) {
    return harness.app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  }

  it('creates a site and hands back its identify secret once', async () => {
    const response = await create({
      id: 'ps_web',
      name: 'Progsity web',
      domains: ['example.com', 'www.example.com'],
      teamId: TEAM_ID,
    });

    expect(response.statusCode).toBe(201);
    const body = envelope<Created>(response.body);
    expect(body.data?.site.id).toBe('ps_web');
    expect(body.data?.site.domains).toEqual(['example.com', 'www.example.com']);
    expect(body.data?.once.identifySecret).toBeTypeOf('string');
    expect(body.data?.once.identifySecret.length).toBeGreaterThan(20);
    // Never inside the site object, even on the one response that carries it.
    expect(body.data?.site.settings).not.toHaveProperty('identifySecret');

    const stored = await harness.store.site('ps_web');
    expect(stored?.settings.identifySecret).toBe(body.data?.once.identifySecret);
  });

  // The ruling this route owns: sites.domains is unique and multikey, so an empty
  // array indexes as one null key and the second domainless site would collide with
  // the first.
  it('refuses a site with no domain', async () => {
    expectFailure(await create({ name: 'Bare', domains: [] }), 400, 'INVALID_BODY');
    expectFailure(await create({ name: 'Bare' }), 400, 'INVALID_BODY');
    expect((await harness.store.sites()).map((site) => site.id)).toEqual([SITE_ID]);
  });

  it('refuses a domain another site already claims, and a site id already taken', async () => {
    expectFailure(
      await create({ name: 'Copy', domains: ['test.example'], teamId: TEAM_ID }),
      409,
      'DOMAIN_TAKEN',
    );
    expectFailure(
      await create({ id: SITE_ID, name: 'Copy', domains: ['other.example'], teamId: TEAM_ID }),
      409,
      'SITE_EXISTS',
    );
  });

  it('refuses a domain that is a URL rather than a hostname', async () => {
    expectFailure(
      await create({ name: 'Scheme', domains: ['https://example.com'], teamId: TEAM_ID }),
      400,
      'INVALID_BODY',
    );
    expectFailure(
      await create({ name: 'Path', domains: ['example.com/blog'], teamId: TEAM_ID }),
      400,
      'INVALID_BODY',
    );
  });

  it('lowercases a domain, because the origin check compares hostnames exactly', async () => {
    const response = await create({ name: 'Case', domains: ['Example.COM'], teamId: TEAM_ID });
    expect(envelope<Created>(response.body).data?.site.domains).toEqual(['example.com']);
  });

  it('refuses somebody who is not an owner of the team the site would go into', async () => {
    const editor = await harness.account({ email: 'editor@test.example', role: 'editor' });
    expectFailure(
      await create({ name: 'Theirs', domains: ['new.example'], teamId: TEAM_ID }, editor.cookie),
      403,
      'FORBIDDEN',
    );
  });

  it('refuses a key, because a site is created by a person', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { authorization: await harness.key(['admin']) },
      payload: { name: 'By a key', domains: ['key.example'] },
    });
    expectFailure(response, 403, 'FORBIDDEN');
  });
});

describe('reading and changing a site', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('never carries the identify secret in a GET', async () => {
    const one = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}`,
      headers: { cookie: harness.owner.cookie },
    });
    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/sites',
      headers: { cookie: harness.owner.cookie },
    });
    const me = await harness.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: harness.owner.cookie },
    });

    expect(one.statusCode).toBe(200);
    for (const body of [one.body, list.body, me.body]) {
      expect(body).not.toContain('identifySecret');
      expect(body).not.toContain('test-identify-secret');
    }
  });

  it('rotates the secret and hands the new one back once', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/identify-secret/rotate`,
      headers: { cookie: harness.owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = envelope<Created>(response.body);
    const rotated = body.data?.once.identifySecret;
    expect(rotated).toBeTypeOf('string');
    expect(rotated).not.toBe('test-identify-secret');
    expect((await harness.store.site(SITE_ID))?.settings.identifySecret).toBe(rotated);
    expect(body.data?.site.settings).not.toHaveProperty('identifySecret');
  });

  it('lets only an owner rotate it', async () => {
    const editor = await harness.account({ email: 'editor@test.example', role: 'editor' });
    expectFailure(
      await harness.app.inject({
        method: 'POST',
        url: `/api/sites/${SITE_ID}/identify-secret/rotate`,
        headers: { cookie: editor.cookie },
      }),
      403,
      'SCOPE_REQUIRED',
    );
  });

  it('patches settings field by field and leaves the rest alone', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/sites/${SITE_ID}`,
      headers: { cookie: harness.owner.cookie },
      payload: { settings: { ipMode: 'full', retentionDays: 90 } },
    });
    expect(response.statusCode).toBe(200);
    const settings = (await harness.store.site(SITE_ID))?.settings;
    expect(settings?.ipMode).toBe('full');
    expect(settings?.retentionDays).toBe(90);
    expect(settings?.visitorIdMode).toBe('cookieless');
    // The patch did not wipe it.
    expect(settings?.identifySecret).toBe('test-identify-secret');
  });

  // The one setting a patch may not touch: a secret somebody chose is a secret
  // somebody else can guess, and a settings echo would hand it back.
  it('refuses a patch that tries to set the identify secret', async () => {
    expectFailure(
      await harness.app.inject({
        method: 'PATCH',
        url: `/api/sites/${SITE_ID}`,
        headers: { cookie: harness.owner.cookie },
        payload: { settings: { identifySecret: 'chosen-by-me' } },
      }),
      400,
      'INVALID_BODY',
    );
    expect((await harness.store.site(SITE_ID))?.settings.identifySecret).toBe(
      'test-identify-secret',
    );
  });

  it('takes route rules, marks the site for a regroup, and refuses a rule that is not a path', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/sites/${SITE_ID}`,
      headers: { cookie: harness.owner.cookie },
      payload: { settings: { routeGroups: ['/courses/:slug', '/learn/:course/:lesson'] } },
    });
    expect(response.statusCode).toBe(200);
    const body = envelope<{
      site: { settings: { routeGroups: string[] }; routesChangedAt?: number };
    }>(response.body);
    expect(body.data?.site.settings.routeGroups).toEqual([
      '/courses/:slug',
      '/learn/:course/:lesson',
    ]);
    expect(typeof body.data?.site.routesChangedAt).toBe('number');

    expectFailure(
      await harness.app.inject({
        method: 'PATCH',
        url: `/api/sites/${SITE_ID}`,
        headers: { cookie: harness.owner.cookie },
        payload: { settings: { routeGroups: ['courses/:slug'] } },
      }),
      400,
      'INVALID_BODY',
    );
    expect((await harness.store.site(SITE_ID))?.settings.routeGroups).toEqual([
      '/courses/:slug',
      '/learn/:course/:lesson',
    ]);
  });

  it('refuses a patch that would leave the site with no domain', async () => {
    expectFailure(
      await harness.app.inject({
        method: 'PATCH',
        url: `/api/sites/${SITE_ID}`,
        headers: { cookie: harness.owner.cookie },
        payload: { domains: [] },
      }),
      400,
      'INVALID_BODY',
    );
  });

  it('answers 404 for a site nobody registered and 403 for one outside the caller team', async () => {
    expectFailure(
      await harness.app.inject({
        method: 'GET',
        url: '/api/sites/s_nothing',
        headers: { cookie: harness.owner.cookie },
      }),
      404,
      'UNKNOWN_SITE',
    );

    await harness.store.createSite({
      id: 's_theirs',
      name: 'Theirs',
      domains: ['theirs.example'],
      teamId: 't_somebody_else',
      settings: (await harness.store.site(SITE_ID))!.settings,
    });
    expectFailure(
      await harness.app.inject({
        method: 'GET',
        url: '/api/sites/s_theirs',
        headers: { cookie: harness.owner.cookie },
      }),
      403,
      'SITE_FORBIDDEN',
    );
  });
});

describe('API keys', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  interface Minted {
    key: { id: string; scopes: string[] };
    once: { token: string };
  }

  it('mints a key, shows the token once, and lists it without the hash', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/keys`,
      headers: { cookie: harness.owner.cookie },
      payload: { name: 'reader', scopes: ['read:stats'] },
    });
    expect(created.statusCode).toBe(201);
    const minted = envelope<Minted>(created.body).data;
    expect(minted?.once.token.startsWith('chk_')).toBe(true);
    expect(created.body).not.toContain('keyHash');

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/keys`,
      headers: { cookie: harness.owner.cookie },
    });
    const keys = envelope<{ keys: { id: string }[] }>(listed.body).data?.keys;
    expect(keys?.map((key) => key.id)).toEqual([minted?.key.id]);
    // The token is gone for good: only its hash was kept.
    expect(listed.body).not.toContain(minted?.once.token);
    expect(listed.body).not.toContain('keyHash');
  });

  it('works as a credential for the reports it was scoped for and nothing else', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/keys`,
      headers: { cookie: harness.owner.cookie },
      payload: { name: 'reader', scopes: ['read:stats'] },
    });
    const token = envelope<Minted>(created.body).data?.once.token ?? '';

    const allowed = await harness.app.inject({
      method: 'GET',
      url: `/api/sites/${SITE_ID}/stats/aggregate?from=1758153600000&to=1758240000000`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.statusCode).toBe(200);

    expectFailure(
      await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/keys`,
        headers: { authorization: `Bearer ${token}` },
      }),
      403,
      'SCOPE_REQUIRED',
    );
  });

  // admin one POST away from anybody who can read the numbers would make the scope
  // list decoration.
  it('refuses to mint a key carrying a scope its maker does not hold', async () => {
    const editor = await harness.account({ email: 'editor@test.example', role: 'editor' });
    expectFailure(
      await harness.app.inject({
        method: 'POST',
        url: `/api/sites/${SITE_ID}/keys`,
        headers: { cookie: editor.cookie },
        payload: { name: 'sneaky', scopes: ['admin'] },
      }),
      403,
      'SCOPE_REQUIRED',
    );
  });

  it('deletes a key once and answers 404 after', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/sites/${SITE_ID}/keys`,
      headers: { cookie: harness.owner.cookie },
      payload: { name: 'reader', scopes: ['read:stats'] },
    });
    const minted = envelope<Minted>(created.body).data;
    const url = `/api/sites/${SITE_ID}/keys/${minted?.key.id}`;

    const first = await harness.app.inject({
      method: 'DELETE',
      url,
      headers: { cookie: harness.owner.cookie },
    });
    expect(first.statusCode).toBe(200);
    expectFailure(
      await harness.app.inject({ method: 'DELETE', url, headers: { cookie: harness.owner.cookie } }),
      404,
      'UNKNOWN_KEY',
    );

    // And it stops working immediately, because the principal is resolved fresh.
    expectFailure(
      await harness.app.inject({
        method: 'GET',
        url: `/api/sites/${SITE_ID}/stats/aggregate?from=1758153600000&to=1758240000000`,
        headers: { authorization: `Bearer ${minted?.once.token}` },
      }),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('refuses a key with no scope at all', async () => {
    expectFailure(
      await harness.app.inject({
        method: 'POST',
        url: `/api/sites/${SITE_ID}/keys`,
        headers: { cookie: harness.owner.cookie },
        payload: { name: 'useless', scopes: [] },
      }),
      400,
      'INVALID_BODY',
    );
  });
});
