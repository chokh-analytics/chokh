// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { exportName, jsonText, saveJson } from './download.js';

// The file's name is the server's, so a CSV and a JSON of one card sit
// together; the JSON is the data as held, saved through a link the page
// clicks and releases.

describe('exportName', () => {
  const range = { from: Date.UTC(2026, 8, 17), to: Date.UTC(2026, 8, 18, 12) };

  it('is the site, the kind, what it is of, and the range as days', () => {
    expect(exportName('s_test', 'breakdown', 'page', range)).toBe(
      's_test-breakdown-page-2026-09-17-2026-09-18',
    );
    expect(exportName('s_test', 'goals', undefined, range)).toBe('s_test-goals-2026-09-17-2026-09-18');
  });

  it('reduces a detail to what a file system takes', () => {
    expect(exportName('s_test', 'properties', 'Signed up/now', range)).toBe(
      's_test-properties-Signed_up_now-2026-09-17-2026-09-18',
    );
  });
});

describe('saveJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('pretty prints with a final newline', () => {
    expect(jsonText({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('clicks a link named for the file and releases the URL afterwards', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:chokh/1');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    saveJson('s_test-goals-2026-09-17-2026-09-18', { rows: [] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('s_test-goals-2026-09-17-2026-09-18.json');
    expect(link.href).toBe('blob:chokh/1');
    // Removed once clicked, so a page that downloads ten times holds no links.
    expect(document.body.querySelector('a')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:chokh/1');
    vi.unstubAllGlobals();
  });
});
