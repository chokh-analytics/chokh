// The API reference, from the code: the route tables say who may call each
// route, route-docs.ts in the server and in packages/ee say what it does and
// which schema reads its query and its body, and every read is answered by
// the real server over an invented site at a fixed moment, recorded here.
//
// Nothing in it comes from a clock or from chance: the moment is a constant,
// and every id the server made up at random is replaced, in the order it was
// first seen, by a name that says what it is. So the same code writes the
// same pages, and CI can hold the committed ones to it.
import { zodToJsonSchema } from 'zod-to-json-schema';

// Read before the server is imported: its environment is parsed on import.
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'development';
process.env.TRUST_PROXY = '127.0.0.1/32';
delete process.env.DATABASE_URL;
delete process.env.MONGODB_URI;
delete process.env.REDIS_URL;
delete process.env.SSO_SECRET;
// What signs the session cookie and the audit log's cursor. Fixed, and
// invented for this page, so a signed value is the same on every run.
process.env.SESSION_SECRET = 'an-invented-session-secret-for-the-docs-0000';

const { buildApp, CORE_ROUTE_DOCS, CORE_ROUTES, loadExtensions, routeKey } = await import('@chokh/server');
const { createMemoryStore } = await import('@chokh/server/store/memory');

// The paid routes, asked of the server's own loader, the one seam that may
// reach packages/ee (scripts/ee-boundary.mjs holds that). A reference without
// them would be wrong without saying so, so a build of the core alone has none.
const loaded = await loadExtensions();
if (loaded.reason !== 'loaded') {
  throw new Error(`packages/ee did not load (${loaded.reason}): build it first, pnpm --filter "@chokh/ee..." build`);
}
const PAID = loaded.extensions.flatMap((extension) => (extension.reference === undefined ? [] : [extension.reference]));
const EE_ROUTES = PAID.flatMap((reference) => reference.routes);
const EE_ROUTE_DOCS = PAID.flatMap((reference) => reference.docs);

// The invented install every example comes from.
export const DEMO = {
  siteId: 's_saltwind',
  siteName: 'Saltwind Coffee',
  domain: 'saltwind.example',
  owner: 'owner@saltwind.example',
};
// Thursday 1 October 2026, noon UTC. A constant, never the clock.
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PASSWORD = 'an-invented-password-for-the-docs';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

// Every route, in the reference's order, with what the table says of it.
export function allRoutes() {
  const rules = new Map([...CORE_ROUTES, ...EE_ROUTES].map((rule) => [routeKey(rule), rule]));
  return [...CORE_ROUTE_DOCS, ...EE_ROUTE_DOCS].map((group) => ({
    group: group.group,
    routes: Object.entries(group.routes).map(([key, doc]) => {
      const rule = rules.get(key);
      if (rule === undefined) {
        throw new Error(`${key} is described but is not in a route table`);
      }
      const [method, url] = key.split(' ');
      return { key, method, url, rule, doc };
    }),
  }));
}

export function jsonSchema(schema) {
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none', effectStrategy: 'input' });
}

// Ids the server made at random, named in the order they were first seen.
function normaliser() {
  const seen = new Map();
  const counts = new Map();
  // A prefix, an underscore, then twelve or more characters of which at least
  // one is a capital or a digit: what a random id looks like, and what a word
  // such as `no_people_yet` never does.
  const RANDOM = /\b([a-z]{1,5})_(?=[A-Za-z0-9_-]*[A-Z0-9])([A-Za-z0-9_-]{12,})\b/g;
  const name = (whole, prefix) => {
    if (!seen.has(whole)) {
      const count = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, count);
      seen.set(whole, `${prefix}_example${count}`);
    }
    return seen.get(whole);
  };
  // A cookieless visitor's id is a hash of the address, the browser and a
  // salt that is made at random when the server starts, so it has no prefix
  // to know it by: it is known by the field it is in.
  const VISITOR_FIELDS = new Set(['visitorId', 'visitorIds']);
  const visitor = (id) => (id.startsWith('u:') ? id : name(`v_${id}`, 'v'));
  // A share link's token is random with no prefix either.
  const token = (value) => name(`share_${value}`, 'share');
  const walk = (value, field = '') => {
    if (typeof value === 'string') {
      if (field === 'token') {
        return token(value);
      }
      // A cursor carries something random of its own beside its signature.
      if (field === 'next' || field === 'cursor') {
        return name(`cursor_${value}`, 'cursor');
      }
      return VISITOR_FIELDS.has(field) ? visitor(value) : value.replace(RANDOM, name);
    }
    if (Array.isArray(value)) {
      return value.map((inner) => walk(inner, field));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [walk(key), walk(inner, key)]));
    }
    return value;
  };
  return (value) => walk(value);
}

// The invented site, its visits and its saved things, made through the API
// itself, then every read asked for and its answer kept.
export async function recordExamples() {
  const now = () => NOW;
  const store = createMemoryStore([], { now });
  const app = await buildApp({ store, now, log: { level: 'silent', stream: { write() {} } } });
  await app.ready();
  const ask = async (method, url, { body, cookie, key, headers = {} } = {}) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body }),
    });
    return response;
  };
  const must = async (method, url, options) => {
    const response = await ask(method, url, options);
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} answered ${response.statusCode}: ${response.body}`);
    }
    return response;
  };

  await must('POST', '/api/auth/register', { body: { email: DEMO.owner, password: PASSWORD, name: 'Ayla Moreno' } });
  const login = await must('POST', '/api/auth/login', { body: { email: DEMO.owner, password: PASSWORD } });
  const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
  const site = `/api/sites/${DEMO.siteId}`;
  await must('POST', '/api/sites', {
    cookie,
    body: { id: DEMO.siteId, name: DEMO.siteName, domains: [DEMO.domain], settings: { timezone: 'UTC' } },
  });

  // Six invented visitors over the last day, from documentation addresses.
  const visits = [
    { ip: '198.51.100.21', ua: CHROME, at: NOW - 11 * HOUR, pages: ['/', '/menu', '/shop/beans'], ref: 'https://www.google.com/' },
    { ip: '198.51.100.22', ua: SAFARI, at: NOW - 10 * HOUR, pages: ['/', '/about'], ref: 'https://www.instagram.com/' },
    { ip: '198.51.100.23', ua: CHROME, at: NOW - 12 * HOUR, pages: ['/shop/beans', '/shop/checkout'], ref: '' },
    { ip: '203.0.113.40', ua: SAFARI, at: NOW - 8 * HOUR, pages: ['/', '/menu'], ref: 'https://duckduckgo.com/' },
    { ip: '203.0.113.41', ua: CHROME, at: NOW - 6 * HOUR, pages: ['/', '/shop/beans', '/shop/checkout'], ref: 'https://www.google.com/' },
    { ip: '203.0.113.42', ua: SAFARI, at: NOW - 2 * MINUTE, pages: ['/menu'], ref: '' },
  ];
  for (const visit of visits) {
    const events = visit.pages.map((path, index) => ({
      type: 'pageview',
      ts: visit.at + index * 40_000,
      path,
      title: `Saltwind Coffee ${path}`,
      ...(index === 0 && visit.ref !== '' ? { referrer: visit.ref } : {}),
    }));
    if (visit.pages.includes('/shop/checkout')) {
      events.push({ type: 'event', ts: visit.at + visit.pages.length * 40_000, name: 'order_paid', props: { size: '250g' } });
    }
    await must('POST', '/api/collect', {
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        origin: `https://${DEMO.domain}`,
        'user-agent': visit.ua,
        'x-forwarded-for': visit.ip,
      },
      body: JSON.stringify({
        siteId: DEMO.siteId,
        sentAt: visit.at + 120_000,
        hostname: DEMO.domain,
        lang: 'en-GB',
        screen: '1920x1080',
        viewport: '1280x720',
        events,
      }),
    });
  }

  const made = await must('POST', `${site}/keys`, { cookie, body: { name: 'Checkout server', scopes: ['write:events'] } });
  const key = JSON.parse(made.body).data.once.token;
  await must('POST', `${site}/events`, {
    key,
    body: { userId: 'cust_1042', events: [{ type: 'identify', traits: { plan: 'subscriber' } }, { type: 'event', name: 'order_paid', value: 18, props: { size: '1kg' } }] },
  });
  const goal = JSON.parse((await must('POST', `${site}/goals`, { cookie, body: { kind: 'event', name: 'Order paid', match: 'order_paid' } })).body).data;
  await must('POST', `${site}/goals`, { cookie, body: { kind: 'page', name: 'Saw the menu', match: '/menu' } });
  const funnel = JSON.parse(
    (await must('POST', `${site}/funnels`, {
      cookie,
      body: { name: 'Home to checkout', steps: [{ page: '/' }, { page: '/shop/beans' }, { page: '/shop/checkout' }] },
    })).body,
  ).data;
  await must('POST', `${site}/segments`, { cookie, body: { name: 'From Google', filters: [{ dim: 'referrer', op: 'contains', value: 'google' }] } });
  await must('POST', `${site}/annotations`, { cookie, body: { at: NOW - 4 * DAY, kind: 'campaign', text: 'Autumn blend launched' } });
  const share = JSON.parse((await must('PUT', `${site}/share`, { cookie, body: {} })).body).data;
  const shareToken = String(share.share.token);
  const people = JSON.parse((await must('GET', `${site}/people`, { cookie })).body).data;
  const visitorId = String(people.people[0]?.visitorId ?? 'unknown');

  const range = `from=${new Date(NOW - 7 * DAY).toISOString()}&to=${new Date(NOW).toISOString()}`;
  const queries = {
    'GET /api/sites/:siteId/stats/breakdown': `${range}&dim=page`,
    'GET /api/sites/:siteId/stats/properties': `${range}&event=order_paid`,
    'GET /api/sites/:siteId/stats/funnel': `${range}&funnel=${funnel.funnel.id}`,
    'GET /api/sites/:siteId/stats/attribution': `${range}&goal=${goal.goal.id}`,
    'GET /api/share/:token/stats/breakdown': `${range}&dim=page`,
    'GET /api/sites/:siteId/export.csv': `${range}&dim=page`,
    'GET /api/sites/:siteId/stats/engagement': `${range}&dim=page`,
    'GET /api/sites/:siteId/annotations': `from=${NOW - 7 * DAY}&to=${NOW}`,
    'GET /api/share/:token/annotations': `from=${NOW - 7 * DAY}&to=${NOW}`,
    'GET /api/teams/:teamId/audit': 'limit=5',
    'GET /api/sites/:siteId/audit': 'limit=5',
  };
  const params = { siteId: DEMO.siteId, teamId: 'default', token: shareToken, visitorId, userId: 'cust_1042' };
  // Not recorded: a redirect, a stream that never ends, a picture, and the
  // check a load balancer reads.
  const SKIP = new Set(['GET /api/sso', 'GET /api/sites/:siteId/realtime/stream', 'GET /api/share/:token/widget.svg', 'GET /health']);
  const normalise = normaliser();
  const examples = {};
  for (const group of allRoutes()) {
    for (const route of group.routes) {
      if (route.method !== 'GET' || SKIP.has(route.key) || route.url.startsWith('/api/ee') || route.url.includes('/ee/')) {
        continue;
      }
      const path = route.url.replace(/:(\w+)/g, (_, name) => encodeURIComponent(params[name] ?? name));
      const query = queries[route.key] ?? (route.doc.query === undefined ? '' : range);
      const response = await ask('GET', `${path}${query === '' ? '' : `?${query}`}`, route.url.startsWith('/api/share') ? {} : { cookie });
      const type = String(response.headers['content-type'] ?? '');
      examples[route.key] = {
        status: response.statusCode,
        body: type.includes('json') ? normalise(JSON.parse(response.body)) : normalise(response.body),
      };
    }
  }
  await app.close();
  return examples;
}
