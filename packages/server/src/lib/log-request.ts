import type { FastifyRequest } from 'fastify';

// What a log line says of a request: its method, the host it was asked of,
// and the route it reached. Nothing else.
//
// The framework's own line carries the whole address, query and all, and the
// address of whoever asked. Both are things this product refuses to keep
// anywhere else. A query is where an SSO token, a provider's code and state, a
// sign-in's `next` and a People search arrive; a path is where a share link's
// token arrives; and the asking address on the collector's line is a
// visitor's, behind a proxy that is trusted (the forwarded address) and
// without one (the socket's peer). The store keeps an address only as a site's
// settings allow, so a log line that kept every one of them would be a second
// record nobody chose. One serializer for the whole app, extensions' routes
// included, so no route has to remember to ask for it.
//
// A route that matched is written as its pattern, `/api/sites/:siteId/stats`,
// with the value filled in only for the parameters named below: ids of things
// a site has, which say nothing about a person and are what somebody reading a
// log needs to tell one site's request from another's. Every other parameter
// stays its name, so a parameter added later is hidden until somebody decides
// otherwise: a share's `:token`, a person's `:userId`, a `:visitorId`.
const SHOWN_PARAMETERS: ReadonlySet<string> = new Set([
  'siteId',
  'teamId',
  'goalId',
  'funnelId',
  'segmentId',
  'annotationId',
  'invitationId',
  'keyId',
]);

// Anything that reached no route of the API: the dashboard's own pages (the
// static files' wildcard, or the not found handler that answers with the
// page), and an address that matched nothing. Written as its path without the
// query, a share page's token taken out first, then cut to its first two
// segments. Cut, because a page of the dashboard can hold who somebody is in
// its path: a profile is `/:siteId/people/:kind/:id`, and the id is a
// visitor's or the one an application gave a person, which may be an
// address. The same route in the API hides it, and so does this. Two
// segments still say which page it was (`/s_web/people`), and a built file
// (`/assets/index-3f2a.js`) has only two. An address under `/api/` that
// matched nothing is cut the same way, so `/api/share/<token>/typo` is
// `/api/share`. An invitation's token is after a `#`, which a browser never
// sends.
const SHARE_PAGE = /^\/share\/[^/]+/;
const FIRST_TWO = /^(\/[^/]*(?:\/[^/]*)?)/;

export function loggedUrl(request: FastifyRequest): string {
  const pattern = request.routeOptions.url;
  if (pattern !== undefined && !pattern.includes('*')) {
    const params = (request.params ?? {}) as Record<string, unknown>;
    return pattern.replace(/:(\w+)/g, (whole, name: string) => {
      const value = params[name];
      return SHOWN_PARAMETERS.has(name) && typeof value === 'string' ? value : whole;
    });
  }
  const path = (request.url.split('?')[0] ?? '').replace(SHARE_PAGE, '/share/:token');
  return FIRST_TWO.exec(path)?.[1] ?? path;
}

export const requestLogSerializers = {
  req(request: FastifyRequest): Record<string, unknown> {
    return { method: request.method, url: loggedUrl(request), host: request.host };
  },
};
