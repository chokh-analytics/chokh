import { describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';

import docs from './env.docs.json' with { type: 'json' };
import { envSchema } from './env.js';

// The documentation of every variable lives beside the schema, in
// env.docs.json, and the docs site's environment page is generated from it.
// So a variable added to the schema without a word about it, or a word left
// about a variable that is gone, fails here and not in front of a reader.
describe('the environment, documented', () => {
  it('says something about every variable the server reads, and about nothing else', () => {
    const shape = (envSchema._def.schema as ZodObject<ZodRawShape>).shape;
    expect(Object.keys(docs).sort()).toEqual(Object.keys(shape).sort());
  });

  it('gives each one a default and a sentence', () => {
    for (const [name, entry] of Object.entries(docs)) {
      expect(entry.default, name).not.toBe('');
      expect(entry.about.length, name).toBeGreaterThan(10);
    }
  });
});
