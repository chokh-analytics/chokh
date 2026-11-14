import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import {
  removeMemberQuerySchema,
  renameTeamSchema,
  setMemberSchema,
} from '../schemas/accounts.schema.js';
import { actorOf } from '../services/audit.service.js';
import {
  changeSiteMembership,
  changeTeamMembership,
  type KeysDecision,
  type MembershipChange,
} from '../services/members.service.js';
import { MANAGED_BY_SSO, isSsoManaged } from '../services/sso-accounts.js';
import type { SiteMember, StoredTeam, StoredUser, TeamMember } from '../store/AnalyticsStore.js';

// Who is in a team and who holds a role on one site, and the routes that
// change either (AN-TEAM01).
//
// A team's members are its owners' business: reading the list and changing it
// both need a person, signed in, who is an owner of that team. A single site's
// rows need admin on that site, held by a person: a key can carry admin, and a
// key is not somebody who may decide who else gets in.
//
// Every change goes through members.service.ts, which is where the rules live.

const TEAM_MEMBER_ROUTE = 'PUT /api/teams/:teamId/members/:userId';
const TEAM_REMOVE_ROUTE = 'DELETE /api/teams/:teamId/members/:userId';
const SITE_MEMBER_ROUTE = 'PUT /api/sites/:siteId/members/:userId';
const SITE_REMOVE_ROUTE = 'DELETE /api/sites/:siteId/members/:userId';

// A member as a list shows them: who they are, what they hold, and whether
// another application decides it.
interface ListedMember {
  userId: string;
  email?: string;
  name?: string;
  role: TeamMember['role'];
  identity: boolean;
  // Signed in by another application, which sets their role on every arrival.
  // Their role is not edited here, and they are given no role on a single
  // site; they can be removed here, which signs them out, and their next
  // arrival puts them back as that application says.
  managed: boolean;
}

function listed(
  member: Pick<TeamMember, 'userId' | 'role' | 'identity'>,
  users: ReadonlyMap<string, StoredUser>,
): ListedMember {
  const user = users.get(member.userId);
  return {
    userId: member.userId,
    ...(user === undefined ? {} : { email: user.email }),
    ...(user?.name === undefined ? {} : { name: user.name }),
    role: member.role,
    identity: member.identity,
    managed: isSsoManaged(member.userId),
  };
}

async function usersOf(deps: ApiDeps, ids: string[]): Promise<Map<string, StoredUser>> {
  return new Map((await deps.store.usersByIds(ids)).map((user) => [user.id, user]));
}

function decisionOf(revokeKeys: boolean | undefined): KeysDecision {
  return revokeKeys === undefined ? 'ask' : revokeKeys ? 'revoke' : 'keep';
}

// What a change did besides the change, for the page that asked for it.
function effects(change: MembershipChange): Record<string, unknown> {
  return {
    sessionsEnded: change.sessionsEnded,
    siteRolesKept: change.siteRolesKept,
    keysRevoked: change.keysRevoked,
    keysKept: change.keysKept,
    invitationsRevoked: change.invitationsRevoked,
  };
}

// The team in the path, for a person who owns it. Answers the refusal itself
// and returns null when there is one.
async function ownedTeam(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<StoredTeam | null> {
  const principal = request.principal;
  if (principal === null) {
    await reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    return null;
  }
  const { teamId } = request.params as { teamId: string };
  const team = await deps.store.team(teamId);
  if (team === null) {
    // 404 and not 403, as the site hook answers for a site nobody registered:
    // a typo and a permissions problem are different things to be told.
    await reply.code(404).send(fail('UNKNOWN_TEAM', `No team answers to ${teamId}`));
    return null;
  }
  // Owner of that team, not of any team, and a person: membership is the
  // permission, so it is read here rather than inferred from a site.
  const mine = team.members.find((member) => member.userId === principal.id);
  if (principal.kind !== 'session' || mine?.role !== 'owner') {
    await reply
      .code(403)
      .send(fail('FORBIDDEN', 'Only an owner of that team may read or change its members'));
    return null;
  }
  return team;
}

export function createListTeamMembersController(deps: ApiDeps) {
  return async function listTeamMembersController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    if (team === null) {
      return reply;
    }
    const users = await usersOf(
      deps,
      team.members.map((member) => member.userId),
    );
    return reply.send(
      ok({
        team: { id: team.id, name: team.name },
        members: team.members.map((member) => listed(member, users)),
      }),
    );
  };
}

export function createSetTeamMemberController(deps: ApiDeps) {
  return async function setTeamMemberController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    const principal = request.principal;
    if (team === null || principal === null) {
      return reply;
    }
    const parsed = setMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('INVALID_BODY', 'A role is required', parsed.error.issues));
    }
    const { userId } = request.params as { userId: string };
    if ((await deps.store.userById(userId)) === null) {
      return reply.code(404).send(fail('UNKNOWN_USER', `No account answers to ${userId}`));
    }
    if (isSsoManaged(userId)) {
      return reply.code(MANAGED_BY_SSO.status).send(fail(MANAGED_BY_SSO.code, MANAGED_BY_SSO.message));
    }
    const changed = await changeTeamMembership(deps, {
      teamId: team.id,
      userId,
      to: { role: parsed.data.role, identity: parsed.data.identity },
      actor: actorOf(principal),
      route: TEAM_MEMBER_ROUTE,
      keys: decisionOf(parsed.data.revokeKeys),
    });
    if (!changed.ok) {
      return reply.code(changed.status).send(fail(changed.code, changed.message, changed.details));
    }
    return reply.send(ok({ team: changed.team }, effects(changed)));
  };
}

export function createRemoveTeamMemberController(deps: ApiDeps) {
  return async function removeTeamMemberController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    const principal = request.principal;
    if (team === null || principal === null) {
      return reply;
    }
    const query = removeMemberQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(fail('INVALID_QUERY', 'revokeKeys is true or false', query.error.issues));
    }
    const { userId } = request.params as { userId: string };
    // An account another application signs in is removed like anybody else.
    // Editing its role is what is refused (above), because a role given here
    // would outlive what that application takes away; a removal gives nothing,
    // and it is the one way an owner here can sign out, now, somebody that
    // application has let go. Their next arrival through the exchange puts
    // them back as the token says, which is that application's word.
    const changed = await changeTeamMembership(deps, {
      teamId: team.id,
      userId,
      to: null,
      actor: actorOf(principal),
      route: TEAM_REMOVE_ROUTE,
      keys: decisionOf(
        query.data.revokeKeys === undefined ? undefined : query.data.revokeKeys === 'true',
      ),
    });
    if (!changed.ok) {
      return reply.code(changed.status).send(fail(changed.code, changed.message, changed.details));
    }
    return reply.send(ok({ team: changed.team }, effects(changed)));
  };
}

export function createRenameTeamController(deps: ApiDeps) {
  return async function renameTeamController(request: FastifyRequest, reply: FastifyReply) {
    const team = await ownedTeam(deps, request, reply);
    if (team === null) {
      return reply;
    }
    const parsed = renameTeamSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('INVALID_BODY', 'A name is required', parsed.error.issues));
    }
    const renamed = await attempt(() => deps.store.renameTeam(team.id, parsed.data.name));
    if (!renamed.ok) {
      return reply.code(renamed.status).send(fail(renamed.code, renamed.message));
    }
    return reply.send(ok({ team: { id: renamed.data.id, name: renamed.data.name } }));
  };
}

function listedRow(row: SiteMember, users: ReadonlyMap<string, StoredUser>): ListedMember {
  return listed(row, users);
}

export function createListSiteMembersController(deps: ApiDeps) {
  return async function listSiteMembersController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const rows = await deps.store.siteMembers(site.id);
    const users = await usersOf(
      deps,
      rows.map((row) => row.userId),
    );
    return reply.send(ok({ members: rows.map((row) => listedRow(row, users)) }, { siteId: site.id }));
  };
}

export function createSetSiteMemberController(deps: ApiDeps) {
  return async function setSiteMemberController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = setMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('INVALID_BODY', 'A role is required', parsed.error.issues));
    }
    const { userId } = request.params as { userId: string };
    if ((await deps.store.userById(userId)) === null) {
      return reply.code(404).send(fail('UNKNOWN_USER', `No account answers to ${userId}`));
    }
    // No row on a site for an account another application signs in: it would
    // outlive whatever that application later takes away.
    if (isSsoManaged(userId)) {
      return reply.code(MANAGED_BY_SSO.status).send(fail(MANAGED_BY_SSO.code, MANAGED_BY_SSO.message));
    }
    const changed = await changeSiteMembership(deps, {
      site,
      userId,
      to: { role: parsed.data.role, identity: parsed.data.identity },
      actor: actorOf(principal),
      route: SITE_MEMBER_ROUTE,
      keys: decisionOf(parsed.data.revokeKeys),
    });
    if (!changed.ok) {
      return reply.code(changed.status).send(fail(changed.code, changed.message, changed.details));
    }
    const users = await usersOf(
      deps,
      changed.members.map((row) => row.userId),
    );
    return reply.send(
      ok({ members: changed.members.map((row) => listedRow(row, users)) }, effects(changed)),
    );
  };
}

export function createRemoveSiteMemberController(deps: ApiDeps) {
  return async function removeSiteMemberController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const query = removeMemberQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(fail('INVALID_QUERY', 'revokeKeys is true or false', query.error.issues));
    }
    const { userId } = request.params as { userId: string };
    const changed = await changeSiteMembership(deps, {
      site,
      userId,
      to: null,
      actor: actorOf(principal),
      route: SITE_REMOVE_ROUTE,
      keys: decisionOf(
        query.data.revokeKeys === undefined ? undefined : query.data.revokeKeys === 'true',
      ),
    });
    if (!changed.ok) {
      return reply.code(changed.status).send(fail(changed.code, changed.message, changed.details));
    }
    const users = await usersOf(
      deps,
      changed.members.map((row) => row.userId),
    );
    return reply.send(
      ok({ members: changed.members.map((row) => listedRow(row, users)) }, effects(changed)),
    );
  };
}
