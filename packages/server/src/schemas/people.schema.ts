import { z } from 'zod';

import {
  PEOPLE_DEFAULT_LIMIT,
  PEOPLE_MAX_LIMIT,
  PEOPLE_MAX_QUERY,
} from '../store/AnalyticsStore.js';

// The people directory's query string (AN-PPL02). Everything is optional: no
// parameters at all is the first page of everybody.
export const peopleQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PEOPLE_MAX_LIMIT).default(PEOPLE_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
  // A switch in a query string is the word, not a truthy guess about "0".
  identifiedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  // An empty search box is no search, not a search for nothing.
  q: z
    .string()
    .trim()
    .max(PEOPLE_MAX_QUERY)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),
});

export type PeopleQueryInput = z.infer<typeof peopleQuerySchema>;
