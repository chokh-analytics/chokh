import { z } from 'zod';

// POST /api/sites/:siteId/events: what a backend may send with a write:events key.
//
// Shorter than the collector's batch schema, and that is the point. A server does
// not have a screen, a language, a referrer or a user agent, so it does not get to
// claim any of them; it has a userId it is certain about and a fact about that
// person. See server-events.service.ts for why there is no pageview and no
// address here.

const attributes = z.record(z.string().min(1).max(64), z.string().max(512)).refine(
  (value) => Object.keys(value).length <= 40,
  'At most 40 properties',
);

const serverEventSchema = z
  .object({
    type: z.enum(['event', 'identify']),
    name: z.string().min(1).max(120).optional(),
    ts: z.number().int().optional(),
    // The page the fact is about, when there is one: an order has a checkout page.
    path: z.string().max(1024).optional(),
    props: attributes.optional(),
    traits: attributes.optional(),
    value: z.number().optional(),
  })
  .refine(
    (event) => event.type !== 'event' || event.name !== undefined,
    'An event needs a name',
  );

export const serverBatchSchema = z.object({
  // Required, and trusted: a key with write:events is a server, so this is the
  // proof a browser identify needs a signature for.
  userId: z.string().min(1).max(200),
  // The browser's visitor id when the application knows it, so the event lands on
  // the stay in progress rather than on a visitor of its own.
  visitorId: z.string().min(1).max(200).optional(),
  events: z.array(serverEventSchema).min(1).max(50),
});

export type ServerBatchInput = z.infer<typeof serverBatchSchema>;
