import { describe, expect, it } from 'vitest';

import { loadExtensions } from './load-extensions.js';

// The one file in the core that knows packages/ee exists, and the three answers
// it has to be able to give.
//
// The one that matters most is "absent". A self-hoster who deleted the paid
// directory, or who cloned a core-only fork, has a complete install of the free
// product, and the server has to boot and say so calmly rather than crash or
// warn. The other two are a working extension and a broken one, and broken is
// reported rather than swallowed: it means a build went wrong, not that
// somebody chose not to buy anything.
//
// The fixtures are files in extension-fixtures/ rather than modules written to
// a temp directory, because the test runner serves what is inside the package
// and answers "not found" for everything else, which would make all four of
// these cases pass for the wrong reason.

function fixture(name: string): URL {
  return new URL(`./extension-fixtures/${name}`, import.meta.url);
}

describe('loadExtensions', () => {
  it('loads an extension that is there', async () => {
    const loaded = await loadExtensions(fixture('good.mjs'));

    expect(loaded.reason).toBe('loaded');
    expect(loaded.extensions.map((extension) => extension.name)).toEqual(['fixture']);
  });

  // A complete install of the free product, and not a fault.
  it('carries on with nothing when the directory is not there', async () => {
    const loaded = await loadExtensions(fixture('nothing-is-here.mjs'));

    expect(loaded.reason).toBe('absent');
    expect(loaded.extensions).toEqual([]);
    expect(loaded.error).toBeUndefined();
  });

  it('reports a module that is there and exports the wrong thing', async () => {
    const loaded = await loadExtensions(fixture('wrong-shape.mjs'));

    expect(loaded.reason).toBe('failed');
    expect(loaded.extensions).toEqual([]);
    expect(String((loaded.error as Error).message)).toContain('exports no extension');
  });

  // A throwing top level is a build that went wrong. It must not read as "you
  // did not buy this".
  it('reports a module that throws on the way in', async () => {
    const loaded = await loadExtensions(fixture('throws.mjs'));

    expect(loaded.reason).toBe('failed');
    expect((loaded.error as Error).message).toBe('boom');
  });
});
