import { z } from 'zod';

import { MAX_AUDIT_PAGE } from '../store/AnalyticsStore.js';

// The audit log's query string (AN-TEAM01). Everything is optional: no
// parameters at all is the newest page of the whole log.

export const AUDIT_DEFAULT_LIMIT = 50;

// The kinds of row a reader can ask for. What each one covers is said in
// services/audit.service.ts, beside the actions themselves.
export const AUDIT_KINDS = ['identity', 'access', 'log'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

// A filter left empty in a form is no filter, not a filter for nothing.
const optionalText = z
  .string()
  .trim()
  .max(256)
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value));

const instant = z.coerce.number().int().nonnegative().optional();

export const auditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE).default(AUDIT_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
    // [from, to), in milliseconds.
    from: instant,
    to: instant,
    // The id of the account or the key that acted.
    actor: optionalText,
    kind: z.enum(AUDIT_KINDS).optional(),
    // Exactly this target: who looked at this person, what happened to this
    // account.
    target: optionalText,
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from < query.to, {
    message: 'from has to be before to',
    path: ['to'],
  });

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
