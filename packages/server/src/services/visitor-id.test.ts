import { describe, expect, it } from 'vitest';

import { createVisitorIdSource } from './visitor-id.js';

const DAY_MS = 86_400_000;
const NOON = 1_789_000_000_000;
const CHROME = 'Mozilla/5.0 Chrome/130';

describe('createVisitorIdSource', () => {
  it('gives the same visitor the same id within a day', () => {
    const source = createVisitorIdSource();
    const first = source.derive('s1', '103.87.12.45', CHROME, NOON);
    expect(source.derive('s1', '103.87.12.45', CHROME, NOON + 1000)).toBe(first);
  });

  it('keeps sites, addresses and browsers apart', () => {
    const source = createVisitorIdSource();
    const base = source.derive('s1', '103.87.12.45', CHROME, NOON);
    expect(source.derive('s2', '103.87.12.45', CHROME, NOON)).not.toBe(base);
    expect(source.derive('s1', '103.87.12.46', CHROME, NOON)).not.toBe(base);
    expect(source.derive('s1', '103.87.12.45', 'Mozilla/5.0 Firefox/133', NOON)).not.toBe(base);
  });

  it('starts a new visitor the next day, because the salt rotates', () => {
    const source = createVisitorIdSource();
    const today = source.derive('s1', '103.87.12.45', CHROME, NOON);
    expect(source.derive('s1', '103.87.12.45', CHROME, NOON + DAY_MS)).not.toBe(today);
  });

  it('gives back an id that carries no address, only a hash of one', () => {
    const id = createVisitorIdSource().derive('s1', '103.87.12.45', CHROME, NOON);
    expect(id).toHaveLength(22);
    expect(id).not.toContain('103');
  });
});
