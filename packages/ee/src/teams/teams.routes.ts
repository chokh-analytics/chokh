import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  actorOf,
  attempt,
  fail,
  grantOn,
  ok,
  ownedTeam,
  publicSite,
  recordAccessChange,
  requirePrincipal,
  teamIdOf,
  type ApiDeps,
} from '@chokh/server';
import type { ApiKeyRecord, StoredTeam } from '@chokh/store';
import { z } from 'zod';

import { requireLicense } from '../license/guard.js';
import type { LicenseState } from '../license/state.js';

// More than one team (AN-TEAM01): making a team, deleting one, and moving a
// site from one to another, through the product.
//
// What is paid is these three acts and nothing else. A team that exists goes
// on working with no key: its members, its sites, its invitations and its log
// are the core's, and so is a team the SSO exchange made. A key that lapses
// takes nothing away; it refuses the next new team.
//
// Every route asks who is calling before it asks about the licence, the way
// every paid route does: somebody who owns nothing here is told that, and is
// never told which paid feature lives at the path they tried.

export const TEAMS_FEATURE = 'teams';

// How many teams one person may own. Nobody needs this many, and a loop that
// makes teams until something gives should meet a refusal first.
export const MAX_TEAMS_OWNED = 50;

const CREATE_ROUTE = 'POST /api/ee/teams';
const DELETE_ROUTE = 'DELETE /api/ee/teams/:teamId';
const MOVE_ROUTE = 'PUT /api/ee/sites/:siteId/team';

const createTeamSchema = z.object({ name: z.string().trim().min(1).max(120) });

const moveSiteSchema = z.object({
  teamId: z.string().min(1).max(64),
  // The answer to the question a move asks when somebody made keys on the
  // site and will not hold admin on it afterwards. Left out, it is asked.
  revokeKeys: z.boolean().optional(),
});

const BY_A_PERSON = 'This is done by a person signed in, not by a key';

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
}

function owns(team: StoredTeam | null, userId: string): boolean {
  return team?.members.find((member) => member.userId === userId)?.role === 'owner';
}

// A key as a question about it names it: never a token.
function summary(key: ApiKeyRecord): { id: string; name: string; siteId: string; scopes: string[] } {
  return { id: key.id, name: key.name, siteId: key.siteId, scopes: key.scopes };
}

// Somebody signed in who owns some team, whichever.
function requireAnyTeamOwner(deps: ApiDeps): preHandlerHookHandler {
  return async function anyTeamOwnerHook(request: FastifyRequest, reply: FastifyReply) {
    const principal = request.principal;
    if (principal === null) {
      return unauthenticated(reply);
    }
    if (principal.kind !== 'session') {
      return reply.code(403).send(fail('FORBIDDEN', BY_A_PERSON));
    }
    const teams = await deps.store.teamsForUser(principal.id);
    if (!teams.some((team) => owns(team, principal.id))) {
      return reply
        .code(403)
        .send(fail('FORBIDDEN', 'Only somebody who owns a team may make another'));
    }
    return undefined;
  };
}

// Somebody signed in who owns the team in the path. The core's own check,
// which answers the refusal itself.
function requireTeamOwner(deps: ApiDeps): preHandlerHookHandler {
  return async function teamOwnerHook(request: FastifyRequest, reply: FastifyReply) {
    return (await ownedTeam(deps, request, reply)) === null ? reply : undefined;
  };
}

// Somebody signed in who owns the team the site in the path belongs to now.
function requireSiteTeamOwner(deps: ApiDeps): preHandlerHookHandler {
  return async function siteTeamOwnerHook(request: FastifyRequest, reply: FastifyReply) {
    const principal = request.principal;
    if (principal === null) {
      return unauthenticated(reply);
    }
    if (principal.kind !== 'session') {
      return reply.code(403).send(fail('FORBIDDEN', BY_A_PERSON));
    }
    const { siteId } = request.params as { siteId: string };
    const site = await deps.store.site(siteId);
    if (site === null) {
      return reply.code(404).send(fail('UNKNOWN_SITE', `No site answers to ${siteId}`));
    }
    if (!owns(await deps.store.team(teamIdOf(site)), principal.id)) {
      return reply
        .code(403)
        .send(fail('FORBIDDEN', 'Only an owner of the team a site belongs to may move it'));
    }
    return undefined;
  };
}

export function registerTeamRoutes(app: FastifyInstance, deps: ApiDeps, state: LicenseState): void {
  const auth = { store: deps.store, session: deps.session, now: deps.now };
  const store = deps.store;

  // Make a team. Whoever makes it owns it, with nobody else in it, and it
  // holds no site until one is created in it or moved to it.
  app.post(
    '/api/ee/teams',
    {
      preHandler: [
        requirePrincipal(auth),
        requireAnyTeamOwner(deps),
        requireLicense(state, TEAMS_FEATURE),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal;
      if (principal === null) {
        return unauthenticated(reply);
      }
      const parsed = createTeamSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(fail('INVALID_BODY', 'A name is required', parsed.error.issues));
      }
      const owned = (await store.teamsForUser(principal.id)).filter((team) =>
        owns(team, principal.id),
      );
      if (owned.length >= MAX_TEAMS_OWNED) {
        return reply
          .code(409)
          .send(fail('TEAM_LIMIT', `One person owns at most ${MAX_TEAMS_OWNED} teams`));
      }
      const team: StoredTeam = {
        id: `t_${randomUUID().slice(0, 8)}`,
        name: parsed.data.name,
        // An owner holds read:identity whatever the flag says; it is written
        // true so the row says what is so.
        members: [{ userId: principal.id, role: 'owner', identity: true }],
      };
      const made = await attempt(() => store.createTeam(team));
      if (!made.ok) {
        return reply.code(made.status).send(fail(made.code, made.message));
      }
      await recordAccessChange(store, {
        scope: { kind: 'team', id: team.id },
        actor: actorOf(principal),
        action: 'team:create',
        route: CREATE_ROUTE,
        target: team.id,
        fields: [`name: ${team.name}`],
        at: deps.now(),
      });
      return reply.code(201).send(ok({ team: { id: team.id, name: team.name, role: 'owner' } }));
    },
  );

  // Delete a team. Never the default one, and never one that still holds a
  // site: the store refuses both. Its waiting invitations go with it.
  app.delete(
    '/api/ee/teams/:teamId',
    {
      preHandler: [
        requirePrincipal(auth),
        requireTeamOwner(deps),
        requireLicense(state, TEAMS_FEATURE),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal;
      const { teamId } = request.params as { teamId: string };
      const team = await store.team(teamId);
      if (principal === null || team === null) {
        return unauthenticated(reply);
      }
      const gone = await attempt(() => store.deleteTeam(team.id));
      if (!gone.ok) {
        return reply.code(gone.status).send(fail(gone.code, gone.message));
      }
      // A site created in this team, or moved to it, at the same instant: the
      // store looked, saw none, and deleted. Looked at again now that the
      // team is gone; the other side looks again after its own write, and
      // between the two looks every order of the steps is seen by one of
      // them. Seen here, the team is put back as it was, members and all, and
      // the deletion is refused the way it would have been a moment later.
      // Its waiting invitations are not put back: they went with the team.
      if ((await store.sites()).some((site) => teamIdOf(site) === team.id)) {
        await attempt(() => store.createTeam(team));
        return reply
          .code(409)
          .send(fail('TEAM_HAS_SITES', `${team.id} still holds a site, so it was not deleted`));
      }
      // In the log of the team that is gone. Nobody can open that log from
      // the dashboard any more; the row is there for whoever reads the store.
      await recordAccessChange(store, {
        scope: { kind: 'team', id: team.id },
        actor: actorOf(principal),
        action: 'team:delete',
        route: DELETE_ROUTE,
        target: team.id,
        fields: [`name: ${team.name}`, `members: ${team.members.length}`],
        at: deps.now(),
      });
      return reply.send(ok({ deleted: true }));
    },
  );

  // Move a site to another team. An owner of both: of the team it is in (the
  // hook), and of the team it goes to (below). The roles held on the site
  // itself are rows about the site, so they go with it untouched; what
  // changes is whose team reads it.
  app.put(
    '/api/ee/sites/:siteId/team',
    {
      preHandler: [
        requirePrincipal(auth),
        requireSiteTeamOwner(deps),
        requireLicense(state, TEAMS_FEATURE),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal;
      const { siteId } = request.params as { siteId: string };
      const site = await store.site(siteId);
      if (principal === null || site === null) {
        return unauthenticated(reply);
      }
      const parsed = moveSiteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(fail('INVALID_BODY', 'The team to move the site to is required', parsed.error.issues));
      }
      const from = teamIdOf(site);
      if (parsed.data.teamId === from) {
        // Already there. Nothing is written and nothing is logged.
        return reply.send(ok({ site: publicSite(site), moved: false }));
      }
      const to = await store.team(parsed.data.teamId);
      if (to === null) {
        return reply
          .code(404)
          .send(fail('UNKNOWN_TEAM', `No team answers to ${parsed.data.teamId}`));
      }
      if (!owns(to, principal.id)) {
        return reply
          .code(403)
          .send(fail('FORBIDDEN', 'Only an owner of both teams may move a site between them'));
      }

      // The keys on the site made by somebody who will not hold admin on it
      // once it has moved. A key goes on working whoever made it, so this is
      // the same question a removal asks, and it is asked, not answered: the
      // move is refused with the list until the caller says which.
      const rows = await store.siteMembers(site.id);
      const losing = (await store.apiKeys(site.id)).filter((key) => {
        const after = grantOn(
          to.members.find((member) => member.userId === key.createdBy),
          rows.find((row) => row.userId === key.createdBy),
        );
        return !(after?.scopes.has('admin') ?? false);
      });
      if (losing.length > 0 && parsed.data.revokeKeys === undefined) {
        return reply.code(409).send(
          fail(
            'KEYS_DECISION_REQUIRED',
            'Keys on this site were made by people who will not administer it after the move. Say whether to revoke them (revokeKeys: true) or keep them (revokeKeys: false)',
            { keys: losing.map(summary) },
          ),
        );
      }

      const moved = await attempt(() => store.updateSite(site.id, { teamId: to.id }));
      if (!moved.ok) {
        return reply.code(moved.status).send(fail(moved.code, moved.message));
      }
      // The team it went to, deleted at the same instant: put back as it was
      // read, for the reason written beside the deletion above.
      if ((await store.team(to.id)) === null) {
        await attempt(() => store.createTeam(to));
      }

      const revoked: ApiKeyRecord[] = [];
      const kept: ApiKeyRecord[] = [];
      for (const key of losing) {
        if (parsed.data.revokeKeys === true && (await store.deleteApiKey(site.id, key.id))) {
          revoked.push(key);
        } else {
          kept.push(key);
        }
      }

      const fields = [`team: ${from} > ${to.id}`];
      if (revoked.length > 0) fields.push(`keys revoked: ${revoked.length}`);
      if (kept.length > 0) {
        fields.push(`keys kept: ${kept.length}`);
        for (const key of kept) {
          fields.push(`key ${key.id} "${key.name}" on ${key.siteId}`);
        }
      }
      // Three readers were each promised their own log: the owners of the
      // team it left, the owners of the team it joined, and whoever
      // administers the site.
      for (const scope of [
        { kind: 'team' as const, id: from },
        { kind: 'team' as const, id: to.id },
        { kind: 'site' as const, id: site.id },
      ]) {
        await recordAccessChange(store, {
          scope,
          actor: actorOf(principal),
          action: 'site:move',
          route: MOVE_ROUTE,
          target: site.id,
          fields,
          at: deps.now(),
        });
      }
      return reply.send(
        ok(
          { site: publicSite(moved.data), moved: true },
          { keysRevoked: revoked.map(summary), keysKept: kept.map(summary) },
        ),
      );
    },
  );
}
