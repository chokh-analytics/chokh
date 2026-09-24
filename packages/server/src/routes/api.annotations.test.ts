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
import { annotationIdFor, type Annotation } from '../store/AnalyticsStore.js';

// Annotations over HTTP: the three routes that keep them. An annotation is a
// fact stated about the site at an instant, so what these prove is who may
// state one (an editor from the dashboard, a deploy pipeline with the key it
// already holds, and never a viewer), that a retried statement is one mark,
// and that the range read is the chart's own.

const HOUR = 60 * 60 * 1000;
const DEPLOY = { at: NOW - HOUR, kind: 'deploy', text: 'v2.3.0', url: 'https://example.test/r/2.3.0' };
const DEPLOY_ID = annotationIdFor(SITE_ID, DEPLOY.at, 'deploy', DEPLOY.text);

describe('the annotation routes', () => {
  let harness: Harness;
  let owner: string;
  let editor: { cookie: string; userId: string };
  let viewer: string;
  let pipeline: string;

  beforeAll(async () => {
    harness = await createHarness({ sites: [testSite()] });
    owner = harness.owner.cookie;
    editor = await harness.account({ email: 'editor@test.example', role: 'editor' });
    viewer = (await harness.account({ email: 'viewer@test.example', role: 'viewer' })).cookie;
    pipeline = await harness.key(['write:events']);
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

  const annotations = `/api/sites/${SITE_ID}/annotations`;
  const range = `${annotations}?from=${NOW - 2 * HOUR}&to=${NOW + 1}`;

  it('lets a deploy pipeline post a mark with the key it already holds', async () => {
    const response = await call('POST', annotations, { authorization: pipeline }, DEPLOY);
    expect(response.statusCode).toBe(201);
    const annotation = envelope<{ annotation: Annotation }>(response.body).data?.annotation;
    expect(annotation).toMatchObject({
      siteId: SITE_ID,
      id: DEPLOY_ID,
      at: DEPLOY.at,
      kind: 'deploy',
      text: 'v2.3.0',
      url: DEPLOY.url,
      createdAt: NOW,
    });
    // The key is the author, so the trail says which pipeline said it.
    expect(annotation?.createdBy).toMatch(/^k_/);
  });

  it('writes a retried statement once, and names the mark that is already there', async () => {
    const response = await call('POST', annotations, { authorization: pipeline }, DEPLOY);
    expectFailure(response, 409, 'ANNOTATION_EXISTS');
    const failure = JSON.parse(response.body) as { error: { details: { annotationId: string } } };
    expect(failure.error.details.annotationId).toBe(DEPLOY_ID);
  });

  it('lets an editor note a campaign, and reads the range oldest first', async () => {
    const response = await call('POST', annotations, { cookie: editor.cookie }, {
      at: NOW - 30 * 60 * 1000,
      kind: 'campaign',
      text: 'Launch week email',
    });
    expect(response.statusCode).toBe(201);
    expect(envelope<{ annotation: Annotation }>(response.body).data?.annotation.createdBy).toBe(
      editor.userId,
    );

    const listed = await call('GET', range, { cookie: viewer });
    const body = envelope<{ annotations: Annotation[] }>(listed.body);
    expect(body.data?.annotations.map((each) => each.text)).toEqual(['v2.3.0', 'Launch week email']);
    expect(body.meta).toEqual({ siteId: SITE_ID, from: NOW - 2 * HOUR, to: NOW + 1, max: 1000 });
    // Outside the range, outside the answer.
    const earlier = await call('GET', `${annotations}?from=0&to=${NOW - HOUR}`, { cookie: viewer });
    expect(envelope<{ annotations: Annotation[] }>(earlier.body).data?.annotations).toEqual([]);
  });

  it.each([
    ['no range', annotations],
    ['a range that ends first', `${annotations}?from=${NOW}&to=${NOW - 1}`],
    ['a range that is not numbers', `${annotations}?from=today&to=now`],
  ])('refuses a read with %s', async (_why, url) => {
    expectFailure(await call('GET', url, { cookie: owner }), 400, 'INVALID_RANGE');
  });

  it.each([
    ['seconds for an instant', { at: 1_700_000_000, kind: 'note', text: 'x' }],
    ['a kind there is not', { at: NOW, kind: 'incident', text: 'x' }],
    ['a blank sentence', { at: NOW, kind: 'note', text: '   ' }],
    ['a sentence too long', { at: NOW, kind: 'note', text: 'x'.repeat(201) }],
    ['a link that is not one', { at: NOW, kind: 'note', text: 'x', url: 'ftp://example.test' }],
    ['a field nobody asked for', { at: NOW, kind: 'note', text: 'x', extra: 1 }],
  ])('refuses %s with the envelope', async (_why, body) => {
    expectFailure(await call('POST', annotations, { cookie: owner }, body), 400, 'INVALID_ANNOTATION');
  });

  // The hooks are built for each route, so a viewer who may read the marks is
  // refused both writes, and the refusal names the scope rather than the site.
  it('lets a viewer read the marks and refuses them both writes', async () => {
    expect((await call('GET', range, { cookie: viewer })).statusCode).toBe(200);
    expectFailure(
      await call('POST', annotations, { cookie: viewer }, { at: NOW, kind: 'note', text: 'x' }),
      403,
      'SCOPE_REQUIRED',
    );
    expectFailure(
      await call('DELETE', `${annotations}/${DEPLOY_ID}`, { cookie: viewer }),
      403,
      'SCOPE_REQUIRED',
    );
  });

  it('refuses a key minted for reading', async () => {
    const reader = await harness.key(['read:stats']);
    expect((await call('GET', range, { authorization: reader })).statusCode).toBe(200);
    expectFailure(
      await call('POST', annotations, { authorization: reader }, { at: NOW, kind: 'note', text: 'x' }),
      403,
      'SCOPE_REQUIRED',
    );
  });

  it('deletes once, then says there is no such annotation', async () => {
    const first = await call('DELETE', `${annotations}/${DEPLOY_ID}`, { cookie: editor.cookie });
    expect(envelope(first.body)).toEqual({ success: true, data: { deleted: true } });
    expectFailure(
      await call('DELETE', `${annotations}/${DEPLOY_ID}`, { cookie: owner }),
      404,
      'ANNOTATION_NOT_FOUND',
    );
  });

  it('refuses nobody with the envelope', async () => {
    expectFailure(await call('GET', range, {}), 401, 'UNAUTHENTICATED');
  });
});
