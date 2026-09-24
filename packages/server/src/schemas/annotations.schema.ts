import { z } from 'zod';

import { ANNOTATION_KINDS, MAX_ANNOTATION_TEXT } from '../store/AnalyticsStore.js';

// An annotation as a request body, validated once: when, what kind, what it
// says and where to read more. The instant is Unix milliseconds like every
// other instant the API takes, and it is bounded to a sane calendar so a
// pipeline that posted seconds by mistake is told so rather than marking the
// year 1970.

const MIN_AT = Date.UTC(2000, 0, 1);
const MAX_AT = Date.UTC(2100, 0, 1);

export const createAnnotationSchema = z
  .object({
    at: z.number().int().min(MIN_AT, 'at is Unix milliseconds').max(MAX_AT, 'at is Unix milliseconds'),
    kind: z.enum(ANNOTATION_KINDS as [string, ...string[]]),
    text: z.string().trim().min(1, 'An annotation needs a sentence').max(MAX_ANNOTATION_TEXT),
    url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => /^https?:\/\/\S+$/.test(value), 'A link starts with http:// or https://')
      .optional(),
  })
  .strict();

export type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>;

// The range the chart is drawing, so the marks arrive with the points.
export const annotationRangeSchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  })
  .refine((range) => range.from < range.to, 'from must be before to');

export const annotationParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
  annotationId: z.string().min(1).max(64),
});
