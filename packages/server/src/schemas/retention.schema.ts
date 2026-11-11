import { z } from 'zod';

import {
  ATTRIBUTION_DIMENSIONS,
  COHORT_INTERVALS,
  MAX_ACTIVITY_DAYS,
  POWER_USERS_DEFAULT_LIMIT,
  POWER_USERS_MAX_LIMIT,
  type CohortInterval,
} from '../store/AnalyticsStore.js';
import { instant } from './stats.schema.js';

// The retention routes' query strings (AN-PPL01). Each one is strict: these
// reads take no filters, no compare and no metric list, and a parameter a read
// cannot honour is refused with 400 rather than quietly ignored, because a
// cohort grid that dropped the filter would draw everybody under a heading
// that names a segment.

const range = { from: instant, to: instant };

export const cohortsQuerySchema = z
  .object({
    ...range,
    interval: z
      .enum(COHORT_INTERVALS as [CohortInterval, ...CohortInterval[]])
      .default('week'),
  })
  .strict();

export const activityQuerySchema = z.object(range).strict();

export const powerUsersQuerySchema = z
  .object({
    ...range,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(POWER_USERS_MAX_LIMIT)
      .default(POWER_USERS_DEFAULT_LIMIT),
    // When absent, a third of the range's days (powerMinDays).
    minDays: z.coerce.number().int().min(1).max(MAX_ACTIVITY_DAYS).optional(),
  })
  .strict();

export const attributionQuerySchema = z
  .object({
    ...range,
    // A goal's id, resolved against the site the route already read.
    goal: z.string().min(1).max(64),
    dim: z
      .enum(ATTRIBUTION_DIMENSIONS)
      .default('channel'),
  })
  .strict();

export type CohortsQueryInput = z.infer<typeof cohortsQuerySchema>;
export type PowerUsersQueryInput = z.infer<typeof powerUsersQuerySchema>;
export type AttributionQueryInput = z.infer<typeof attributionQuerySchema>;
