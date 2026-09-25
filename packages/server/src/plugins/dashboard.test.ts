import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerDashboard } from './dashboard.js';

// What the browser is told to keep, and for how long.
//
// Vite writes every asset with a hash of its contents in the name, so one under
// assets/ can never change without changing its name. index.html is the file
// whose name is fixed and whose contents name the hashed ones, so it is the one
// file that must never be cached: without that, a deploy leaves every returning
// visitor holding an index.html asking for asset names the new build does not
// have, and the dashboard is a blank page until somebody reloads by hand. That
// failure is invisible in development, where nothing is ever redeployed, which
// is exactly why it is asserted here.

let app: FastifyInstance;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'chokh-dashboard-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Chokh</title>');
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.warn(1)');
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />');

  app = Fastify();
  await registerDashboard(app, root);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('serving the built dashboard', () => {
  it('keeps a hashed asset for a year', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never lets a browser keep the file that names the hashed ones', async () => {
    for (const url of ['/', '/index.html']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('lets nobody frame the page it serves at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.headers['content-security-policy']).toBeUndefined();
  });

  it('treats anything outside assets as fresh every time', async () => {
    const response = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(response.headers['cache-control']).toBe('no-cache');
  });
});

// The word "assets" anywhere in the path used to be enough, and the path here
// is an absolute filesystem path: a DASHBOARD_DIR of /srv/assets/chokh, or a
// checkout under a folder somebody called assets, marked index.html immutable
// for a year. Every returning visitor then holds a build that no longer exists
// and there is no way to tell them.
describe('a root whose own path contains the word', () => {
  let tricky: string;
  let trickyApp: FastifyInstance;

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'chokh-assets-'));
    tricky = join(base, 'assets', 'dashboard');
    mkdirSync(join(tricky, 'assets'), { recursive: true });
    writeFileSync(join(tricky, 'index.html'), '<!doctype html><title>Chokh</title>');
    writeFileSync(join(tricky, 'assets', 'index-abc123.js'), 'console.warn(1)');

    trickyApp = Fastify();
    await registerDashboard(trickyApp, tricky);
    await trickyApp.ready();
  });

  afterAll(async () => {
    await trickyApp.close();
    rmSync(tricky, { recursive: true, force: true });
  });

  it('still refuses to let a browser keep index.html', async () => {
    const response = await trickyApp.inject({ method: 'GET', url: '/index.html' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('still keeps the hashed assets under it', async () => {
    const response = await trickyApp.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});
