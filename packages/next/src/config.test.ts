import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';

import { chokhRewrites, withChokh } from './config.js';

const URL_ = 'https://analytics.example.com/';

describe('chokhRewrites', () => {
  it('serves a.js, v.js and e.js under /_pa from the Chokh server', () => {
    expect(chokhRewrites({ url: URL_ })).toEqual([
      { source: '/_pa/a.js', destination: 'https://analytics.example.com/a.js' },
      { source: '/_pa/v.js', destination: 'https://analytics.example.com/v.js' },
      { source: '/_pa/e.js', destination: 'https://analytics.example.com/e.js' },
    ]);
  });

  it('takes another path and a subset of the scripts', () => {
    expect(chokhRewrites({ url: URL_, path: 'stats/', scripts: ['a.js'] })).toEqual([
      { source: '/stats/a.js', destination: 'https://analytics.example.com/a.js' },
    ]);
  });

  it('never rewrites the collect path: that is a route, so the visitor is not the host', () => {
    expect(chokhRewrites({ url: URL_ }).some((rewrite) => rewrite.source.endsWith('/collect'))).toBe(false);
  });

  it('makes nothing when the URL is unset or blank', () => {
    expect(chokhRewrites({ url: undefined })).toEqual([]);
    expect(chokhRewrites({ url: '  ' })).toEqual([]);
  });
});

describe('withChokh', () => {
  const ours = chokhRewrites({ url: URL_ });

  it('adds the rewrites to a config that has none, before any file', async () => {
    const config = withChokh<NextConfig>({ reactStrictMode: true }, { url: URL_ });
    expect(config.reactStrictMode).toBe(true);
    expect(await config.rewrites?.()).toEqual({ beforeFiles: ours, afterFiles: [], fallback: [] });
  });

  it('keeps a plain list where it was, in the afterFiles phase', async () => {
    const theirs = [{ source: '/old', destination: '/new' }];
    const config = withChokh({ rewrites: async () => theirs }, { url: URL_ });
    expect(await config.rewrites?.()).toEqual({ beforeFiles: ours, afterFiles: theirs, fallback: [] });
  });

  it('keeps each phase of a phased answer, ours first in beforeFiles', async () => {
    const before = { source: '/b', destination: '/bb' };
    const after = { source: '/a', destination: '/aa' };
    const fallback = { source: '/f', destination: '/ff' };
    const config = withChokh(
      { rewrites: async () => ({ beforeFiles: [before], afterFiles: [after], fallback: [fallback] }) },
      { url: URL_ },
    );
    expect(await config.rewrites?.()).toEqual({
      beforeFiles: [...ours, before],
      afterFiles: [after],
      fallback: [fallback],
    });
  });

  it('returns the config untouched when the URL is unset', () => {
    const config = { rewrites: async () => [] };
    expect(withChokh(config, { url: undefined })).toBe(config);
  });
});
