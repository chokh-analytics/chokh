import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SignJWT, exportJWK, exportSPKI, generateKeyPair, type CryptoKey, type JWK } from 'jose';

// An OpenID Connect provider that lives inside a test.
//
// On a loopback port, with keys made for the run: discovery, keys, authorize
// and token, which is all a sign-in asks of a provider. No real provider is
// contacted by any test and no account exists anywhere outside the process.
//
// It is a provider that can be told to lie, because what is being tested is
// whether the other side believes it: about who issued a token, who it is
// for, which sign-in it answers, when it expires, how it is signed, and with
// which key.

export type Lie =
  | 'issuer'
  | 'audience'
  | 'party'
  | 'nonce'
  | 'expired'
  | 'future'
  // `alg: none`, with no signature at all.
  | 'unsigned'
  // HS256, with this provider's own public key as the shared secret.
  | 'hmac'
  // The right key id, signed by a key nobody published.
  | 'wrong-key'
  // A key id nobody published.
  | 'unknown-key'
  | 'no-subject';

interface Pair {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JWK;
}

interface Granted {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
}

export interface TestProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  // Who the next sign-in is, as the provider knows them.
  subject: string;
  email: string;
  name: string | undefined;
  lie: Lie | null;
  // What discovery says the issuer is, when it should say something else.
  discoveryIssuer: string | null;
  // Whether a browser arriving to sign in is shown a page with a link to
  // press, as a real provider shows its form, or is sent straight back.
  page: boolean;
  calls: { discovery: number; keys: number; token: number };
  // Every body the token endpoint was sent, to see what came with a code.
  tokenRequests: { authorization: string | undefined; form: URLSearchParams }[];
  // What the browser does at the provider: takes the address it was sent to,
  // signs the person in, and comes back with where it is being sent next.
  authorize(url: string): string;
  // A new signing key, with a new id. The old one is no longer published.
  rotate(): Promise<void>;
  close(): Promise<void>;
}

async function pair(): Promise<Pair> {
  const made = await generateKeyPair('RS256', { extractable: true });
  const kid = randomBytes(6).toString('hex');
  return {
    kid,
    privateKey: made.privateKey,
    publicKey: made.publicKey,
    jwk: { ...(await exportJWK(made.publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    request.on('end', () => resolve(text));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startProvider(
  options: { now?: () => number; host?: string } = {},
): Promise<TestProvider> {
  const now = options.now ?? Date.now;
  let signing = await pair();
  const stranger = await pair();
  const codes = new Map<string, Granted>();
  const clientId = 'chokh-test-client';
  // Invented for the run, like the keys.
  const clientSecret = `test-secret-${randomBytes(12).toString('hex')}`;

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://${options.host ?? '127.0.0.1'}:${port}`;

  async function idToken(granted: Granted): Promise<string> {
    const at = Math.floor(now() / 1000);
    const lie = provider.lie;
    const claims: Record<string, unknown> = {
      iss: lie === 'issuer' ? 'https://somebody-else.example' : issuer,
      aud: lie === 'audience' ? 'another-client' : granted.clientId,
      nonce: lie === 'nonce' ? 'a-nonce-from-another-sign-in' : granted.nonce,
      iat: lie === 'future' ? at + 3600 : lie === 'expired' ? at - 7200 : at,
      exp: lie === 'expired' ? at - 3600 : at + 300,
      email: provider.email,
      email_verified: true,
      ...(provider.name === undefined ? {} : { name: provider.name }),
      ...(lie === 'no-subject' ? {} : { sub: provider.subject }),
      ...(lie === 'party' ? { azp: 'another-client' } : {}),
    };
    if (lie === 'unsigned') {
      const part = (value: unknown): string =>
        Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
      return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
    }
    if (lie === 'hmac') {
      // The classic confusion: the verifier is handed a public key, and a
      // token that says HS256 was made with that public key as the secret.
      const secret = new TextEncoder().encode(await exportSPKI(signing.publicKey));
      return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: signing.kid }).sign(secret);
    }
    const key = lie === 'wrong-key' || lie === 'unknown-key' ? stranger.privateKey : signing.privateKey;
    const kid = lie === 'unknown-key' ? stranger.kid : signing.kid;
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).sign(key);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      provider.calls.discovery += 1;
      return json(response, 200, {
        issuer: provider.discoveryIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/keys') {
      provider.calls.keys += 1;
      return json(response, 200, { keys: [signing.jwk] });
    }
    if (url.pathname === '/authorize') {
      const back = provider.authorize(url.toString());
      if (provider.page) {
        // A page of the provider's own, and the return is a navigation that
        // page begins: which is what makes it a request from another site.
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<!doctype html><title>A test provider</title><a id="continue" href="${back.replace(/&/g, '&amp;')}">Continue</a>`,
        );
        return undefined;
      }
      // The person is signed in already, so the browser is sent straight back.
      response.writeHead(302, { location: back });
      response.end();
      return undefined;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      provider.calls.token += 1;
      const form = new URLSearchParams(await readBody(request));
      provider.tokenRequests.push({ authorization: request.headers.authorization, form });
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        return json(response, 401, { error: 'invalid_client' });
      }
      const code = form.get('code') ?? '';
      const granted = codes.get(code);
      // Single use: taken out whether or not the rest of it is right.
      codes.delete(code);
      const verifier = form.get('code_verifier') ?? '';
      if (
        granted === undefined ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('redirect_uri') !== granted.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !== granted.challenge
      ) {
        return json(response, 400, { error: 'invalid_grant' });
      }
      return json(response, 200, {
        access_token: randomBytes(16).toString('hex'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: await idToken(granted),
      });
    }
    return json(response, 404, { error: 'not_found' });
  }

  const provider: TestProvider = {
    issuer,
    clientId,
    clientSecret,
    subject: 'provider-user-1',
    email: 'somebody@provider.example',
    name: undefined,
    lie: null,
    discoveryIssuer: null,
    page: false,
    calls: { discovery: 0, keys: 0, token: 0 },
    tokenRequests: [],
    authorize(text: string): string {
      const url = new URL(text);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (
        url.origin !== issuer ||
        url.pathname !== '/authorize' ||
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('client_id') !== clientId ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        !(url.searchParams.get('scope') ?? '').split(' ').includes('openid')
      ) {
        throw new Error(`the provider would refuse this request: ${text}`);
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: url.searchParams.get('code_challenge') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return back.toString();
    },
    async rotate(): Promise<void> {
      signing = await pair();
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
  return provider;
}
