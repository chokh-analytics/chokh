import { z } from 'zod';

import {
  FUNNEL_WINDOWS,
  MAX_FUNNEL_STEPS,
  MAX_JOURNEY_BRANCHES,
  MIN_FUNNEL_STEPS,
} from '../store/AnalyticsStore.js';
import { statsQuerySchema } from './stats.schema.js';

// A funnel as a request body, validated once.
//
// A step is either a goal of this site, named by its id and copied into the
// funnel when it is created, or a typed path under the goal form's own rules.
// The two are two shapes rather than one with a rule on the side, and each is
// strict, so a step naming both, or neither, is refused rather than guessed at.
const name = z.string().trim().min(1, 'A funnel needs a name').max(100);
const stepName = z.string().trim().min(1).max(100).optional();

const goalStep = z.object({ goalId: z.string().min(1).max(64), name: stepName }).strict();

const pageStep = z
  .object({
    page: z
      .string()
      .min(1)
      .max(1024)
      .refine((path) => path.startsWith('/'), 'A path starts with /'),
    name: stepName,
  })
  .strict();

export const funnelStepSchema = z.union([goalStep, pageStep]);

export const createFunnelSchema = z
  .object({
    name,
    // Optional: a funnel asked without one gets the site's default, seven days
    // where the site remembers its visitors and the same visit where it cannot.
    window: z.enum(FUNNEL_WINDOWS).optional(),
    steps: z
      .array(funnelStepSchema)
      .min(MIN_FUNNEL_STEPS, `A funnel has at least ${MIN_FUNNEL_STEPS} steps`)
      .max(MAX_FUNNEL_STEPS, `A funnel has at most ${MAX_FUNNEL_STEPS} steps`),
  })
  .strict();

export type CreateFunnelInput = z.infer<typeof createFunnelSchema>;
export type FunnelStepInput = z.infer<typeof funnelStepSchema>;

export const funnelParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
  funnelId: z.string().min(1).max(64),
});

// The funnel report: the report's query plus which funnel, by id.
export const funnelStatsQuerySchema = statsQuerySchema.extend({
  funnel: z.string().min(1).max(64),
});

export type FunnelStatsQueryInput = z.infer<typeof funnelStatsQuerySchema>;

// The journeys report: the report's query plus how many pages each column
// keeps before the rest is Other.
export const journeysQuerySchema = statsQuerySchema.extend({
  branches: z.coerce.number().int().min(1).max(MAX_JOURNEY_BRANCHES).optional(),
});

export type JourneysQueryInput = z.infer<typeof journeysQuerySchema>;
