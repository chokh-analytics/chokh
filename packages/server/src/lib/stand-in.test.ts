import { describe, expect, it } from 'vitest';

import { createStandIn } from './stand-in.js';

const SECRET = 'a-test-secret-that-is-not-a-real-one';

describe('a stand-in for an id that says who somebody is', () => {
  const standIn = createStandIn(SECRET);

  it('is the same for the same id, and different for another', () => {
    expect(standIn('sso_ada@corp.example')).toBe(standIn('sso_ada@corp.example'));
    expect(standIn('sso_ada@corp.example')).not.toBe(standIn('sso_grace@corp.example'));
    expect(standIn('sso_ada@corp.example')).toMatch(/^sso~[A-Za-z0-9_-]{22}$/);
  });

  it('carries nothing of the id it stands for', () => {
    const shown = standIn('sso_ada@corp.example');
    for (const part of ['ada', 'corp', 'example', '@']) {
      expect(shown.slice(4)).not.toContain(part);
    }
  });

  it('cannot be worked out by somebody who guesses the id and does not hold the secret', () => {
    expect(createStandIn('another-secret')('sso_ada@corp.example')).not.toBe(
      standIn('sso_ada@corp.example'),
    );
  });
});
