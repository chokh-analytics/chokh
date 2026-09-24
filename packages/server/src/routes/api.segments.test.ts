import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createHarness,
  envelope,
  expectFailure,
  NOW,
  SITE_ID,
  testSite,
  type Harness,
} from './api.test-utils.js';
import { segmentIdFor, type Filter, type Segment } from '../store/AnalyticsStore.js';

// Segments over HTTP: the three routes that keep them. A segment is a saved
// filter list and nothing more, so what these prove is who may keep one, what
// one may hold, and that the same filters are one segment however they are
// spelled.

const MOBILE_FROM_BD: Filter[] = [
  { dim: 'device', op: 'is', value: 'mobile' },
  { dim: 'country', op: 'is', value: 'BD' },
];
const MOBILE_ID = segmentIdFor(SITE_ID, MOBILE_FROM_BD);

describe('the segment routes', () => {
  let harness: Harness;
  let owner: string;
  let viewer: string;

  beforeAll(async () => {
    harness = await createHarness({ sites: [testSite()] });
    owner = harness.owner.cookie;
    viewer = (await harness.account({ email: 'viewer@test.example', role: 'viewer' })).cookie;
  });

  afterAll(async () => {
    await harness.close();
  });

  function call(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) {
    return harness.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  const segments = `/api/sites/${SITE_ID}/segments`;

  it('adds a segment for an owner, with an id derived from the filters', async () => {
    const response = await call('POST', segments, { cookie: owner }, {
      name: 'Mobile from Bangladesh',
      filters: MOBILE_FROM_BD,
    });
    expect(response.statusCode).toBe(201);
    const segment = envelope<{ segment: Segment }>(response.body).data?.segment;
    expect(segment).toEqual({
      siteId: SITE_ID,
      id: MOBILE_ID,
      name: 'Mobile from Bangladesh',
      // Canonical order: by dimension, so the same set is one segment however
      // the bar listed it.
      filters: [
        { dim: 'country', op: 'is', value: 'BD' },
        { dim: 'device', op: 'is', value: 'mobile' },
      ],
      createdBy: harness.owner.userId,
      createdAt: NOW,
    });

    const listed = await call('GET', segments, { cookie: owner });
    const body = envelope<{ segments: Segment[] }>(listed.body);
    expect(body.data?.segments.map((each) => each.id)).toEqual([MOBILE_ID]);
    expect(body.meta).toEqual({ siteId: SITE_ID, max: 50 });
  });

  it('refuses the same filters saved twice, in another order and under another name', async () => {
    const response = await call('POST', segments, { cookie: owner }, {
      name: 'Another name',
      filters: [...MOBILE_FROM_BD].reverse(),
    });
    expectFailure(response, 409, 'SEGMENT_EXISTS');
    const failure = JSON.parse(response.body) as { error: { details: { segmentId: string } } };
    expect(failure.error.details.segmentId).toBe(MOBILE_ID);
  });

  // The whole point of the ticket: a stay's dimensions, the bot side and a
  // route are filters like any other, so a segment may hold them.
  it('takes a filter on where a stay came in, on the crawler side and on a route', async () => {
    const response = await call('POST', segments, { cookie: owner }, {
      name: 'Organic course readers',
      filters: [
        { dim: 'channel', op: 'is', value: 'organic' },
        { dim: 'route', op: 'is', value: '/courses/:slug' },
        { dim: 'bot', op: 'is', value: 'false' },
      ],
    });
    expect(response.statusCode).toBe(201);
  });

  it.each([
    ['no filters', { name: 'x', filters: [] }],
    [
      'eleven filters',
      { name: 'x', filters: Array.from({ length: 11 }, (_, i) => ({ dim: 'page', op: 'is', value: `/${i}` })) },
    ],
    ['a dimension there is not', { name: 'x', filters: [{ dim: 'colour', op: 'is', value: 'x' }] }],
    ['an operator there is not', { name: 'x', filters: [{ dim: 'page', op: 'starts', value: '/' }] }],
    ['a blank name', { name: '  ', filters: MOBILE_FROM_BD }],
    ['a field nobody asked for', { name: 'x', filters: MOBILE_FROM_BD, extra: 1 }],
  ])('refuses %s with the envelope', async (_why, body) => {
    expectFailure(await call('POST', segments, { cookie: owner }, body), 400, 'INVALID_SEGMENT');
  });

  // The hooks are built for each route, so a viewer who may read the list is
  // refused both writes, and the refusal names the scope rather than the site.
  it('lets a viewer read the list and refuses them both writes', async () => {
    expect((await call('GET', segments, { cookie: viewer })).statusCode).toBe(200);
    expectFailure(
      await call('POST', segments, { cookie: viewer }, { name: 'x', filters: MOBILE_FROM_BD }),
      403,
      'SCOPE_REQUIRED',
    );
    expectFailure(
      await call('DELETE', `${segments}/${MOBILE_ID}`, { cookie: viewer }),
      403,
      'SCOPE_REQUIRED',
    );
  });

  it('deletes once, then says there is no such segment', async () => {
    const first = await call('DELETE', `${segments}/${MOBILE_ID}`, { cookie: owner });
    expect(envelope(first.body)).toEqual({ success: true, data: { deleted: true } });
    expectFailure(
      await call('DELETE', `${segments}/${MOBILE_ID}`, { cookie: owner }),
      404,
      'SEGMENT_NOT_FOUND',
    );
  });

  it('refuses nobody with the envelope', async () => {
    expectFailure(await call('GET', segments, {}), 401, 'UNAUTHENTICATED');
  });
});
