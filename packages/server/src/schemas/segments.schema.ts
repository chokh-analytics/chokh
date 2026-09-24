import { z } from 'zod';

import { filterObject } from './stats.schema.js';
import { MAX_SEGMENT_FILTERS } from '../store/AnalyticsStore.js';

// A segment as a request body, validated once: a name and the filters it
// saves, in the same shape a report's filters= takes as JSON, so what a
// dashboard sends to a report and what it saves are one object. Every
// dimension is allowed, the three a stay carries and the bot side included:
// a segment is exactly what the reports can already be narrowed by.

export const createSegmentSchema = z
  .object({
    name: z.string().trim().min(1, 'A segment needs a name').max(100),
    filters: z
      .array(filterObject)
      .min(1, 'A segment needs at least one filter')
      .max(MAX_SEGMENT_FILTERS),
  })
  .strict();

export type CreateSegmentInput = z.infer<typeof createSegmentSchema>;

export const segmentParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
  segmentId: z.string().min(1).max(64),
});
