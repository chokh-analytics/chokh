import type { NextConfig } from 'next';

// next.config: the tracker's scripts served from your own origin.
//
// a.js, v.js and e.js are static files with nobody's address in them, so a
// rewrite is the right way to serve them first-party: no second hostname for a
// content blocker to match on, and no CORS. The collect path is NOT a rewrite,
// and this file deliberately makes none for it. A rewrite is fetched by your
// host's own infrastructure (Vercel's, for one), so the collector would see the
// host as its peer and store every visitor as one machine in one data centre.
// Collect is a route handler instead, createCollectRoute in @chokh/next/collect,
// which carries the visitor's address across and signs it.

export interface ChokhConfigOptions {
  // Your Chokh server's origin, https://analytics.example.com. Empty or left
  // out (an environment variable that is not set) means no rewrites: a preview
  // deployment without the variable serves nothing under the path.
  url?: string | undefined;
  // The first-party path the scripts are served under. Default /_pa.
  path?: string;
  // Which of the tracker's files to serve. Default all three.
  scripts?: readonly ChokhScript[];
}

export type ChokhScript = 'a.js' | 'v.js' | 'e.js';

export const DEFAULT_PATH = '/_pa';
const ALL_SCRIPTS: readonly ChokhScript[] = ['a.js', 'v.js', 'e.js'];

export interface ChokhRewrite {
  source: string;
  destination: string;
}

function trimmed(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '');
}

export function normalisePath(path: string | undefined): string {
  const value = (path ?? DEFAULT_PATH).trim().replace(/\/+$/, '');
  return value.startsWith('/') ? value : `/${value}`;
}

// The rewrites alone, for a config that writes its own rewrites().
export function chokhRewrites(options: ChokhConfigOptions): ChokhRewrite[] {
  const base = trimmed(options.url);
  if (base === '') return [];
  const path = normalisePath(options.path);
  return (options.scripts ?? ALL_SCRIPTS).map((file) => ({
    source: `${path}/${file}`,
    destination: `${base}/${file}`,
  }));
}

type Rewrites = NonNullable<NextConfig['rewrites']>;
type RewriteResult = Awaited<ReturnType<Rewrites>>;
type RewriteList = Extract<RewriteResult, readonly unknown[]>;

// Wrap a whole next.config: the scripts' rewrites go ahead of the app's own, so
// a catch-all page cannot shadow them, and whatever the app returned (a list, or
// the beforeFiles, afterFiles and fallback phases) is kept as it was.
export function withChokh<T extends NextConfig>(config: T, options: ChokhConfigOptions): T {
  const ours = chokhRewrites(options);
  if (ours.length === 0) return config;
  const theirs = config.rewrites;
  const rewrites: Rewrites = async () => {
    const result: RewriteResult = theirs === undefined ? [] : await theirs();
    if (Array.isArray(result)) {
      // A plain list is the afterFiles phase, so it stays there.
      return { beforeFiles: ours, afterFiles: result as RewriteList, fallback: [] };
    }
    const phases = result as Exclude<RewriteResult, readonly unknown[]>;
    return {
      beforeFiles: [...ours, ...(phases.beforeFiles ?? [])],
      afterFiles: phases.afterFiles ?? [],
      fallback: phases.fallback ?? [],
    };
  };
  return { ...config, rewrites };
}
