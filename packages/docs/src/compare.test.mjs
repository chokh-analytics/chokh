import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The comparison page's rule, held by a case: every cell about another
// product either links to that product's own pages or says the pages did not
// say, and the page says the day it was read. A claim with no source fails
// here, before a reader sees it.
const PAGE = readFileSync(new URL('../content/compare.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const OWN = {
  Plausible: ['https://plausible.io/', 'https://github.com/plausible/'],
  Umami: ['https://umami.is/', 'https://docs.umami.is/', 'https://github.com/umami-software/'],
  'Google Analytics 4': ['https://support.google.com/analytics/', 'https://marketingplatform.google.com/'],
};
const UNSAID = /Not stated on the pages read|No self-hosted edition stated on the pages read/;

function tables(markdown) {
  const found = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      current = null;
      continue;
    }
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
    if (current === null) {
      current = { head: cells, rows: [] };
      found.push(current);
    } else if (!/^-+$/.test(cells[0] ?? '')) {
      current.rows.push(cells);
    }
  }
  return found;
}

describe('the comparison page', () => {
  // In the first paragraph of the page itself, where a reader looks for it,
  // and not only in the lead above it.
  it('says the day it was read', () => {
    const body = PAGE.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const first = body.split('\n\n')[0] ?? '';
    expect(first.replace(/\s+/g, ' ')).toMatch(/read on 15 November 2026/);
  });

  const claims = tables(PAGE).filter((table) => table.head.includes('Plausible') && table.head.includes('Umami'));

  it('has its two tables of claims', () => {
    expect(claims).toHaveLength(2);
  });

  it('sources every cell about another product on its own pages, or says they did not say', () => {
    for (const table of claims) {
      for (const row of table.rows) {
        for (const [product, prefixes] of Object.entries(OWN)) {
          const cell = row[table.head.indexOf(product)] ?? '';
          const links = [...cell.matchAll(/\]\((https?:[^)]+)\)/g)].map((match) => match[1]);
          const sourced = links.length > 0 && links.every((link) => prefixes.some((prefix) => link.startsWith(prefix)));
          expect(sourced || UNSAID.test(cell), `${row[0]}, ${product}: ${cell}`).toBe(true);
        }
      }
    }
  });

  it("points every cell about Chokh at Chokh's own docs, or at its repository", () => {
    for (const table of claims) {
      for (const row of table.rows) {
        const cell = row[table.head.indexOf('Chokh')] ?? '';
        if (cell === 'None' || cell.startsWith('On your own server')) {
          continue;
        }
        expect(cell, row[0]).toMatch(/\]\((\/|https:\/\/github\.com\/chokh-analytics\/chokh)/);
      }
    }
  });
});
