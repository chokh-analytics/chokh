import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiDeps } from '../lib/api-deps.js';
import { fail, ok } from '../lib/envelope.js';
import type { Grant } from '../lib/scopes.js';
import { recordIdentityRead } from '../services/audit.service.js';
import { resolvePrincipal, SESSION_COOKIE } from '../services/auth.service.js';
import { realtime } from '../services/people.service.js';

// Who is here now, as a snapshot and as a stream.
//
// Both read the presence set through the store and neither touches raw events, so
// "online" means the same thing however it is asked, and both go through the same
// identity gate: the counts, the pages and the countries are traffic, the address
// and the userId are not.

const SNAPSHOT_ROUTE = 'GET /api/sites/:siteId/realtime';
const STREAM_ROUTE = 'GET /api/sites/:siteId/realtime/stream';

// At most two frames a second, on the leading edge: the first nudge after a quiet
// moment is sent immediately, and a burst behind it collapses into one frame half a
// second later. A busy site nudges on every batch and a dashboard cannot draw faster
// than this anyway.
//
// Half a second and not a whole one because the opening snapshot counts as a frame:
// with a gap of a second, a batch that lands right after a dashboard connects would
// be shown a second later, and this stream is meant to be seen within one second of
// ingest.
const MIN_FRAME_GAP_MS = 500;
// A frame even with no traffic, because the online count decays on its own: a
// visitor who stops sending is not online a minute later and the page has to
// notice without anybody's help.
const REFRESH_EVERY_MS = 10_000;
// A comment down the wire, so a proxy that closes an idle connection does not.
const KEEPALIVE_EVERY_MS = 15_000;
// How long a stream goes on believing what it was told about its reader when
// it opened (AN-TEAM01). Every other route asks who is calling on every
// request; a stream is one request that lasts as long as the tab does, so
// without this somebody removed from a team went on being sent addresses and
// names until they closed it. Before a frame, once this long has passed, the
// reader is resolved again from the credentials the stream was opened with:
// gone, or without read:stats on the site, the stream is told so and closed;
// without read:identity, the frames go on with the address and the name
// taken out. On the site's clock, the way a session's expiry is.
export const STREAM_RECHECK_MS = 10_000;

export function createRealtimeController(deps: ApiDeps) {
  return async function realtimeController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    const allowed = request.grant?.scopes.has('read:identity') ?? false;
    const result = await realtime(deps.store, site.id, allowed);
    if (!result.ok) {
      return reply.code(result.status).send(fail(result.code, result.message));
    }
    await recordIdentityRead(deps.store, {
      principal,
      siteId: site.id,
      route: SNAPSHOT_ROUTE,
      fields: result.data.fields,
      at: deps.now(),
    });
    return reply.send(ok(result.data.value, { siteId: site.id, identity: allowed }));
  };
}

// Server sent events, written to the raw socket.
//
// Fastify's reply cannot be used for this: the response is open for as long as the
// dashboard is, so the framing is by hand. Each frame's data is the success
// envelope, so a client parses a frame exactly the way it parses a poll, and rule
// 6 holds where a response is a message rather than a file.
export function createRealtimeStreamController(deps: ApiDeps) {
  return async function realtimeStreamController(request: FastifyRequest, reply: FastifyReply) {
    const site = request.site;
    const principal = request.principal;
    if (site === null || principal === null) {
      return reply.code(401).send(fail('UNAUTHENTICATED', 'Sign in first'));
    }
    let allowed = request.grant?.scopes.has('read:identity') ?? false;
    const credentials = {
      cookie: request.cookies[SESSION_COOKIE],
      authorization: request.headers.authorization,
    };
    let checkedAt = deps.now();

    // One audit row when the stream opens, not one per frame. A frame a second
    // would turn the log into a metronome and bury the reads somebody actually
    // wants to find; the row says a stream was opened with these fields available,
    // which is the fact worth keeping.
    if (allowed) {
      await recordIdentityRead(deps.store, {
        principal,
        siteId: site.id,
        route: STREAM_ROUTE,
        fields: ['ip', 'userId'],
        at: deps.now(),
      });
    }

    reply.hijack();
    const socket = reply.raw;
    socket.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers a proxied response by default, which for a stream means
      // nothing arrives until it decides it has enough. The deployment blueprint
      // turns buffering off for this path; this header is the belt to that braces.
      'x-accel-buffering': 'no',
    });

    let open = true;
    let lastFrameAt = 0;
    let pending: NodeJS.Timeout | undefined;

    // Who is reading, asked again. False when the stream was closed for it.
    const stillAllowed = async (): Promise<boolean> => {
      if (deps.now() - checkedAt < STREAM_RECHECK_MS) {
        return true;
      }
      checkedAt = deps.now();
      let grant: Grant | null = null;
      try {
        const current = await resolvePrincipal(
          { store: deps.store, session: deps.session, now: deps.now },
          credentials,
        );
        const fresh = await deps.store.site(site.id);
        grant = current === null || fresh === null ? null : current.grantFor(fresh);
      } catch (error) {
        // The store could not say who is reading. A stream that cannot check
        // its reader does not go on sending: it closes, and the dashboard
        // falls back to polling, where every request is asked the usual way.
        request.log.error({ err: error }, 'realtime stream could not recheck its reader');
        grant = null;
      }
      if (grant === null || !grant.scopes.has('read:stats')) {
        if (open) {
          socket.write(
            `event: error\ndata: ${JSON.stringify(
              fail('STREAM_CLOSED', 'This stream no longer has a reader allowed to read it'),
            )}\n\n`,
          );
        }
        close();
        return false;
      }
      allowed = grant.scopes.has('read:identity');
      return true;
    };

    const send = async (): Promise<void> => {
      if (!open || !(await stillAllowed()) || !open) {
        return;
      }
      // The throttle measures real elapsed time rather than deps.now(): the clock a
      // test freezes is the site's notion of when things happened, and a frame rate
      // is not one of those things.
      lastFrameAt = Date.now();
      const result = await realtime(deps.store, site.id, allowed);
      if (!open) {
        return;
      }
      if (!result.ok) {
        socket.write(`event: error\ndata: ${JSON.stringify(fail(result.code, result.message))}\n\n`);
        return;
      }
      socket.write(`data: ${JSON.stringify(ok(result.data.value))}\n\n`);
    };

    // A nudge from the bus. Leading edge, then at most one every MIN_FRAME_GAP_MS.
    const nudged = (): void => {
      if (!open || pending !== undefined) {
        return;
      }
      const since = Date.now() - lastFrameAt;
      if (since >= MIN_FRAME_GAP_MS) {
        void send();
        return;
      }
      pending = setTimeout(() => {
        pending = undefined;
        void send();
      }, MIN_FRAME_GAP_MS - since);
    };

    const unsubscribe = await deps.bus.subscribe(site.id, nudged);
    const refresh = setInterval(() => void send(), REFRESH_EVERY_MS);
    const keepalive = setInterval(() => {
      if (open) {
        socket.write(': keepalive\n\n');
      }
    }, KEEPALIVE_EVERY_MS);

    function close(): void {
      if (!open) {
        return;
      }
      open = false;
      clearInterval(refresh);
      clearInterval(keepalive);
      if (pending !== undefined) {
        clearTimeout(pending);
      }
      // The one thing between a long lived server and a listener leak.
      void unsubscribe();
      socket.end();
    }

    request.raw.on('close', close);
    request.raw.on('error', close);

    // The state of the world before anything changes, so a page that has just
    // opened is not blank until somebody arrives.
    await send();
  };
}
