// Everything that runs in a browser on a docs page. Small on purpose: every
// page works without it (the theme follows the system, every tab's code is
// shown one after another, the navigation is a list of links), and this adds
// the switches.

const THEME_KEY = 'chokh:theme';
const TAB_KEY = 'chokh-docs:tab';
const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

// Storage a browser may refuse: a private window, blocked site data. A choice
// that cannot be remembered still applies to this page.
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Not remembered, and nothing else is lost.
  }
}

// The theme: as the system says, light, or dark, in that order on each press.
function setUpTheme(): void {
  const button = document.querySelector<HTMLButtonElement>('.theme-button');
  if (button === null) {
    return;
  }
  const words: Record<Theme, string> = {
    system: "the system's setting",
    light: 'light',
    dark: 'dark',
  };
  const apply = (theme: Theme): void => {
    if (theme === 'system') {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system';
    button.dataset.current = theme;
    button.setAttribute('aria-label', `Colour theme: ${words[theme]}. Switch to ${words[next]}`);
    button.title = `Theme: ${words[theme]}`;
  };
  const stored = read(THEME_KEY);
  let current: Theme = stored === 'light' || stored === 'dark' ? stored : 'system';
  apply(current);
  button.addEventListener('click', () => {
    current = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length] ?? 'system';
    write(THEME_KEY, current === 'system' ? null : current);
    apply(current);
  });
}

// The menu on a narrow screen: a dialog, so focus stays in it, Escape closes
// it, and the page behind cannot be scrolled or clicked.
function setUpDrawer(): void {
  const drawer = document.querySelector<HTMLDialogElement>('#drawer');
  const open = document.querySelector<HTMLButtonElement>('.menu-button');
  if (drawer === null || open === null) {
    return;
  }
  open.addEventListener('click', () => {
    drawer.showModal();
    open.setAttribute('aria-expanded', 'true');
    drawer.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  });
  drawer.addEventListener('close', () => {
    open.setAttribute('aria-expanded', 'false');
    open.focus();
  });
  drawer.querySelector('.drawer-close')?.addEventListener('click', () => drawer.close());
  // A press on the dimmed page beside the menu closes it.
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) {
      drawer.close();
    }
  });
}

// A copy button on every block of code, and a word that says it worked.
function setUpCopy(): void {
  const status = document.createElement('p');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  document.body.append(status);
  for (const block of document.querySelectorAll<HTMLPreElement>('pre.code-block')) {
    const wrap = document.createElement('div');
    wrap.className = 'code';
    block.replaceWith(wrap);
    wrap.append(block);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy this code');
    wrap.append(button);
    button.addEventListener('click', async () => {
      const text = block.innerText.replace(/\n$/, '');
      let done = false;
      try {
        await navigator.clipboard.writeText(text);
        done = true;
      } catch {
        done = false;
      }
      button.textContent = done ? 'Copied' : 'Select and copy';
      status.textContent = done ? 'Copied to the clipboard' : 'Copying was refused; select the text to copy it';
      if (!done) {
        const range = document.createRange();
        range.selectNodeContents(block);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      window.setTimeout(() => {
        button.textContent = 'Copy';
      }, 1800);
    });
  }
}

// Tabs: a row of buttons over the panels of one set. The label chosen last
// is remembered, and every set on every page that has that label opens on
// it: choose Next.js once and every example after is the Next.js one.
function preferred(): string[] {
  const stored = read(TAB_KEY);
  if (stored === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

let tabSets = 0;

function setUpTabs(): void {
  const sets: { labels: string[]; select: (label: string, focus: boolean) => void }[] = [];
  for (const set of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
    tabSets += 1;
    const panels = [...set.querySelectorAll<HTMLElement>(':scope > .tab-panel')];
    const labels = panels.map((panel) => panel.dataset.label ?? '');
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    list.className = 'tab-list';
    const buttons = panels.map((panel, index) => {
      const button = document.createElement('button');
      const id = `tabs-${tabSets}-${index}`;
      button.type = 'button';
      button.id = id;
      button.setAttribute('role', 'tab');
      button.textContent = labels[index] ?? '';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', id);
      panel.id = `${id}-panel`;
      button.setAttribute('aria-controls', panel.id);
      list.append(button);
      return button;
    });
    set.prepend(list);
    set.classList.add('tabs-ready');
    const select = (label: string, focus: boolean): void => {
      const chosen = Math.max(0, labels.indexOf(label));
      buttons.forEach((button, index) => {
        const on = index === chosen;
        button.setAttribute('aria-selected', String(on));
        button.tabIndex = on ? 0 : -1;
        const panel = panels[index];
        if (panel !== undefined) {
          panel.hidden = !on;
        }
      });
      if (focus) {
        buttons[chosen]?.focus();
      }
    };
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => choose(labels[index] ?? ''));
      button.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (step === 0 && event.key !== 'Home' && event.key !== 'End') {
          return;
        }
        event.preventDefault();
        const target =
          event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1 : (index + step + labels.length) % labels.length;
        choose(labels[target] ?? '', true);
      });
    });
    sets.push({ labels, select });
  }
  const choose = (label: string, focus = false): void => {
    write(TAB_KEY, JSON.stringify([label, ...preferred().filter((item) => item !== label)].slice(0, 8)));
    for (const set of sets) {
      if (set.labels.includes(label)) {
        set.select(label, focus);
      }
    }
  };
  const remembered = preferred();
  for (const set of sets) {
    set.select(remembered.find((label) => set.labels.includes(label)) ?? set.labels[0] ?? '', false);
  }
}

// The search opens on the button, on "/" and on Ctrl+K or Cmd+K. Its code
// and its index load the first time it opens, not with the page.
function setUpSearch(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#search');
  const open = document.querySelector<HTMLButtonElement>('.search-button');
  if (dialog === null || open === null) {
    return;
  }
  const base = document.body.dataset.base ?? '/';
  let ready: Promise<void> | null = null;
  const show = (): void => {
    dialog.showModal();
    ready ??= import('./search.js').then((module) => module.attach(dialog, base));
  };
  open.addEventListener('click', show);
  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]') !== null;
    if ((event.key === '/' && !typing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
      if (!dialog.open) {
        event.preventDefault();
        show();
      }
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener('close', () => open.focus());
}

setUpTheme();
setUpDrawer();
setUpCopy();
setUpTabs();
setUpSearch();
