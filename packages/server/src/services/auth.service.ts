import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { keyPrincipal, sessionPrincipal, type Principal } from '../lib/scopes.js';
import type { AccountStore, AnalyticsStore, StoredUser } from '../store/AnalyticsStore.js';
import { hashApiKey } from './keys.service.js';

// Who is asking. Two ways to answer, one currency.
//
// A person signs in with an address and a password and gets an httpOnly cookie.
// A program presents a key as a bearer token. Both become a Principal, which is
// the only thing a route ever asks about, so no route has to know which one it
// is talking to.
//
// The password hash is argon2id. The key hash is SHA-256, in keys.service.ts,
// and the reason the two differ is written there: a password is low entropy and
// needs a slow hash, a key is 256 random bits and needs an indexable one.

export const SESSION_COOKIE = 'chokh_session';

export interface AuthDeps {
  store: AnalyticsStore & AccountStore;
  session: SessionCodec;
  now(): number;
}

export function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}

// A hash of nothing anybody knows, verified against when the address does not
// exist, so a login attempt costs the same whether the account is real or not.
// Without it the response time is an account enumeration oracle: argon2 takes
// tens of milliseconds and a missing row takes none.
let decoyHash: Promise<string> | undefined;

function decoy(): Promise<string> {
  decoyHash ??= argonHash(randomBytes(32).toString('base64url'));
  return decoyHash;
}

export async function verifyPassword(stored: string | undefined, password: string): Promise<boolean> {
  const against = stored ?? (await decoy());
  let matches = false;
  try {
    matches = await argonVerify(against, password);
  } catch {
    // A hash this build cannot read is not a match. Never a 500: an unreadable
    // hash on one account would otherwise take the login route down.
    matches = false;
  }
  return stored === undefined ? false : matches;
}

// The signed cookie that is a dashboard session.
//
// There is no session row. The cookie carries the user id and an expiry, signed
// with SESSION_SECRET, and the principal behind it is read from the store on
// every request, so removing somebody from a team takes effect on their next
// request rather than when their cookie runs out. What that costs is revocation:
// "sign this person out of every browser" needs a row to invalidate, and nothing
// in this product asks for it yet. Said out loud in the server README.
export interface SessionCodec {
  issue(userId: string, now: number): { value: string; expiresAt: number };
  // The user id the cookie names, or null when it is missing, altered, or over.
  read(value: string | undefined, now: number): string | null;
  ttlMs: number;
}

interface SessionPayload {
  uid: string;
  exp: number;
}

export function createSessionCodec(secret: string, ttlMs: number): SessionCodec {
  const sign = (body: string): string =>
    createHmac('sha256', secret).update(body).digest('base64url');

  return {
    ttlMs,

    issue(userId: string, now: number): { value: string; expiresAt: number } {
      const expiresAt = now + ttlMs;
      const payload: SessionPayload = { uid: userId, exp: expiresAt };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return { value: `${body}.${sign(body)}`, expiresAt };
    },

    read(value: string | undefined, now: number): string | null {
      if (value === undefined || value === '') {
        return null;
      }
      const at = value.lastIndexOf('.');
      if (at <= 0) {
        return null;
      }
      const body = value.slice(0, at);
      const given = Buffer.from(value.slice(at + 1));
      const mine = Buffer.from(sign(body));
      if (mine.length !== given.length || !timingSafeEqual(mine, given)) {
        return null;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (typeof payload !== 'object' || payload === null) {
        return null;
      }
      const { uid, exp } = payload as Partial<SessionPayload>;
      if (typeof uid !== 'string' || typeof exp !== 'number' || exp <= now) {
        return null;
      }
      return uid;
    },
  };
}

export interface Credentials {
  cookie: string | undefined;
  authorization: string | undefined;
}

const BEARER = /^Bearer\s+(.+)$/i;

export function bearerToken(authorization: string | undefined): string | undefined {
  const found = authorization === undefined ? null : BEARER.exec(authorization);
  return found?.[1]?.trim();
}

// A key beats a cookie: a request that presents one is a program saying which
// identity it wants used, and falling back to whatever cookie the browser
// happened to send would be the confused deputy the hard way.
export async function resolvePrincipal(
  deps: AuthDeps,
  credentials: Credentials,
): Promise<Principal | null> {
  const token = bearerToken(credentials.authorization);
  if (token !== undefined) {
    const key = await deps.store.apiKeyByHash(hashApiKey(token));
    return key === null ? null : keyPrincipal(key.id, key.siteId, key.scopes);
  }

  const userId = deps.session.read(credentials.cookie, deps.now());
  if (userId === null) {
    return null;
  }
  const user = await deps.store.userById(userId);
  if (user === null) {
    // A valid cookie for an account that no longer exists. Read fresh every
    // request, which is why this is caught at all.
    return null;
  }
  const teams = await deps.store.teamsForUser(user.id);
  return sessionPrincipal(user.id, user.email, teams);
}

// Sign in, or answer null. Never says which half was wrong, and takes the same
// time either way.
export async function authenticate(
  deps: AuthDeps,
  email: string,
  password: string,
): Promise<StoredUser | null> {
  const user = await deps.store.userByEmail(email);
  const matches = await verifyPassword(user?.passwordHash, password);
  if (!matches || user === null) {
    return null;
  }
  await deps.store.updateUser(user.id, { lastLoginAt: deps.now() });
  return user;
}
