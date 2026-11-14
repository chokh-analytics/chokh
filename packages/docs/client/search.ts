import MiniSearch from 'minisearch';

import { SEARCH_OPTIONS } from '../src/search-options.mjs';

// The search, loaded the first time somebody opens it: the library, the
// index of every section of every page, and the list of results under the
// box. Up and Down move through the results, Enter opens one.

interface Stored {
  title: string;
  heading: string;
  url: string;
  excerpt: string;
}

const MAX_RESULTS = 8;

export async function attach(dialog: HTMLDialogElement, base: string): Promise<void> {
  const input = dialog.querySelector<HTMLInputElement>('#search-input');
  const list = dialog.querySelector<HTMLUListElement>('#search-results');
  const status = dialog.querySelector<HTMLElement>('#search-status');
  if (input === null || list === null || status === null) {
    return;
  }
  input.focus();
  status.textContent = 'Loading the index';
  let index: MiniSearch<Stored>;
  try {
    const response = await fetch(`${base}search-index.json`);
    index = MiniSearch.loadJSON<Stored>(await response.text(), SEARCH_OPTIONS);
  } catch {
    status.textContent = 'The search could not load. The menu has every page.';
    return;
  }
  status.textContent = '';

  let active = -1;
  let results: (Stored & { id: number })[] = [];

  const mark = (): void => {
    list.querySelectorAll('a').forEach((link, at) => {
      link.classList.toggle('active', at === active);
      if (at === active) {
        input.setAttribute('aria-activedescendant', link.id);
        link.scrollIntoView({ block: 'nearest' });
      }
    });
    if (active === -1) {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const draw = (): void => {
    const query = input.value.trim();
    list.replaceChildren();
    active = -1;
    if (query === '') {
      results = [];
      status.textContent = '';
      mark();
      return;
    }
    results = index.search(query).slice(0, MAX_RESULTS) as unknown as (Stored & { id: number })[];
    status.textContent =
      results.length === 0 ? `Nothing found for ${query}` : `${results.length} result${results.length === 1 ? '' : 's'}`;
    for (const [at, result] of results.entries()) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = result.url;
      link.id = `search-result-${at}`;
      const where = document.createElement('span');
      where.className = 'result-where';
      where.textContent = result.heading === '' ? result.title : `${result.title} / ${result.heading}`;
      const excerpt = document.createElement('span');
      excerpt.className = 'result-excerpt';
      excerpt.textContent = result.excerpt;
      link.append(where, excerpt);
      link.addEventListener('click', () => dialog.close());
      item.append(link);
      list.append(item);
    }
    mark();
  };

  input.addEventListener('input', draw);
  // Whatever was typed while the index was loading.
  draw();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) {
        return;
      }
      active = event.key === 'ArrowDown' ? (active + 1) % results.length : (active - 1 + results.length) % results.length;
      mark();
    } else if (event.key === 'Enter') {
      // The box sits in a form that closes the dialog; Enter opens a result.
      event.preventDefault();
      const chosen = results[Math.max(0, active)];
      if (chosen !== undefined) {
        dialog.close();
        window.location.href = chosen.url;
      }
    }
  });
  dialog.addEventListener('close', () => {
    input.value = '';
    draw();
  });
  // Opened again later: the box takes the focus each time.
  new MutationObserver(() => {
    if (dialog.open) {
      input.focus();
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
}
