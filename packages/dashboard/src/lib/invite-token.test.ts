import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as InviteToken from './invite-token.js';

// The token of an invitation link: out of the address bar the moment the
// module loads, in memory and nowhere else.

const TOKEN = 'chi_an-invented-token-for-a-test-0123456789';

// Each case loads the module afresh, and each copy listens for the fragment
// changing. A page only ever has one copy, so the listeners of the copies
// before are taken off again here, or the first of them would take the
// fragment before the copy under test saw it.
const listening: EventListener[] = [];

async function load(): Promise<typeof InviteToken> {
  vi.resetModules();
  const add = window.addEventListener.bind(window);
  const spy = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'hashchange') listening.push(listener as EventListener);
      add(type, listener);
    });
  const module = await import('./invite-token.js');
  spy.mockRestore();
  return module;
}

function everythingStored(): string {
  const parts: string[] = [];
  for (const area of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < area.length; index += 1) {
      const key = area.key(index) ?? '';
      parts.push(key, area.getItem(key) ?? '');
    }
  }
  return parts.join('\n');
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete window.__chokhInvite;
});

afterEach(() => {
  for (const listener of listening.splice(0)) {
    window.removeEventListener('hashchange', listener);
  }
  window.history.replaceState(null, '', '/');
});

describe('the invitation token', () => {
  it('is taken out of the address bar when the module loads, and kept', async () => {
    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    const entries = window.history.length;
    const module = await load();

    // Gone from the address, by a replacement and not a navigation: no new
    // entry, so going back does not lead to the link either.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/invite');
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.history.length).toBe(entries);

    expect(module.inviteToken()).toBe(TOKEN);
    // Reading it does not forget it: the page needs it twice.
    expect(module.inviteToken()).toBe(TOKEN);
  });

  it('is collected from where the inline script parked it, and that place is cleared', async () => {
    // What index.html leaves behind: the fragment already gone, the token
    // parked for the module.
    window.history.replaceState(null, '', '/invite');
    window.__chokhInvite = TOKEN;
    const module = await load();
    expect(window.__chokhInvite).toBeUndefined();
    expect('__chokhInvite' in window).toBe(false);
    expect(module.inviteToken()).toBe(TOKEN);
  });

  it('is written to no storage area', async () => {
    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    const module = await load();
    module.inviteToken();
    expect(everythingStored()).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
  });

  it('is forgotten when asked, and is not there at all on a page opened without one', async () => {
    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    const module = await load();
    module.forgetInviteToken();
    expect(module.inviteToken()).toBeNull();

    window.history.replaceState(null, '', '/invite');
    expect((await load()).inviteToken()).toBeNull();
  });

  // Opened again in a tab that is already on the page: a change of fragment
  // and not a load, so nothing that runs at load would take it off.
  it('is taken off again when the link is opened in a tab already on the page', async () => {
    window.history.replaceState(null, '', '/invite');
    const module = await load();
    expect(module.inviteToken()).toBeNull();
    let told = 0;
    const stop = module.onInviteToken(() => {
      told += 1;
    });

    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    window.dispatchEvent(new Event('hashchange'));
    expect(window.location.href).not.toContain(TOKEN);
    expect(module.inviteToken()).toBe(TOKEN);
    expect(told).toBe(1);

    // Nobody is told about a change that brought nothing.
    window.dispatchEvent(new Event('hashchange'));
    expect(told).toBe(1);
    stop();
  });

  it('leaves a fragment on any other page alone', async () => {
    window.history.replaceState(null, '', `/s_demo/pages#${TOKEN}`);
    const module = await load();
    expect(module.inviteToken()).toBeNull();
    expect(window.location.hash).toBe(`#${TOKEN}`);
  });
});
