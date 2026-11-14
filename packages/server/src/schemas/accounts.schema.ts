import { MAX_NEXT, SAFE_NEXT } from '../lib/safe-next.js';
import { z } from 'zod';

import {
  MAX_ROUTE_GROUPS,
  MAX_ROUTE_RULE_LENGTH,
  ROLES,
  SCOPES,
  isRouteRule,
  type Role,
  type Scope,
} from '../store/AnalyticsStore.js';
import { isAddressRule, isPathRule } from '../services/exclusions.js';

// Every body an account or a site route accepts. Zod at the boundary, AGENTS.md
// section 5, so no handler ever reads request.body.

// Long enough to be worth hashing. No composition rules: they push people
// towards Passw0rd! and nothing else, and the hash is argon2id either way.
const password = z.string().min(12).max(200);

const email = z.string().email().max(320).transform((value) => value.toLowerCase());

export const registerSchema = z.object({
  email,
  password,
  name: z.string().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export const ssoBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

export const ssoQuerySchema = z.object({
  token: z.string().min(1).max(4096),
  // Where to land afterwards. A path of this dashboard only: an open redirect
  // behind an authentication hop is how a sign-in link becomes a phishing link.
  next: z
    .string()
    .max(MAX_NEXT)
    .regex(SAFE_NEXT, 'next has to be a path of this dashboard')
    .optional(),
});

// A site id goes in a page as data-site, so it has to be something a person can
// read and type, and it must not need escaping in a URL.
const siteId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'A site id is lowercase letters, digits, - and _');

// A hostname, because the collector's origin check compares hostnames exactly.
// No scheme, no port, no path: those are not what an Origin header yields.
const domain = z
  .string()
  .min(3)
  .max(253)
  .transform((value) => value.trim().toLowerCase())
  .refine(
    (value) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value),
    'A domain is a hostname like example.com, with no scheme, port or path',
  );

// At least one. The unique multikey index on sites.domains stores one null key for
// an empty array, so two domainless sites would collide; and a site with no domain
// could not pass the collector's origin check anyway, so it could never collect.
const domains = z.array(domain).min(1, 'A site needs at least one domain').max(50);

export const siteSettingsPatchSchema = z
  .object({
    ipMode: z.enum(['full', 'anonymized', 'none']),
    visitorIdMode: z.enum(['cookieless', 'persistent']),
    botFilter: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    timezone: z.string().min(1).max(64),
    allowUnsignedIdentify: z.boolean(),
    // JavaScript error capture and whether it keeps stacks (AN-VIT01), both off
    // until the site turns them on.
    errorCapture: z.boolean(),
    errorStacks: z.boolean(),
    // Each checked the way the collector will read it, so a rule that would
    // exclude nobody is refused here rather than stored as a silent no-op.
    excludeIps: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .refine(isAddressRule, 'An excluded address is an IP address or a CIDR range'),
      )
      .max(200),
    excludePaths: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine(isPathRule, 'An excluded path is an absolute path, with * for one segment'),
      )
      .max(200),
    excludeQueryParams: z.array(z.string().min(1).max(64)).max(200),
    // Ordered, first match wins; the grammar is in the store's routes.ts.
    routeGroups: z
      .array(
        z
          .string()
          .max(MAX_ROUTE_RULE_LENGTH)
          .refine(
            isRouteRule,
            'A route rule is an absolute path such as /courses/:slug, with no query or fragment',
          ),
      )
      .max(MAX_ROUTE_GROUPS),
  })
  .partial()
  // Deliberately absent: identifySecret. It is generated when the site is created
  // and replaced only by the rotate route, so nothing can set it to a value
  // somebody chose or read it back out of a settings echo.
  .strict();

export const createSiteSchema = z.object({
  id: siteId.optional(),
  name: z.string().min(1).max(120),
  domains,
  teamId: z.string().min(1).max(64).optional(),
  settings: siteSettingsPatchSchema.optional(),
});

export const patchSiteSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    domains: domains.optional(),
    settings: siteSettingsPatchSchema.optional(),
  })
  .strict();

export const createKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z
    .array(z.enum(SCOPES as [Scope, ...Scope[]]))
    .min(1, 'A key with no scope can do nothing')
    .max(SCOPES.length),
});

export const setMemberSchema = z.object({
  role: z.enum(ROLES as [Role, ...Role[]]),
  identity: z.boolean().default(false),
  // What to do about the keys this person made on a site they are losing
  // admin on. Left out, a change that would leave such keys is refused with
  // the list, so the choice is always somebody's and never a default.
  revokeKeys: z.boolean().optional(),
});

// The same choice on a removal, which has no body to carry it.
export const removeMemberQuerySchema = z.object({
  revokeKeys: z.enum(['true', 'false']).optional(),
});

export const renameTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const siteParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
});

// An invitation, as somebody sends one: an address, a role, and whether the
// role comes with the identity flag.
export const createInvitationSchema = z.object({
  email,
  role: z.enum(ROLES as [Role, ...Role[]]),
  identity: z.boolean().default(false),
});

// The token from an invitation link. In a body, never in a path or a query:
// a URL is written to logs, a body is not.
const invitationToken = z.string().min(20).max(200);

export const lookupInvitationSchema = z.object({ token: invitationToken });

// Using one. The password is asked for only when the address has no account
// yet, and is held to the rule registration applies; the name is optional as
// it is there.
export const acceptInvitationSchema = z.object({
  token: invitationToken,
  password: password.optional(),
  name: z.string().min(1).max(120).optional(),
});
