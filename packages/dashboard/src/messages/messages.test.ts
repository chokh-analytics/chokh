import { describe, expect, it } from 'vitest';

import { format, messages } from './en.js';

// The rules that keep this file translatable, made mechanical.
//
// Every one of these is a rule somebody breaks by accident rather than on
// purpose: a string assembled out of two halves at a call site, a bit of markup
// in a label, an em dash that AGENTS.md rule 9 forbids everywhere. Checking
// them by reading works until the file is four hundred lines, which it now is.

type Leaf = { path: string; value: string };

function leaves(node: unknown, path: string[] = []): Leaf[] {
  if (typeof node === 'string') {
    return [{ path: path.join('.'), value: node }];
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => leaves(value, [...path, key]));
}

const ALL = leaves(messages);

describe('the messages file', () => {
  it('has strings in it, so a passing suite means something', () => {
    expect(ALL.length).toBeGreaterThan(150);
  });

  it('has no empty string, which is a label somebody forgot rather than chose', () => {
    expect(ALL.filter((leaf) => leaf.value.trim() === '').map((leaf) => leaf.path)).toEqual([]);
  });

  // AGENTS.md rule 9, and the one place in this repository where a person is
  // most likely to type one without noticing.
  it('has no em dash anywhere', () => {
    expect(ALL.filter((leaf) => leaf.value.includes('—')).map((leaf) => leaf.path)).toEqual(
      [],
    );
  });

  // A message that carries markup is a message a translator can break the page
  // with, and one that a component has to trust.
  it('carries no markup', () => {
    const withTags = ALL.filter((leaf) => /<[a-z/!]/i.test(leaf.value));
    expect(withTags.map((leaf) => leaf.path)).toEqual([]);
  });

  it('balances every placeholder it opens', () => {
    const unbalanced = ALL.filter((leaf) => {
      const opens = (leaf.value.match(/\{/g) ?? []).length;
      const closes = (leaf.value.match(/\}/g) ?? []).length;
      const named = (leaf.value.match(/\{\w+\}/g) ?? []).length;
      return opens !== closes || opens !== named;
    });
    expect(unbalanced.map((leaf) => leaf.path)).toEqual([]);
  });

  // A leaf that is a fragment is a leaf somebody is going to concatenate. These
  // two shapes catch the common ones: a string that starts or ends mid clause.
  it('has no leaf that is obviously half a sentence', () => {
    const fragments = ALL.filter(
      (leaf) => leaf.value.startsWith(' ') || leaf.value.endsWith(' ') || leaf.value === 'and',
    );
    expect(fragments.map((leaf) => leaf.path)).toEqual([]);
  });

  // The one string in this file that decides whether the headline number is
  // honest. If it goes, the dashboard silently over counts a returning visitor
  // and nobody reading it would know.
  it('still explains what a visitor over several days means', () => {
    expect(messages.metricHelp.visitors).toContain('sum of each day');
  });
});

describe('format', () => {
  it('puts a value where the placeholder is', () => {
    expect(format(messages.range.timezoneNote, { timezone: 'Asia/Dhaka' })).toBe(
      'Times in Asia/Dhaka',
    );
  });

  it('fills several placeholders in one string', () => {
    expect(format(messages.metrics.signedInSplit, { signedIn: 12, anonymous: 25 })).toBe(
      '12 signed in, 25 anonymous',
    );
  });

  // A missing value shows up as itself, so a screenshot says which placeholder
  // was never filled instead of saying "undefined" as if it were a word.
  it('leaves a placeholder nobody filled alone', () => {
    expect(format('Times in {timezone}')).toBe('Times in {timezone}');
  });

  it('leaves a string with no placeholder untouched', () => {
    expect(format(messages.nav.overview)).toBe('Overview');
  });
});
