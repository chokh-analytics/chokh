import { z } from 'zod';

// A goal as a request body, validated once.
//
// The two kinds take different matches, so they are two shapes rather than one
// with a rule on the side: a page goal is a path and has to start with a slash,
// an event goal is a name exactly as pa('event') sent it. The limits are the
// collector's own, because a goal asking for a path longer than any pageview
// can carry is a goal nothing can ever reach.
const name = z.string().trim().min(1, 'A goal needs a name').max(100);

// A plain number with no unit, counted once per completion. Not negative,
// because a goal is a success and a success is not a cost.
const value = z.number().finite().nonnegative().max(1_000_000_000).optional();

export const createGoalSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('page'),
      name,
      match: z
        .string()
        .min(1)
        .max(1024)
        .refine((path) => path.startsWith('/'), 'A path starts with /'),
      value,
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      name,
      match: z.string().min(1).max(200),
      value,
    })
    .strict(),
]);

export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const goalParamsSchema = z.object({
  siteId: z.string().min(1).max(64),
  goalId: z.string().min(1).max(64),
});
