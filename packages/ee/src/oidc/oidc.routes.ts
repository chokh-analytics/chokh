import { timingSafeEqual } from 'node:crypto';

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteShorthandOptions,
} from 'fastify';
import {
  acceptInvitation,
  attachPrincipal,
  attempt,
  clearCookie,
  fail,
  isSsoManaged,
  lookupInvitation,
  ok,
  readCookie,
  recordAccessChange,
  requirePerson,
  requirePrincipal,
  requireThisDashboard,
  safeNextPath,
  startSession,
  wantsHtml,
  writeCookie,
  type ApiDeps,
} from '@chokh/server';
import type { AccessScope, StoredUser } from '@chokh/store';
import { z } from 'zod';

import type { OidcEnv } from '../license/env.js';
import { requireLicense } from '../license/guard.js';
import type { LicenseState } from '../license/state.js';
import { OidcError, createOidcClient, type OidcClient, type OidcFlow, type OidcIdentity } from './client.js';

// Signing in through an OpenID Connect provider (AN-TEAM01).
//
// Who somebody is here is the pair the provider vouches for: its issuer and
// its subject for the person. **Never the address in the token, verified or
// not.** Several providers send no `email_verified`, some let a person edit
// their address, and an account found by address is how one tenant's user
// becomes another install's owner. So a pair nobody here is connected to
// signs in nobody and makes nothing, with two exceptions that are both
// somebody's own act: an account connects itself from inside its own session,
// and somebody arriving with an invitation is made the account the invitation
// is for.
//
// The browser is sent away and comes back, and what ties the return to the
// departure is a cookie: sealed (lib/seal.ts in the core), httpOnly, ten
// minutes, sent to the callback's path and nowhere else. A start that a
// browser says another site began is not a departure at all. It holds the state
// the provider must echo, the nonce the ID token must carry, the PKCE
// verifier the code is exchanged with, and what the flow is for. A callback
// that arrives in a browser that did not begin a flow has no such cookie and
// is refused before anything is asked of the provider: that, and not a
// header, is what protects a GET that ends in a session. The state is spent
// when it is used, so a callback replayed in the same browser is refused too.
//
// The password route is not touched by anything here. A team that has an
// owner with a password keeps one (the core's rule), so a provider that is
// down, or a key that has lapsed, locks out nobody who has a password.

export const OIDC_FEATURE = 'oidc';

const FLOW_COOKIE = 'chokh_oidc';
const CALLBACK_PATH = '/api/ee/oidc/callback';
const FLOW_MS = 10 * 60 * 1000;
const SEAL_PURPOSE = 'oidc flow';

const CALLBACK_ROUTE = 'GET /api/ee/oidc/callback';
const UNLINK_ROUTE = 'DELETE /api/ee/oidc/identity';

type Intent = 'signin' | 'link' | 'invite';

interface Flow extends OidcFlow {
  intent: Intent;
  // For a link: the account that began it, which has to be the one signed in
  // when the browser comes back.
  uid?: string;
  // For an invitation: its token, which is why the cookie is sealed and not
  // only signed.
  token?: string;
  // For a sign-in: where in this dashboard the person was going.
  next?: string;
}

const flowSchema = z.object({
  state: z.string().min(20),
  nonce: z.string().min(20),
  verifier: z.string().min(20),
  intent: z.enum(['signin', 'link', 'invite']),
  uid: z.string().optional(),
  token: z.string().optional(),
  next: z.string().optional(),
});

const callbackSchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
});

const inviteSchema = z.object({ token: z.string().min(20).max(200) });

export interface OidcRouteDeps {
  // Null when the install is not configured for it.
  config: OidcEnv | null;
  // A client to use in place of one built from the configuration, for a test
  // that wants to stand between this and the provider.
  client?: OidcClient;
}

// How many times a minute one address may begin a sign-in here, and come back
// from one. A count of this feature's own, never the password route's: a
// start is a GET that any page can make a browser send, and it must not be
// able to use up the attempts somebody has left to sign in with a password.
// Sized for an office behind one address at nine in the morning: a sign-in is
// two counts, so this is thirty people a minute.
export const OIDC_ATTEMPTS = 60;
const BUCKET = 'oidc';

// A request the browser says another site began. A browser sends the header
// to https and to localhost; a program sends none, and so does a browser on
// plain http, which the core's own rule says the same of.
function fromAnotherSite(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

// These two routes are logged by their path alone. The line Fastify writes
// for a request carries its address, query and all, and here the query holds
// what a provider sent back (a code and a state) and where somebody was
// going. A code is spent and useless without the verifier, so this is not a
// way in; it is still nothing a log should keep.
const pathOnly = {
  // What Fastify's own line says of a request, with the query taken off.
  req(request: FastifyRequest): Record<string, unknown> {
    return {
      method: request.method,
      url: request.url.split('?')[0],
      host: request.host,
      remoteAddress: request.ip,
      remotePort: request.socket.remotePort,
    };
  },
};
// The framework takes serializers for one route, and its types say so for a
// plugin and not for a route, so the option is typed here.
const QUIET = { logSerializers: pathOnly } as RouteShorthandOptions;

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A browser is sent to the sign-in page with the reason in the query string,
// the way the SSO exchange does it; a program gets the envelope.
function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  request.log.warn({ code }, 'oidc sign-in refused');
  if (wantsHtml(request.headers.accept)) {
    return reply.code(303).redirect(`/login?sso=${encodeURIComponent(code)}`, 303);
  }
  return reply.code(status).send(fail(code, message));
}

const OFF = 'Signing in through an identity provider is not switched on for this install';

export function registerOidcRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
  state: LicenseState,
  oidc: OidcRouteDeps,
): void {
  const auth = { store: deps.store, session: deps.session, now: deps.now };
  const store = deps.store;
  const sealer = deps.seal(SEAL_PURPOSE);
  const config = oidc.config;
  const client = config === null ? null : (oidc.client ?? createOidcClient(config, deps.now));

  // Switched on by configuration and a licence, both, every time it is
  // asked: a key that runs out switches it off without a restart.
  const live = (): OidcClient | null =>
    client !== null && state.allows(OIDC_FEATURE, Date.now()).ok ? client : null;

  async function depart(reply: FastifyReply, flow: Omit<Flow, keyof OidcFlow>): Promise<string> {
    const provider = live();
    if (provider === null) {
      throw new OidcError('OIDC_UNAVAILABLE', OFF);
    }
    const begun = await provider.begin();
    writeCookie(deps, reply, FLOW_COOKIE, sealer.seal({ ...begun.flow, ...flow }, FLOW_MS, deps.now()), {
      path: CALLBACK_PATH,
      maxAgeSeconds: FLOW_MS / 1000,
    });
    return begun.url;
  }

  // Which logs an account's own act is written to: every team it is in, or,
  // for somebody who holds roles on single sites only, those sites.
  async function logsOf(userId: string): Promise<AccessScope[]> {
    const teams = await store.teamsForUser(userId);
    if (teams.length > 0) {
      return teams.map((team) => ({ kind: 'team' as const, id: team.id }));
    }
    return (await store.siteGrantsForUser(userId)).map((row) => ({ kind: 'site' as const, id: row.siteId }));
  }

  async function recordLink(
    user: Pick<StoredUser, 'id' | 'email'>,
    action: 'identity:link' | 'identity:unlink',
    route: string,
    issuer: string,
    scopes?: AccessScope[],
  ): Promise<void> {
    for (const scope of scopes ?? (await logsOf(user.id))) {
      await recordAccessChange(store, {
        scope,
        actor: { kind: 'session', id: user.id, email: user.email },
        action,
        route,
        target: user.id,
        // The issuer and never the subject: which provider, not who there.
        fields: [`issuer: ${issuer}`],
        at: deps.now(),
      });
    }
  }

  // Whether the sign-in page draws the button. Public, and says one thing:
  // on or off. Not why, which is nobody's business who is not signed in.
  app.get('/api/ee/oidc', () => ok({ enabled: live() !== null }));

  // Send the browser to the provider to sign in.
  //
  // From this dashboard, or typed: a start that the browser says another
  // site began begins nothing. No flow, no cookie, and no count against the
  // address, so a page elsewhere cannot spend this address's sign-ins by
  // pointing a browser here. The person is sent to the sign-in page, where
  // the button is.
  app.get(
    '/api/ee/oidc/start',
    QUIET,
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (live() === null) {
        return refuse(request, reply, 404, 'OIDC_OFF', OFF);
      }
      if (fromAnotherSite(request)) {
        if (wantsHtml(request.headers.accept)) {
          return reply.code(303).redirect('/login', 303);
        }
        return reply
          .code(403)
          .send(fail('CROSS_SITE_REQUEST', 'A sign-in is begun from this dashboard'));
      }
      if (!deps.attempts.count(request, BUCKET, OIDC_ATTEMPTS)) {
        return refuse(request, reply, 429, 'RATE_LIMITED', 'Too many sign-ins from this address, wait a minute');
      }
      const next = safeNextPath((request.query as { next?: unknown }).next);
      try {
        const url = await depart(reply, { intent: 'signin', ...(next === undefined ? {} : { next }) });
        return await reply.code(302).redirect(url, 302);
      } catch (error) {
        if (error instanceof OidcError) {
          return refuse(request, reply, 502, error.code, error.message);
        }
        throw error;
      }
    },
  );

  // Connect the account that is signed in to an identity at the provider. A
  // POST, so it is held to coming from this dashboard like every change a
  // session makes: nobody's account is connected because a page elsewhere
  // sent their browser here. Answers where to send the browser.
  app.post(
    '/api/ee/oidc/link',
    { preHandler: [requirePrincipal(auth), requirePerson(), requireLicense(state, OIDC_FEATURE)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal;
      if (principal === null) {
        return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
      }
      if (live() === null) {
        return reply.code(404).send(fail('OIDC_OFF', OFF));
      }
      // An account another application signs in is that application's.
      if (isSsoManaged(principal.id)) {
        return reply
          .code(409)
          .send(fail('MANAGED_BY_SSO', 'That account is signed in by another application'));
      }
      try {
        return await reply.send(ok({ url: await depart(reply, { intent: 'link', uid: principal.id }) }));
      } catch (error) {
        if (error instanceof OidcError) {
          return reply.code(502).send(fail(error.code, error.message));
        }
        throw error;
      }
    },
  );

  // Use an invitation by signing in at the provider, in place of choosing a
  // password. The token arrives in a body, as it does everywhere, and is
  // looked up before the browser is sent anywhere, so a link that would be
  // refused is refused here. Limited by address on the invitation count.
  app.post(
    '/api/ee/oidc/invite',
    { preHandler: [requireThisDashboard(), deps.attempts.invitation] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (live() === null) {
        return reply.code(404).send(fail('OIDC_OFF', OFF));
      }
      const parsed = inviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(fail('INVALID_BODY', 'A token is required', { fields: ['token'] }));
      }
      const found = await lookupInvitation(deps, parsed.data.token);
      if (!found.ok) {
        return reply.code(found.status).send(fail(found.code, found.message));
      }
      try {
        return await reply.send(
          ok({ url: await depart(reply, { intent: 'invite', token: parsed.data.token }) }),
        );
      } catch (error) {
        if (error instanceof OidcError) {
          return reply.code(502).send(fail(error.code, error.message));
        }
        throw error;
      }
    },
  );

  // Where the provider sends the browser back.
  app.get(
    CALLBACK_PATH,
    { ...QUIET, preHandler: attachPrincipal(auth) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const provider = live();
      if (provider === null || config === null) {
        return refuse(request, reply, 404, 'OIDC_OFF', OFF);
      }
      // The flow this browser began. Read once and taken away whatever
      // happens next: a flow is one departure and one return.
      const opened = flowSchema.safeParse(sealer.open(readCookie(request, FLOW_COOKIE), deps.now()));
      clearCookie(reply, FLOW_COOKIE, CALLBACK_PATH);
      const query = callbackSchema.safeParse(request.query);
      if (
        !opened.success ||
        !query.success ||
        query.data.state === undefined ||
        !sameText(query.data.state, opened.data.state)
      ) {
        // No flow began in this browser, or it is not this one.
        return refuse(request, reply, 400, 'OIDC_STATE', 'That sign-in did not begin in this browser');
      }
      const flow: Flow = opened.data;
      // Counted here and not before. A return this browser never began was
      // refused above and cost the address nothing; from here on the provider
      // is about to be asked, and how often one address may make that happen
      // is what the count bounds.
      if (!deps.attempts.count(request, BUCKET, OIDC_ATTEMPTS)) {
        return refuse(request, reply, 429, 'RATE_LIMITED', 'Too many sign-ins from this address, wait a minute');
      }
      if (query.data.error !== undefined || query.data.code === undefined) {
        return refuse(request, reply, 400, 'OIDC_DENIED', 'The identity provider did not sign anybody in');
      }
      // Spent, for as long as the flow could still be alive.
      if (!(await deps.once.claim(`oidc:${flow.state}`, FLOW_MS))) {
        return refuse(request, reply, 400, 'OIDC_REPLAYED', 'That sign-in has already been used');
      }

      let identity: OidcIdentity;
      try {
        identity = await provider.finish(query.data.code, flow);
      } catch (error) {
        if (error instanceof OidcError) {
          return refuse(request, reply, error.code === 'OIDC_UNAVAILABLE' ? 502 : 401, error.code, error.message);
        }
        throw error;
      }
      const known = await store.userByIdentity(identity.issuer, identity.subject);

      if (flow.intent === 'link') {
        // The session is asked again now, on the return: the account that
        // began this has to be the one signed in, still.
        const principal = request.principal;
        if (principal === null || principal.kind !== 'session' || principal.id !== flow.uid) {
          return refuse(request, reply, 401, 'OIDC_SESSION_CHANGED', 'Sign in again, then connect the account');
        }
        if (known !== null && known.id !== principal.id) {
          return refuse(request, reply, 409, 'IDENTITY_TAKEN', 'Another account already signs in by that identity');
        }
        if (known === null) {
          const linked = await attempt(() =>
            store.linkIdentity({
              issuer: identity.issuer,
              subject: identity.subject,
              userId: principal.id,
              linkedAt: deps.now(),
            }),
          );
          if (!linked.ok) {
            return refuse(request, reply, linked.status, linked.code, linked.message);
          }
          await recordLink(
            { id: principal.id, email: principal.email ?? '' },
            'identity:link',
            CALLBACK_ROUTE,
            identity.issuer,
          );
        }
        return reply.code(303).redirect('/', 303);
      }

      if (flow.intent === 'invite' && flow.token !== undefined) {
        const accepted = await acceptInvitation(deps, {
          token: flow.token,
          // Somebody already connected accepts as that account, and the
          // core's rule decides whether the invitation is theirs. Nobody
          // connected is made the account the invitation is for.
          sessionUserId: known?.id ?? null,
          ...(known === null
            ? { identity: { issuer: identity.issuer, subject: identity.subject } }
            : {}),
          ...(identity.name === undefined ? {} : { name: identity.name }),
          route: CALLBACK_ROUTE,
        });
        if (!accepted.ok) {
          return refuse(request, reply, accepted.status, accepted.code, accepted.message);
        }
        if (accepted.created) {
          await recordLink(accepted.user, 'identity:link', CALLBACK_ROUTE, identity.issuer, [accepted.scope]);
        }
        startSession(deps, reply, accepted.user);
        return reply
          .code(303)
          .redirect(accepted.scope.kind === 'site' ? `/${accepted.scope.id}` : '/', 303);
      }

      // A plain sign-in. Nobody connected to this identity is nobody: no
      // account is found by the address the token carries, and none is made.
      if (known === null) {
        return refuse(
          request,
          reply,
          403,
          'OIDC_UNKNOWN_IDENTITY',
          'No account here is connected to that sign-in',
        );
      }
      startSession(deps, reply, known);
      return reply.code(303).redirect(flow.next ?? '/', 303);
    },
  );

  // Whether the account signed in is connected, and whether it could be
  // disconnected.
  //
  // These two ask for no licence. Reading one's own connection, and taking
  // away a way in to one's own account, are not the paid thing: a key that
  // lapsed takes nothing away, and that includes being able to shut a door.
  app.get(
    '/api/ee/oidc/identity',
    { preHandler: [requirePrincipal(auth), requirePerson()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal;
      if (principal === null) {
        return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
      }
      const [user, identities] = await Promise.all([
        store.userById(principal.id),
        store.identitiesForUser(principal.id),
      ]);
      return reply.send(
        ok({
          enabled: live() !== null,
          connected: identities.length > 0,
          // An account with no password has no other way in.
          canDisconnect: identities.length > 0 && user?.passwordHash !== undefined,
        }),
      );
    },
  );

  // Disconnect. Refused when it is the account's only way in: an account
  // with no password that gave up its identity could never be entered again.
  app.delete(
    '/api/ee/oidc/identity',
    { preHandler: [requirePrincipal(auth), requirePerson()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal;
      if (principal === null) {
        return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
      }
      const [user, identities] = await Promise.all([
        store.userById(principal.id),
        store.identitiesForUser(principal.id),
      ]);
      if (identities.length === 0) {
        return reply.code(404).send(fail('NOT_CONNECTED', 'This account is not connected to an identity'));
      }
      if (user === null || user.passwordHash === undefined) {
        return reply
          .code(409)
          .send(
            fail(
              'ONLY_WAY_IN',
              'This account has no password, so that identity is its only way in and stays connected',
            ),
          );
      }
      for (const identity of identities) {
        if (await store.unlinkIdentity(principal.id, identity.issuer)) {
          await recordLink(user, 'identity:unlink', UNLINK_ROUTE, identity.issuer);
        }
      }
      return reply.send(ok({ connected: false }));
    },
  );
}
