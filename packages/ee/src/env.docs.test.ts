import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import docs from './env.docs.json' with { type: 'json' };

// Every variable this package reads, said in env.docs.json, from which the
// docs site's environment page is generated. The variables are found by
// reading the source for what it takes from an environment, so one added in
// any file without a word about it fails here.
const HERE = dirname(fileURLToPath(import.meta.url));
const READ = /source\['(CHOKH_[A-Z_]+)'\]|process\.env\.(CHOKH_[A-Z_]+)|process\.env\['(CHOKH_[A-Z_]+)'\]/g;

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return name.endsWith('.ts') && !name.includes('.test') ? [path] : [];
  });
}

describe('the environment of packages/ee, documented', () => {
  it('says something about every variable read, and about nothing else', () => {
    const read = new Set<string>();
    for (const file of sources(HERE)) {
      for (const match of readFileSync(file, 'utf8').matchAll(READ)) {
        read.add(match[1] ?? match[2] ?? match[3] ?? '');
      }
    }
    expect([...read].sort()).toEqual(Object.keys(docs).sort());
  });
});
