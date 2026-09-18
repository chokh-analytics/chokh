import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import { attempt } from '../lib/store-error.js';
import {
  createKeySchema,
  createSiteSchema,
  patchSiteSchema,
} from '../schemas/accounts.schema.js';
import { createApiKey } from '../services/keys.service.js';
import {
  createSite,
  publicSite,
  rotateIdentifySecret,
  visibleSites,
} from '../services/sites.service.js';
import { DEFAULT_TEAM_ID } from '../store/AnalyticsStore.js';

// Sites and their keys.
//
// Two secrets leave this file, each exactly once. A site's identifySecret is
// returned when the site is created and when it is rotated, and never by a GET: an
// application needs it on its server to sign identifies, and a secret a GET hands
// back is a secret in a browser cache, a proxy log and a screenshot. An API key's
// token is returned when it is minted and never again, because only its hash is
// kept. Both say so in the response, in a field called once.

export function createListSitesController(deps: ApiDeps) {
  return async function listSitesController(request: FastifyRequest, reply: FastifyReply) {
    const principal = request.principal;
    if (principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(ok({ sites: await visibleSites(deps.store, principal) }));
  };
}

export function createCreateSiteController(deps: ApiDeps) {
  return async function createSiteController(request: FastifyRequest, reply: FastifyReply) {
    const parsed = createSiteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'The site did not validate', parsed.error.issues));
    }
    const principal = request.principal;
    if (principal === null || principal.kind !== 'session') {
      return reply
        .code(403)
        .send(fail('FORBIDDEN', 'A site is created by a person, not by a key'));
    }

    // An owner of the team the site is going into. Not "an owner of something":
    // creating a site into somebody else's team would hand them a site they did
    // not ask for and cannot delete.
    const teamId = parsed.data.teamId ?? DEFAULT_TEAM_ID;
    const team = await deps.store.team(teamId);
    const mine = team?.members.find((member) => member.userId === principal.id);
    if (mine?.role !== 'owner') {
      return reply
        .code(403)
        .send(fail('FORBIDDEN', `Only an owner of ${teamId} may create a site in it`));
    }

    const created = await attempt(() =>
      createSite(deps.store, {
        ...(parsed.data.id === undefined ? {} : { id: parsed.data.id }),
        name: parsed.data.name,
        domains: parsed.data.domains,
        teamId,
        ...(parsed.data.settings === undefined ? {} : { settings: parsed.data.settings }),
      }),
    );
    if (!created.ok) {
      return reply.code(created.status).send(fail(created.code, created.message));
    }
    return reply.code(201).send(
      ok({
        site: publicSite(created.data.site),
        once: {
          // Keep it on the server that signs identifies. It never appears in a GET
          // and the only way to see it again is to rotate it, which invalidates
          // every signature made under the old one.
          identifySecret: created.data.identifySecret,
        },
      }),
    );
  };
}

export function createGetSiteController() {
  return function getSiteController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const grant = request.grant;
    if (site === null || grant === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(
      ok({
        site: publicSite(site),
        scopes: [...grant.scopes].sort(),
        ...(grant.role === undefined ? {} : { role: grant.role }),
      }),
    );
  };
}

export function createPatchSiteController(deps: ApiDeps) {
  return async function patchSiteController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = patchSiteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'The patch did not validate', parsed.error.issues));
    }
    const updated = await attempt(() => deps.store.updateSite(site.id, parsed.data));
    if (!updated.ok) {
      return reply.code(updated.status).send(fail(updated.code, updated.message));
    }
    return reply.send(ok({ site: publicSite(updated.data) }));
  };
}

export function createRotateSecretController(deps: ApiDeps) {
  return async function rotateSecretController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const rotated = await attempt(() => rotateIdentifySecret(deps.store, site.id));
    if (!rotated.ok) {
      return reply.code(rotated.status).send(fail(rotated.code, rotated.message));
    }
    return reply.send(
      ok({
        site: publicSite(rotated.data.site),
        // Every signature issued under the old secret stops verifying now, so an
        // application takes this value and deploys it in the same breath.
        once: { identifySecret: rotated.data.identifySecret },
      }),
    );
  };
}

export function createListKeysController(deps: ApiDeps) {
  return async function listKeysController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    return reply.send(ok({ keys: await deps.store.apiKeys(site.id) }));
  };
}

export function createCreateKeyController(deps: ApiDeps) {
  return async function createKeyController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const parsed = createKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('INVALID_BODY', 'The key did not validate', parsed.error.issues));
    }
    const grant = request.grant;
    // A key cannot be minted with a scope its maker does not hold, or admin would
    // be one POST away from anybody who can read the numbers.
    const beyond = parsed.data.scopes.filter((scope) => !(grant?.scopes.has(scope) ?? false));
    if (beyond.length > 0) {
      return reply
        .code(403)
        .send(
          fail('SCOPE_REQUIRED', `You do not hold ${beyond.join(', ')}, so a key cannot carry it`),
        );
    }

    const minted = await attempt(() =>
      createApiKey(deps.store, {
        siteId: site.id,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        createdBy: principal.id,
        now: deps.now(),
      }),
    );
    if (!minted.ok) {
      return reply.code(minted.status).send(fail(minted.code, minted.message));
    }
    const { keyHash: _keyHash, ...record } = minted.data.record;
    return reply.code(201).send(
      ok({
        key: record,
        // Only the hash is stored, so this is the one time the token exists. A key
        // that was lost is replaced, never recovered.
        once: { token: minted.data.token },
      }),
    );
  };
}

export function createDeleteKeyController(deps: ApiDeps) {
  return async function deleteKeyController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    if (site === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const { keyId } = request.params as { keyId: string };
    const deleted = await deps.store.deleteApiKey(site.id, keyId);
    if (!deleted) {
      return reply.code(404).send(fail('UNKNOWN_KEY', `No key ${keyId} belongs to ${site.id}`));
    }
    return reply.send(ok({ deleted: keyId }));
  };
}
