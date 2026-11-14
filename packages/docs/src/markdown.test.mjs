import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRenderer, slugify, splitFrontMatter } from './markdown.mjs';

const render = (source, base = '/chokh/') => createRenderer({ base }).render(source);

describe('a page of the docs', () => {
  it('reads its front matter, and a page with none', () => {
    expect(splitFrontMatter('---\ntitle: Licence\nlead: Two: licences\n---\nBody\n')).toEqual({
      data: { title: 'Licence', lead: 'Two: licences' },
      body: 'Body\n',
    });
    expect(splitFrontMatter('Body\n')).toEqual({ data: {}, body: 'Body\n' });
  });

  it('refuses a heading of its own at the top level, because the title is the h1', () => {
    expect(() => render('# Title\n')).toThrow(/front matter/);
  });

  it('gives each heading an id, unique on the page, and lists them', () => {
    const { html, headings } = render('## Run it\n\n### Run it\n\n## Free, and what is paid\n');
    expect(headings).toEqual([
      { id: 'run-it', text: 'Run it', level: 2 },
      { id: 'run-it-2', text: 'Run it', level: 3 },
      { id: 'free-and-what-is-paid', text: 'Free, and what is paid', level: 2 },
    ]);
    expect(html).toContain('<h2 id="run-it">Run it <a class="anchor" href="#run-it" aria-hidden="true" tabindex="-1">#</a></h2>');
    expect(slugify('What `next` is!')).toBe('what-next-is');
  });

  it('puts the base path in front of a link to a page of the site, and marks one that leaves', () => {
    const { html } = render('[a](/licence/) [b](https://example.com/) [c](#here)', '/docs/');
    expect(html).toContain('<a href="/docs/licence/">a</a>');
    expect(html).toContain('<a href="https://example.com/" class="external">b</a>');
    expect(html).toContain('<a href="#here">c</a>');
  });

  it('makes code blocks with a label in a row into one set of tabs, and leaves others alone', () => {
    const { html } = render('```bash PostgreSQL\nup\n```\n\n```bash MongoDB\nup -d\n```\n\nText\n\n```bash\nalone\n```\n');
    expect(html.match(/data-tabs/g)).toHaveLength(1);
    expect(html).toContain('<div class="tab-panel" data-label="PostgreSQL"><p class="tab-label">PostgreSQL</p>');
    expect(html).toContain('<div class="tab-panel" data-label="MongoDB">');
    // The plain block after the text is not a tab.
    expect(html.indexOf('alone')).toBeGreaterThan(html.lastIndexOf('</div>'));
  });

  it('colours code at build time and escapes what it does not know', () => {
    const { html } = render('```ts\nconst a = 1;\n```\n\n```nope\n<b>\n```\n');
    expect(html).toContain('<span class="token keyword">const</span>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('gives the search each section as words, without the Markdown', () => {
    const { sections } = render('Intro with `code` and [a link](/x/)\nover two lines.\n\n## Keys\n\nA key is *signed*.\n');
    expect(sections).toEqual([
      { id: null, heading: null, text: 'Intro with code and a link over two lines.' },
      { id: 'keys', heading: 'Keys', text: 'A key is signed.' },
    ]);
  });

  it('takes a code block from a file under examples/, and refuses one outside it', () => {
    const examples = fileURLToPath(new URL('../examples/', import.meta.url));
    const renderer = createRenderer({ base: '/chokh/', examples });
    const { html } = renderer.render('```tsx React file=react/signup-button.tsx\n```\n');
    expect(html).toContain('data-label="React"');
    expect(html).toContain('useTrack');
    expect(() => renderer.render('```ts file=../package.json\n```\n')).toThrow(/not a file under examples/);
    expect(() => renderer.render('```ts file=react/missing.tsx\n```\n')).toThrow(/ENOENT/);
    expect(() => createRenderer({ base: '/' }).render('```ts file=react/root.tsx\n```\n')).toThrow(/not a file under examples/);
  });

  it('wraps a table so it scrolls in its own box', () => {
    const { html } = render('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<div class="table-scroll" tabindex="0"><table>');
  });
});
