import { describe, expect, it } from 'vitest';

import { framePolicy } from './frame-policy.js';

describe('framePolicy', () => {
  it('lets only the embed be framed', () => {
    expect(framePolicy('/share/tok_abc/embed')).toEqual({
      'content-security-policy': 'frame-ancestors *',
    });
    expect(framePolicy('/share/tok_abc/embed?range=30d')).toEqual({
      'content-security-policy': 'frame-ancestors *',
    });
    for (const url of ['/', '/s_demo', '/s_demo/people', '/share/tok_abc', '/share/tok_abc/embedx', '/share/embed']) {
      expect(framePolicy(url), url).toEqual({
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      });
    }
  });
});
