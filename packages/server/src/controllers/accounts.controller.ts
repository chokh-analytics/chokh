import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import { startSession } from '../lib/session-cookie.js';
import { loginSchema, registerSchema } from '../schemas/accounts.schema.js';
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
        // Through the guarded change, like every other: adding an owner can
        // lower nobody, so nothing refuses it.
        await deps.store.changeTeamMember(DEFAULT_TEAM_ID, user.id, {
          role: 'owner',
          identity: true,
        });
      }
      startSession(deps, reply, user);
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
    startSession(deps, reply, user);
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
    // The teams this person belongs to, and their role in each.
    //
    // Without it a dashboard has no way to name a team when it creates a site,
    // so it can only post the default one, and somebody the SSO exchange put in
    // a team of their own is refused with "Only an owner of default may create
    // a site in it" on the one screen a fresh install gives them. Sites carry a
    // teamId, but somebody with no sites yet is exactly the person who needs
    // this, so it cannot be derived from them.
    const teams =
      user === null
        ? []
        : (await deps.store.teamsForUser(user.id)).map((team) => ({
            id: team.id,
            name: team.name,
            role: team.members.find((member) => member.userId === user.id)?.role ?? 'viewer',
          }));
    return reply.send(
      ok({
        // A key is a caller too, and telling it what it is saves an integration
        // guessing at its own scopes.
        actor: { kind: principal.kind, id: principal.id },
        user: user === null ? null : publicUser(user),
        sites,
        teams,
      }),
    );
  };
}
