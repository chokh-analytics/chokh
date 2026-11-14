import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import type { Principal } from '../lib/scopes.js';
import { auditQuerySchema } from '../schemas/audit.schema.js';
import { readAuditLog } from '../services/audit.service.js';
import type { AccessScope } from '../store/AnalyticsStore.js';
import { ownedTeam } from './members.controller.js';

// The audit log, read (AN-TEAM01): who looked at which person and when, and
// who let whom in.
//
// Two logs, because two audiences were promised different things. A site's
// log holds what happened on that site and is read with admin on it, by a
// person or by a key. A team's log holds what happened to the team itself
// (its members, the invitations to it) and is read by a person who owns the
// team. A row is in one or the other and never both, so neither reader ever
// sees a row meant for the other.
//
// These two GETs are the only routes the log has. Nothing here or anywhere
// else in the API changes a row or takes one out: the store's contract has no
// method that could, and the route table's test fails if a route that writes
// is ever registered under either path.

const SITE_AUDIT_ROUTE = 'GET /api/sites/:siteId/audit';
const TEAM_AUDIT_ROUTE = 'GET /api/teams/:teamId/audit';

async function answer(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  log: { scope: AccessScope; principal: Principal; allowed: boolean; route: string },
) {
  const parsed = auditQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(fail('INVALID_AUDIT_QUERY', 'The query did not validate', parsed.error.issues));
  }
  const input = parsed.data;
  const result = await readAuditLog(deps, {
    ...log,
    limit: input.limit,
    cursor: input.cursor,
    from: input.from,
    to: input.to,
    actorId: input.actor,
    kind: input.kind,
    target: input.target,
  });
  if (!result.ok) {
    return reply.code(result.status).send(fail(result.code, result.message));
  }
  return reply.send(ok(result.data.page, { identity: log.allowed, limit: input.limit }));
}

export function createSiteAuditController(deps: ApiDeps) {
  return async function siteAuditController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return answer(deps, request, reply, {
      scope: { kind: 'site', id: site.id },
      principal,
      // admin got them here. Whether they also see who the rows are about is
      // the other permission, and a key can hold the first without it.
      allowed: request.grant?.scopes.has('read:identity') ?? false,
      route: SITE_AUDIT_ROUTE,
    });
  };
}

export function createTeamAuditController(deps: ApiDeps) {
  return async function teamAuditController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    const principal = request.principal;
    if (team === null || principal === null) {
      return reply;
    }
    return answer(deps, request, reply, {
      scope: { kind: 'team', id: team.id },
      principal,
      // An owner of a team holds read:identity on everything in it: that is
      // what the role is (lib/scopes.ts), and ownedTeam let nobody else by.
      allowed: true,
      route: TEAM_AUDIT_ROUTE,
    });
  };
}
