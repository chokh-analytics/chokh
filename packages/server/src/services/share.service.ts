import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AccountStore, Site, SiteShare } from '../store/AnalyticsStore.js';
import { hashPassword } from './auth.service.js';

// A site's public share (AN-RPT01): one link per site, an optional password,
// and a cookie that remembers the password was given.
//
// The token is the link and the link is what the owner meant to hand out, so
// it is stored as it is: regenerating it is the revocation, and there is no
// second secret to lose. The password, when there is one, is argon2 like an
// account's. The cookie is signed over the token and over the password's
// hash, so a regenerated link and a changed password each end every reader
// at once without a list of who was let in.

export const SHARE_COOKIE = 'chokh_share';
export const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface PublicShare {
  token: string;
  protected: boolean;
  createdAt: number;
}

export function publicShare(share: SiteShare): PublicShare {
  return { token: share.token, protected: share.passwordHash !== undefined, createdAt: share.createdAt };
}

export interface ShareInput {
  // A new token, which ends the old link.
  regenerate?: boolean;
  // A password to set, null to clear it, absent to leave it.
  password?: string | null;
}

export async function setShare(
  store: AccountStore,
  site: Site,
  input: ShareInput,
  by: string,
  now: number,
): Promise<Site> {
  const existing = site.share;
  const token = existing === undefined || input.regenerate === true ? newShareToken() : existing.token;
  const passwordHash =
    input.password === undefined
      ? existing?.passwordHash
      : input.password === null
        ? undefined
        : await hashPassword(input.password);
  const share: SiteShare = {
    token,
    ...(passwordHash === undefined ? {} : { passwordHash }),
    createdBy: existing?.createdBy ?? by,
    createdAt: existing?.createdAt ?? now,
  };
  return store.updateSite(site.id, { share });
}

export function clearShare(store: AccountStore, siteId: string): Promise<Site> {
  return store.updateSite(siteId, { share: null });
}

// The cookie a reader holds after the password: the token, a digest of the
// password's hash and an expiry, signed. Reading it needs the share it was
// issued for, so a cookie for one link never opens another and a cookie
// issued before the password changed is a cookie for nothing.
export interface ShareCodec {
  issue(share: SiteShare, now: number): { value: string; expiresAt: number };
  read(value: string | undefined, share: SiteShare, now: number): boolean;
}

interface SharePayload {
  t: string;
  p: string;
  exp: number;
}

function digestOf(passwordHash: string | undefined): string {
  return createHash('sha256')
    .update(passwordHash ?? '')
    .digest('base64url');
}

export function createShareCodec(secret: string): ShareCodec {
  const sign = (body: string): string =>
    createHmac('sha256', secret).update(body).digest('base64url');

  return {
    issue(share: SiteShare, now: number): { value: string; expiresAt: number } {
      const expiresAt = now + SHARE_TTL_MS;
      const payload: SharePayload = { t: share.token, p: digestOf(share.passwordHash), exp: expiresAt };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return { value: `${body}.${sign(body)}`, expiresAt };
    },

    read(value: string | undefined, share: SiteShare, now: number): boolean {
      if (value === undefined || value === '') {
        return false;
      }
      const dot = value.indexOf('.');
      if (dot <= 0) {
        return false;
      }
      const body = value.slice(0, dot);
      const presented = Buffer.from(value.slice(dot + 1));
      const expected = Buffer.from(sign(body));
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return false;
      }
      let payload: SharePayload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SharePayload;
      } catch {
        return false;
      }
      return (
        payload.t === share.token &&
        payload.p === digestOf(share.passwordHash) &&
        typeof payload.exp === 'number' &&
        payload.exp > now
      );
    },
  };
}
