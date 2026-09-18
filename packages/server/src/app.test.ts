import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('answers 200 with the success envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ success: boolean; data: { status: string; uptimeMs: number } }>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('an unknown route', () => {
  it('answers 404 with the failure envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { accept: 'application/json' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
