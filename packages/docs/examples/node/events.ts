import { createClient } from '@chokh/sdk-node';

const chokh = createClient({
  url: process.env.CHOKH_URL ?? '', // https://analytics.example.com
  siteId: process.env.CHOKH_SITE ?? '', // my_site
  apiKey: process.env.CHOKH_API_KEY ?? '', // a key with write:events, never in a page
});

// Return at once and never throw: the events go in the background.
chokh.identify('u_42', { plan: 'pro' });
chokh.track('u_42', 'order_paid', { value: 1200, path: '/checkout', props: { currency: 'BDT' } });

// Before the process exits, send what is still queued.
await chokh.shutdown();
