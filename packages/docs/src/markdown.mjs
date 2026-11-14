import { createRequire } from 'node:module';

import MarkdownIt from 'markdown-it';
import Prism from 'prismjs';

// Markdown to HTML, the way every page of the docs is written.
//
// Code is coloured here, once, at build time: no highlighter is shipped to a
// browser. Headings get an id and a link to themselves. A link that starts
// with a slash is a page of this site and gets the base path in front of it,
// so a page is written once whatever address the site is served from. And
// code blocks that follow each other with a label after the language are one
// set of tabs (the framework switcher):
//
//   ```bash PostgreSQL
//   docker compose up
//   ```
//
//   ```bash MongoDB
//   docker compose -f docker-compose.mongodb.yml up
//   ```

const require = createRequire(import.meta.url);
const loadLanguages = require('prismjs/components/index.js');
// Quiet: Prism warns on stdout about a language that is loaded twice.
loadLanguages.silent = true;
loadLanguages(['bash', 'typescript', 'jsx', 'tsx', 'json', 'yaml', 'nginx', 'diff', 'ini']);

const ALIASES = { sh: 'bash', shell: 'bash', ts: 'typescript', js: 'javascript', html: 'markup', yml: 'yaml', env: 'ini' };

// The text a heading's id is made from: lower case, letters and digits, the
// rest one hyphen. ASCII only, so an id is something a person can type.
export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A page's front matter: `key: value` lines between two `---` lines at the
// very top. Only strings, which is all a page needs.
export function splitFrontMatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (match === null) {
    return { data: {}, body: source };
  }
  const data = {};
  for (const line of match[1].split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const at = line.indexOf(':');
    if (at < 1) {
      throw new Error(`A front matter line has no key: ${JSON.stringify(line)}`);
    }
    data[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { data, body: source.slice(match[0].length) };
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// `bash PostgreSQL` is the language bash and the tab label PostgreSQL.
function parseInfo(info) {
  const trimmed = info.trim();
  const space = trimmed.search(/\s/);
  if (space === -1) {
    return { lang: trimmed, label: null };
  }
  return { lang: trimmed.slice(0, space), label: trimmed.slice(space).trim() };
}

function highlight(code, lang) {
  const name = ALIASES[lang] ?? lang;
  const grammar = Prism.languages[name];
  return grammar === undefined ? escapeHtml(code) : Prism.highlight(code, grammar, name);
}

// A fresh renderer for one build, so a base path is never carried from one
// build into another.
export function createRenderer({ base }) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

  // Consecutive labelled code blocks become one set of tabs: an opening and a
  // closing block around the run, and each block marked as a panel.
  md.core.ruler.push('code_tabs', (state) => {
    const out = [];
    const tokens = state.tokens;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== 'fence' || parseInfo(token.info).label === null) {
        out.push(token);
        continue;
      }
      const open = new state.Token('html_block', '', 0);
      open.content = '<div class="tabs" data-tabs>\n';
      out.push(open);
      while (index < tokens.length && tokens[index].type === 'fence' && parseInfo(tokens[index].info).label !== null) {
        tokens[index].meta = { ...(tokens[index].meta ?? {}), tab: parseInfo(tokens[index].info).label };
        out.push(tokens[index]);
        index += 1;
      }
      index -= 1;
      const close = new state.Token('html_block', '', 0);
      close.content = '</div>\n';
      out.push(close);
    }
    state.tokens = out;
  });

  // Ids on headings, unique within the page, and a link to each.
  md.core.ruler.push('heading_ids', (state) => {
    const seen = new Map();
    const tokens = state.tokens;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== 'heading_open') {
        continue;
      }
      if (token.tag === 'h1') {
        throw new Error('A page has no `#` heading of its own: its title comes from the front matter');
      }
      const text = tokens[index + 1].children
        .filter((child) => child.type === 'text' || child.type === 'code_inline')
        .map((child) => child.content)
        .join('');
      const stem = slugify(text) || 'section';
      const count = seen.get(stem) ?? 0;
      seen.set(stem, count + 1);
      const id = count === 0 ? stem : `${stem}-${count + 1}`;
      token.attrSet('id', id);
      token.meta = { ...(token.meta ?? {}), id, text };
    }
  });

  md.renderer.rules.heading_open = (tokens, index, options, env, self) => {
    return `${self.renderToken(tokens, index, options)}`;
  };
  md.renderer.rules.heading_close = (tokens, index, options, env, self) => {
    const open = tokens[index - 2];
    const id = open?.meta?.id;
    // For a mouse: a link to copy. Hidden from a screen reader and out of the
    // tab order, so a heading is read as its own words and not "... link
    // hash"; the "On this page" list carries the same links for everybody.
    const anchor =
      id === undefined ? '' : ` <a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>`;
    return `${anchor}${self.renderToken(tokens, index, options)}`;
  };

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const { lang } = parseInfo(token.info);
    const name = ALIASES[lang] ?? lang;
    const code = `<pre class="code-block" tabindex="0"><code class="language-${escapeHtml(name || 'text')}">${highlight(token.content, lang)}</code></pre>`;
    const tab = token.meta?.tab;
    if (tab === undefined) {
      return `${code}\n`;
    }
    return `<div class="tab-panel" data-label="${escapeHtml(tab)}"><p class="tab-label">${escapeHtml(tab)}</p>${code}</div>\n`;
  };

  // A page of this site gets the base path; an address elsewhere is marked
  // as leaving.
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const href = token.attrGet('href') ?? '';
    if (href.startsWith('/') && !href.startsWith('//')) {
      token.attrSet('href', `${base}${href.slice(1)}`);
    } else if (/^https?:\/\//.test(href)) {
      token.attrJoin('class', 'external');
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };

  // A wide table scrolls inside its own box on a phone instead of the page.
  md.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  return {
    // The page's HTML, its headings (for "On this page"), and its text by
    // section (for the search index).
    render(source) {
      const env = {};
      const tokens = md.parse(source, env);
      const headings = tokens
        .filter((token) => token.type === 'heading_open' && (token.tag === 'h2' || token.tag === 'h3'))
        .map((token) => ({ id: token.meta.id, text: token.meta.text, level: token.tag === 'h2' ? 2 : 3 }));
      const sections = [];
      let current = { id: null, heading: null, text: [] };
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type === 'heading_open' && token.tag === 'h2') {
          sections.push(current);
          current = { id: token.meta.id, heading: token.meta.text, text: [] };
          index += 2;
          continue;
        }
        if (token.type === 'inline') {
          // The words a reader sees, not the Markdown around them.
          current.text.push(
            (token.children ?? [])
              .map((child) =>
                child.type === 'text' || child.type === 'code_inline'
                  ? child.content
                  : child.type === 'softbreak' || child.type === 'hardbreak'
                    ? ' '
                    : '',
              )
              .join(''),
          );
        } else if (token.type === 'fence') {
          current.text.push(token.content);
        }
      }
      sections.push(current);
      return {
        html: md.renderer.render(tokens, md.options, env),
        headings,
        sections: sections
          .map((section) => ({ ...section, text: section.text.join(' ').replace(/\s+/g, ' ').trim() }))
          .filter((section) => section.heading !== null || section.text !== ''),
      };
    },
  };
}
