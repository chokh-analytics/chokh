import { z } from 'zod';

import {
  ERROR_GROUP_DEFAULT_LIMIT,
  ERROR_GROUP_MAX_LIMIT,
  VITAL_METRICS,
} from '../store/AnalyticsStore.js';
import { instant } from './stats.schema.js';

// The health routes' query strings (AN-VIT01). Strict like the retention
// reads': these take no filters, no compare and no segment, and a parameter a
// read cannot honour is refused with 400 rather than quietly ignored.

const range = { from: instant, to: instant };

export const vitalsQuerySchema = z
  .object({
    ...range,
    device: z.enum(['desktop', 'mobile', 'tablet']).optional(),
    sort: z.enum(VITAL_METRICS).default('LCP'),
  })
  .strict();

export const errorsQuerySchema = z
  .object({
    ...range,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ERROR_GROUP_MAX_LIMIT)
      .default(ERROR_GROUP_DEFAULT_LIMIT),
  })
  .strict();

export const coverageQuerySchema = z.object(range).strict();
