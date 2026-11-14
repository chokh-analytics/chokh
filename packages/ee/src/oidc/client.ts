import { createHash, randomBytes } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type RemoteJWKSet } from 'jose';

import type { OidcEnv } from '../license/env.js';

// The other end of an OpenID Connect sign-in: finding the provider's
// endpoints, sending a browser to it, exchanging the code it comes back with,
// and deciding whether the ID token that answers is to be believed.
//
// The parts of this protocol that are easy to get wrong are the ones that
// decide who somebody is, so they are not written here: the signature, the
// key lookup and its rotation, and the claims a token must carry are checked
// by `jose`. What is written here is what is told to it, and each line of
// that is a known way in when it is left out:
//
// - an allow-list of asymmetric algorithms, so a token that says `none`, or
//   that says HS256 and was "signed" with this provider's public key as the
//   secret, is refused whatever its own header claims;
// - the issuer, which has to be the one configured, and the one the
//   provider's own discovery document declares;
// - the audience, which has to be this install's client id, and the
//   authorized party when a token names one or has several audiences;
// - the nonce this browser was sent away with;
// - the expiry and the issue time, with a minute for two clocks to differ:
//   not expired, not issued in the future, and not older than ten minutes.
//
// Everything is fetched over https, the provider's keys included. Plain http
// is taken for a loopback address only, which is what a test on one machine
// uses and nothing a provider on the internet can be.

export const ASYMMETRIC_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

// How long the provider's endpoints are remembered before they are read
// again, and how long any one request to it may take.
const DISCOVERY_MS = 10 * 60 * 1000;
const REQUEST_MS = 5_000;
const CLOCK_TOLERANCE_S = 60;
const MAX_TOKEN_AGE_S = 10 * 60;

export type OidcFailure =
  // The provider could not be reached, or what it published is not usable.
  | 'OIDC_UNAVAILABLE'
  // It refused the code: used before, not for this client, no verifier.
  | 'OIDC_EXCHANGE'
  // The ID token is not to be believed.
  | 'OIDC_TOKEN';

export class OidcError extends Error {
  readonly code: OidcFailure;

  constructor(code: OidcFailure, message: string) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

// Who a provider says somebody is. Only the pair of issuer and subject is who
// they are; the address and the name are what the provider calls them, and
// are never used to find an account.
export interface OidcIdentity {
  issuer: string;
  subject: string;
  name?: string;
}

export interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
}

export interface OidcClient {
  // A fresh state, nonce and verifier, and where to send the browser.
  begin(): Promise<{ flow: OidcFlow; url: string }>;
  // The code for an ID token, checked. Throws an OidcError.
  finish(code: string, flow: OidcFlow): Promise<OidcIdentity>;
  readonly redirectUri: string;
}

interface Discovered {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  basicAuth: boolean;
  keys: RemoteJWKSet;
  at: number;
}

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// https, or http on this machine. Anything else is not somewhere a secret or
// a decision about who somebody is may travel.
export function allowedEndpoint(text: unknown): URL | null {
  if (typeof text !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && loopback(url.hostname) ? url : null;
}

function random(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createOidcClient(config: OidcEnv, now: () => number = Date.now): OidcClient {
  const redirectUri = `${config.publicUrl}/api/ee/oidc/callback`;
  let known: Discovered | null = null;

  async function ask(url: URL, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        // A redirect is never followed: an endpoint that moves is a provider
        // to look at, not a location to trust.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_MS),
      });
    } catch {
      throw new OidcError('OIDC_UNAVAILABLE', 'The identity provider did not answer');
    }
  }

  async function discover(): Promise<Discovered> {
    if (known !== null && now() - known.at < DISCOVERY_MS) {
      return known;
    }
    const where = allowedEndpoint(`${config.issuer}/.well-known/openid-configuration`);
    if (where === null) {
      throw new OidcError('OIDC_UNAVAILABLE', 'The issuer has to be an https address');
    }
    const response = await ask(where, { headers: { accept: 'application/json' } });
    if (response.status !== 200) {
      throw new OidcError('OIDC_UNAVAILABLE', 'The identity provider published no configuration');
    }
    let document: Record<string, unknown>;
    try {
      document = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new OidcError('OIDC_UNAVAILABLE', 'The identity provider published no configuration');
    }
    // What it says it is has to be what this install was told it is. A
    // document that names another issuer is another provider answering.
    if (document['issuer'] !== config.issuer) {
      throw new OidcError('OIDC_UNAVAILABLE', 'The identity provider names a different issuer');
    }
    const authorization = allowedEndpoint(document['authorization_endpoint']);
    const token = allowedEndpoint(document['token_endpoint']);
    const jwks = allowedEndpoint(document['jwks_uri']);
    if (authorization === null || token === null || jwks === null) {
      throw new OidcError('OIDC_UNAVAILABLE', 'The identity provider published no usable endpoints');
    }
    const methods = document['token_endpoint_auth_methods_supported'];
    known = {
      authorizationEndpoint: authorization.toString(),
      tokenEndpoint: token.toString(),
      // The specification's default when a provider lists none.
      basicAuth: !Array.isArray(methods) || methods.includes('client_secret_basic'),
      // Rotation is the library's: a key id it has not seen makes it read the
      // set again, at most once in thirty seconds, so a rotated key works on
      // the next sign-in and a made-up key id cannot be used to make this
      // server hammer the provider.
      keys: createRemoteJWKSet(jwks, { timeoutDuration: REQUEST_MS, cooldownDuration: 30_000 }),
      at: now(),
    };
    return known;
  }

  return {
    redirectUri,

    async begin() {
      const provider = await discover();
      const flow: OidcFlow = { state: random(), nonce: random(), verifier: random() };
      const url = new URL(provider.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'openid profile email');
      url.searchParams.set('state', flow.state);
      url.searchParams.set('nonce', flow.nonce);
      url.searchParams.set('code_challenge', challengeOf(flow.verifier));
      url.searchParams.set('code_challenge_method', 'S256');
      return { flow, url: url.toString() };
    },

    async finish(code: string, flow: OidcFlow): Promise<OidcIdentity> {
      const provider = await discover();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: flow.verifier,
      });
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      };
      if (provider.basicAuth) {
        const pair = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
        headers['authorization'] = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
      } else {
        form.set('client_id', config.clientId);
        form.set('client_secret', config.clientSecret);
      }
      const response = await ask(new URL(provider.tokenEndpoint), {
        method: 'POST',
        headers,
        body: form.toString(),
      });
      let answer: Record<string, unknown> = {};
      try {
        answer = (await response.json()) as Record<string, unknown>;
      } catch {
        // Left empty: the check below refuses it.
      }
      const idToken = answer['id_token'];
      if (response.status !== 200 || typeof idToken !== 'string') {
        throw new OidcError('OIDC_EXCHANGE', 'The identity provider refused the code');
      }

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, provider.keys, {
          algorithms: [...ASYMMETRIC_ALGORITHMS],
          issuer: config.issuer,
          audience: config.clientId,
          clockTolerance: CLOCK_TOLERANCE_S,
          // The issue time is only looked at when a token is given an age it
          // may not exceed. With one, a token issued in the future is refused
          // as well as an old one; a token just exchanged for a code is
          // seconds old.
          maxTokenAge: MAX_TOKEN_AGE_S,
          requiredClaims: ['sub', 'exp', 'iat'],
          currentDate: new Date(now()),
        }));
      } catch {
        // One answer whatever was wrong with it: which check a forged token
        // failed is not something to tell whoever forged it.
        throw new OidcError('OIDC_TOKEN', 'The identity provider sent a token that cannot be believed');
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      const party = payload['azp'];
      if (
        typeof payload.sub !== 'string' ||
        payload.sub === '' ||
        payload['nonce'] !== flow.nonce ||
        (party !== undefined && party !== config.clientId) ||
        (audiences.length > 1 && party !== config.clientId)
      ) {
        throw new OidcError('OIDC_TOKEN', 'The identity provider sent a token that cannot be believed');
      }
      const name = payload['name'];
      return {
        issuer: config.issuer,
        subject: payload.sub,
        ...(typeof name === 'string' && name !== '' ? { name: name.slice(0, 120) } : {}),
      };
    },
  };
}
