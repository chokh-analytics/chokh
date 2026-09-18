import { defaultSiteSettings, type Site } from '@chokh/store';
import { describe, expect, it } from 'vitest';

import { signUserId } from '../lib/identity-signature.js';
import type { CollectBatch } from '../schemas/collect.schema.js';
import { confirmIdentity } from './identity.js';

// A placeholder, never a real key: no secret belongs in this repository.
const SECRET = 'test-secret-not-a-real-key';

function site(over: Partial<Site['settings']> = {}): Site {
  return {
    id: 'site_1',
    name: 'Fixture',
    domains: ['fixture.test'],
    settings: defaultSiteSettings(over),
  };
}

function batch(over: Partial<CollectBatch> = {}): CollectBatch {
  return {
    siteId: 'site_1',
    sentAt: 1,
    hostname: 'fixture.test',
    events: [{ type: 'pageview', ts: 1, path: '/home' }],
    ...over,
  };
}

describe('confirmIdentity', () => {
  it('says anonymous when the batch names nobody', () => {
    expect(confirmIdentity(site(), batch())).toEqual({ kind: 'anonymous' });
  });

  it('takes an unsigned identify on a site that allows one, which is the default', () => {
    expect(defaultSiteSettings().allowUnsignedIdentify).toBe(true);
    expect(confirmIdentity(site(), batch({ userId: 'u_rafi' }))).toEqual({
      kind: 'confirmed',
      userId: 'u_rafi',
    });
  });

  it('refuses an unsigned identify on a site that does not', () => {
    const verdict = confirmIdentity(
      site({ allowUnsignedIdentify: false, identifySecret: SECRET }),
      batch({ userId: 'u_rafi' }),
    );
    expect(verdict).toEqual({ kind: 'refused', userId: 'u_rafi', reason: 'unsigned' });
  });

  it('takes a signature the site issued, whatever the setting says', () => {
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    const strict = site({ allowUnsignedIdentify: false, identifySecret: SECRET });
    expect(confirmIdentity(strict, batch({ userId: 'u_rafi', sig }))).toEqual({
      kind: 'confirmed',
      userId: 'u_rafi',
    });
  });

  it('refuses a signature that does not check out, even where unsigned is allowed', () => {
    // An absent signature is a site that never signs. A wrong one is somebody
    // trying, and the permissive setting is not an excuse to wave it through.
    const permissive = site({ identifySecret: SECRET });
    expect(permissive.settings.allowUnsignedIdentify).toBe(true);
    const verdict = confirmIdentity(
      permissive,
      batch({ userId: 'u_rafi', sig: 'not-the-signature' }),
    );
    expect(verdict).toEqual({ kind: 'refused', userId: 'u_rafi', reason: 'bad_signature' });
  });

  it('refuses a signature the site has no secret to check', () => {
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    const verdict = confirmIdentity(site(), batch({ userId: 'u_rafi', sig }));
    expect(verdict).toMatchObject({ kind: 'refused', reason: 'bad_signature' });
  });

  it('will not let one person borrow another signature', () => {
    const sig = signUserId(SECRET, 'site_1', 'u_rafi');
    const strict = site({ allowUnsignedIdentify: false, identifySecret: SECRET });
    expect(confirmIdentity(strict, batch({ userId: 'u_mim', sig }))).toMatchObject({
      kind: 'refused',
      userId: 'u_mim',
    });
  });

  it('finds the identity on the identify event when the batch carries none', () => {
    // sdk-node posts a batch rather than a page's context, so the userId can
    // arrive on the event instead of beside it.
    const verdict = confirmIdentity(
      site(),
      batch({ events: [{ type: 'identify', ts: 1, userId: 'u_rafi' }] }),
    );
    expect(verdict).toEqual({ kind: 'confirmed', userId: 'u_rafi' });
  });
});
