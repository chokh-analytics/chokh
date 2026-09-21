import { z } from 'zod';

// The batch the tracker posts. Everything the browser sends is validated here
// and nothing else in the collector trusts the body.
const attributes = z.record(z.string().max(100), z.string().max(500));

const eventSchema = z.object({
  type: z.enum(['pageview', 'event', 'heartbeat', 'leave', 'identify', 'vital']),
  ts: z.number().int(),
  path: z.string().max(1024).optional(),
  title: z.string().max(512).optional(),
  referrer: z.string().max(2048).optional(),
  utm: attributes.optional(),
  name: z.string().max(200).optional(),
  // What the page says it answered, on a pageview and nowhere else. Three
  // digits and nothing else, because this becomes a rollup key and a key space
  // a page could fill with free text is one nobody can take back.
  status: z
    .string()
    .regex(/^[1-5][0-9]{2}$/)
    .optional(),
  props: attributes.optional(),
  userId: z.string().max(200).optional(),
  traits: attributes.optional(),
  duration: z.number().nonnegative().optional(),
  scrollDepth: z.number().min(0).max(100).optional(),
  value: z.number().optional(),
  rating: z.string().max(40).optional(),
});

export const batchSchema = z.object({
  siteId: z.string().min(1).max(200),
  sentAt: z.number().int(),
  hostname: z.string().max(253),
  lang: z.string().max(40).optional(),
  screen: z.string().max(40).optional(),
  viewport: z.string().max(40).optional(),
  visitorId: z.string().max(100).optional(),
  userId: z.string().max(200).optional(),
  // The proof that a site, and not the page, said who this visitor is: an HMAC
  // of the userId under the site's identifySecret, issued on the server and
  // passed to pa('identify') as its fourth argument. Optional, because a site
  // that accepts an unsigned identify is the default.
  sig: z.string().max(200).optional(),
  events: z.array(eventSchema).min(1).max(50),
});

export type CollectBatch = z.infer<typeof batchSchema>;
export type CollectEvent = z.infer<typeof eventSchema>;
