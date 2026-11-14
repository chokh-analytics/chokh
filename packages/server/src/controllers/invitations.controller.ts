import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { startSession } from '../lib/session-cookie.js';
import type { Principal } from '../lib/scopes.js';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  lookupInvitationSchema,
} from '../schemas/accounts.schema.js';
import { actorOf } from '../services/audit.service.js';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  lookupInvitation,
  revokeInvitation,
} from '../services/invitations.service.js';
import type { AccessScope } from '../store/AnalyticsStore.js';
import { publicUser } from './accounts.controller.js';
import { ownedTeam } from './members.controller.js';

// Invitations over HTTP (AN-TEAM01): sending one, listing what is waiting,
// taking one back, and the two routes somebody holding a link uses.
//
// Who may send: to a team, a person who owns it; to one site, a person who
// holds admin on it. Each is checked before the body is read. The two routes
// a link's holder uses need no session, because the person may have no
// account yet, and are limited by address like signing in.
//
// The token leaves this file exactly once, in the answer to the request that
// made the invitation, in a field called once. It arrives back only in a
// request body. It is never in a path or a query, where a log would keep it.

const TEAM_CREATE = 'POST /api/teams/:teamId/invitations';
const TEAM_REVOKE = 'DELETE /api/teams/:teamId/invitations/:invitationId';
const SITE_CREATE = 'POST /api/sites/:siteId/invitations';
const SITE_REVOKE = 'DELETE /api/sites/:siteId/invitations/:invitationId';
const ACCEPT = 'POST /api/invitations/accept';

// Where the page that uses a link lives. A path and never an address: which
// host this dashboard is reached at is the dashboard's to know, and is never
// taken from a request's Host header, which is the caller's to write.
function linkOf(token: string): string {
  return `/invite#${token}`;
}

async function create(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: AccessScope,
  principal: Principal,
  route: string,
): Promise<FastifyReply> {
  const parsed = createInvitationSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(fail('INVALID_BODY', 'An address and a role are required', parsed.error.issues));
  }
  const made = await createInvitation(deps, {
    scope,
    email: parsed.data.email,
    role: parsed.data.role,
    identity: parsed.data.identity,
    actor: actorOf(principal),
    route,
  });
  if (!made.ok) {
    return reply.code(made.status).send(fail(made.code, made.message));
  }
  return reply.code(201).send(
    ok({
      invitation: made.invitation,
      // The only time the link exists. Only the hash of its token is kept, so
      // one that was lost is revoked and made again, never recovered. Send it
      // to the person yourself, over something you trust: whoever opens it
      // first is who it lets in.
      once: { token: made.token, link: linkOf(made.token) },
    }),
  );
}

async function revoke(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: AccessScope,
  principal: Principal,
  route: string,
): Promise<FastifyReply> {
  const { invitationId } = request.params as { invitationId: string };
  const revoked = await revokeInvitation(deps, {
    scope,
    invitationId,
    actor: actorOf(principal),
    route,
  });
  if (!revoked.ok) {
    return reply.code(revoked.status).send(fail(revoked.code, revoked.message));
  }
  return reply.send(ok({ invitation: revoked.invitation }));
}

export function createListTeamInvitationsController(deps: ApiDeps) {
  return async function listTeamInvitationsController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    if (team === null) {
      return reply;
    }
    return reply.send(
      ok({ invitations: await listInvitations(deps, { kind: 'team', id: team.id }) }),
    );
  };
}

export function createCreateTeamInvitationController(deps: ApiDeps) {
  return async function createTeamInvitationController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    const principal = request.principal;
    if (team === null || principal === null) {
      return reply;
    }
    return create(deps, request, reply, { kind: 'team', id: team.id }, principal, TEAM_CREATE);
  };
}

export function createRevokeTeamInvitationController(deps: ApiDeps) {
  return async function revokeTeamInvitationController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    const principal = request.principal;
    if (team === null || principal === null) {
      return reply;
    }
    return revoke(deps, request, reply, { kind: 'team', id: team.id }, principal, TEAM_REVOKE);
  };
}

export function createListSiteInvitationsController(deps: ApiDeps) {
  return async function listSiteInvitationsController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(
      ok(
        { invitations: await listInvitations(deps, { kind: 'site', id: site.id }) },
        { siteId: site.id },
      ),
    );
  };
}

export function createCreateSiteInvitationController(deps: ApiDeps) {
  return async function createSiteInvitationController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return create(deps, request, reply, { kind: 'site', id: site.id }, principal, SITE_CREATE);
  };
}

export function createRevokeSiteInvitationController(deps: ApiDeps) {
  return async function revokeSiteInvitationController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return revoke(deps, request, reply, { kind: 'site', id: site.id }, principal, SITE_REVOKE);
  };
}

export function createLookupInvitationController(deps: ApiDeps) {
  return async function lookupInvitationController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = lookupInvitationSchema.safeParse(request.body);
    if (!parsed.success) {
      // Not the issues: an issue can quote what was sent, and what was sent
      // here is a token.
      return reply.code(400).send(fail('INVALID_BODY', 'The token from an invitation link is required'));
    }
    const found = await lookupInvitation(deps, parsed.data.token);
    if (!found.ok) {
      return reply.code(found.status).send(fail(found.code, found.message));
    }
    return reply.send(ok({ invitation: found.preview }));
  };
}

export function createAcceptInvitationController(deps: ApiDeps) {
  return async function acceptInvitationController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = acceptInvitationSchema.safeParse(request.body);
    if (!parsed.success) {
      // Which fields failed, and never what they held: the body carries a
      // token and may carry a password.
      const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'body')))];
      return reply.code(400).send(
        fail(
          'INVALID_BODY',
          'A token is required, and a password of at least 12 characters when one is given',
          { fields },
        ),
      );
    }
    const principal = request.principal;
    const accepted = await acceptInvitation(deps, {
      token: parsed.data.token,
      // A key is not a person: only somebody signed in can be the account an
      // invitation was sent to.
      sessionUserId: principal?.kind === 'session' ? principal.id : null,
      ...(parsed.data.password === undefined ? {} : { password: parsed.data.password }),
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      route: ACCEPT,
    });
    if (!accepted.ok) {
      return reply.code(accepted.status).send(fail(accepted.code, accepted.message));
    }
    if (accepted.created) {
      // A new account, by the person who just chose its password: signed in.
      startSession(deps, reply, accepted.user);
    }
    return reply.code(accepted.created ? 201 : 200).send(
      ok({
        user: publicUser(accepted.user),
        created: accepted.created,
        scope: accepted.scope,
        role: accepted.role,
      }),
    );
  };
}
