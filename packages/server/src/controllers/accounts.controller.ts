import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import {
  loginSchema,
  registerSchema,
  setMemberSchema,
} from '../schemas/accounts.schema.js';
import {
  authenticate,
  hashPassword,
  SESSION_COOKIE,
  type AuthDeps,
} from '../services/auth.service.js';
import { visibleSites } from '../services/sites.service.js';
import { DEFAULT_TEAM_ID, type StoredUser } from '../store/AnalyticsStore.js';

// Registration, sign-in, sign-out, and who am I.
//
// The first account registers itself and becomes the owner of the default team,
// because an install with no way to make the first account is an install nobody
// can use. Every account after that has to be created by an owner, which is why
// the same route is open once and then is not.

export interface PublicUser {
  id: string;
  email: string;
  name?: string;
}

export function publicUser(user: StoredUser): PublicUser {
  // The hash never leaves the store, whatever a caller is allowed to see.
  return {
    id: user.id,
    email: user.email,
    ...(user.name === undefined ? {} : { name: user.name }),
  };
}

function authDeps(deps: ApiDeps): AuthDeps {
  return { store: deps.store, session: deps.session, now: deps.now };
}

function setSessionCookie(deps: ApiDeps, reply: FastifyReply, userId: string): void {
  const issued = deps.session.issue(userId, deps.now());
  reply.setCookie(SESSION_COOKIE, issued.value, {
    path: '/',
    // Not readable by script, so an XSS in a dashboard widget cannot steal it.
    httpOnly: true,
    // Lax and not Strict: the SSO exchange is a top level navigation from another
    // application, and Strict would drop the cookie on the very redirect that
    // sets it. Lax still refuses it on a cross site POST, which is the case that
    // matters.
    sameSite: 'lax',
    secure: deps.cookie.secure,
    maxAge: Math.floor(deps.session.ttlMs / 1000),
  });
}

export function createRegisterController(deps: ApiDeps) {
  return async function registerController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'The registration did not validate', parsed.error.issues));
    }

    const first = (await deps.store.userCount()) === 0;
    if (!first) {
      // Somebody is already here, so this is an owner adding an account and not a
      // stranger creating one. Read off team membership rather than off the sites
      // they can see: an owner of an install with no sites yet is still an owner.
      const principal = request.principal;
      const teams =
        principal === null || principal.kind !== 'session'
          ? []
          : await deps.store.teamsForUser(principal.id);
      const isOwner = teams.some((team) =>
        team.members.some(
          (member) => member.userId === principal?.id && member.role === 'owner',
        ),
      );
      if (!isOwner) {
        return reply.code(403).send(fail('FORBIDDEN', 'Only an owner may create another account'));
      }
    }

    const user: StoredUser = {
      id: `u_${randomUUID()}`,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      createdAt: deps.now(),
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    };
    const created = await attempt(() => deps.store.createUser(user));
    if (!created.ok) {
      return reply.code(created.status).send(fail(created.code, created.message));
    }

    if (first) {
      // The first account owns the default team, which is what every site with no
      // team of its own belongs to. Without this the founder of an install would
      // register and then be able to read nothing.
      const team = await deps.store.team(DEFAULT_TEAM_ID);
      if (team === null) {
        await deps.store.createTeam({
          id: DEFAULT_TEAM_ID,
          name: 'Default',
          members: [{ userId: user.id, role: 'owner', identity: true }],
        });
      } else {
        await deps.store.setTeamMember(DEFAULT_TEAM_ID, {
          userId: user.id,
          role: 'owner',
          identity: true,
        });
      }
      setSessionCookie(deps, reply, user.id);
    }

    return reply.code(201).send(ok({ user: publicUser(user), signedIn: first }));
  };
}

export function createLoginController(deps: ApiDeps) {
  return async function loginController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'An address and a password are required', parsed.error.issues));
    }
    const user = await authenticate(authDeps(deps), parsed.data.email, parsed.data.password);
    if (user === null) {
      // One message for both halves. "No such account" tells somebody which
      // addresses are worth guessing at, and verifyPassword has already made the
      // two cases take the same time.
      return reply
        .code(401)
        .send(fail('INVALID_CREDENTIALS', 'That address and password do not match'));
    }
    setSessionCookie(deps, reply, user.id);
    return reply.send(ok({ user: publicUser(user) }));
  };
}

export function createLogoutController(deps: ApiDeps) {
  return function logoutController(_request: FastifyRequest, reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE, { path: '/', secure: deps.cookie.secure });
    return reply.send(ok({ signedOut: true }));
  };
}

export function createMeController(deps: ApiDeps) {
  return async function meController(request: FastifyRequest, reply: FastifyReply) {
    const principal = request.principal;
    if (principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const sites = await visibleSites(deps.store, principal);
    const user =
      principal.kind === 'session' ? await deps.store.userById(principal.id) : null;
    return reply.send(
      ok({
        // A key is a caller too, and telling it what it is saves an integration
        // guessing at its own scopes.
        actor: { kind: principal.kind, id: principal.id },
        user: user === null ? null : publicUser(user),
        sites,
      }),
    );
  };
}

// The one team route this ticket lands: add a member, or change their role.
// Removing one, renaming a team and creating a second belong to AN-TEAM01.
export function createSetMemberController(deps: ApiDeps) {
  return async function setMemberController(request: FastifyRequest, reply: FastifyReply) {
    const { teamId, userId } = request.params as { teamId: string; userId: string };
    const parsed = setMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'A role is required', parsed.error.issues));
    }
    const principal = request.principal;
    if (principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }

    // Owner of that team, not of any team. Membership is the permission, so it is
    // read here rather than inferred from a site.
    const team = await deps.store.team(teamId);
    if (team === null) {
      return reply.code(404).send(fail('UNKNOWN_TEAM', `No team answers to ${teamId}`));
    }
    const mine = team.members.find((member) => member.userId === principal.id);
    if (principal.kind !== 'session' || mine?.role !== 'owner') {
      return reply
        .code(403)
        .send(fail('FORBIDDEN', 'Only an owner of that team may change its members'));
    }
    if ((await deps.store.userById(userId)) === null) {
      return reply.code(404).send(fail('UNKNOWN_USER', `No account answers to ${userId}`));
    }

    const updated = await attempt(() =>
      deps.store.setTeamMember(teamId, {
        userId,
        role: parsed.data.role,
        identity: parsed.data.identity,
      }),
    );
    if (!updated.ok) {
      return reply.code(updated.status).send(fail(updated.code, updated.message));
    }
    return reply.send(ok({ team: updated.data }));
  };
}
