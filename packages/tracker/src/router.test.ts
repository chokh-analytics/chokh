import { describe, expect, it, vi } from 'vitest';

import { pagePath, readUtm, watchNavigation } from './router';

describe('pagePath', () => {
  it('reports the pathname and leaves the query out, so one page is one row', () => {
    expect(pagePath({ pathname: '/courses', hash: '#top' }, false)).toBe('/courses');
  });

  it('adds the hash when the site routes on it', () => {
    expect(pagePath({ pathname: '/app', hash: '#/settings' }, true)).toBe('/app#/settings');
  });
});

describe('readUtm', () => {
  it('reads the five campaign parameters', () => {
    expect(
      readUtm('?utm_source=facebook&utm_medium=social&utm_campaign=imupc&utm_term=cp&utm_content=a'),
    ).toEqual({
      source: 'facebook',
      medium: 'social',
      campaign: 'imupc',
      term: 'cp',
      content: 'a',
    });
  });

  it('keeps only the parameters that are present', () => {
    expect(readUtm('?utm_source=google&ref=x')).toEqual({ source: 'google' });
  });

  it('is undefined when there is no campaign', () => {
    expect(readUtm('')).toBeUndefined();
    expect(readUtm('?page=2')).toBeUndefined();
  });
});

describe('watchNavigation', () => {
  it('fires on pushState, replaceState and popstate', () => {
    const onChange = vi.fn();
    watchNavigation(window, false, onChange);

    window.history.pushState({}, '', '/one');
    expect(onChange).toHaveBeenCalledTimes(1);

    window.history.replaceState({}, '', '/two');
    expect(onChange).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('keeps the history methods working', () => {
    const onChange = vi.fn();
    watchNavigation(window, false, onChange);

    window.history.pushState({}, '', '/deep/path');
    expect(window.location.pathname).toBe('/deep/path');
  });

  it('ignores hashchange unless the site opted in', () => {
    const quiet = vi.fn();
    watchNavigation(window, false, quiet);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(quiet).not.toHaveBeenCalled();

    const loud = vi.fn();
    watchNavigation(window, true, loud);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(loud).toHaveBeenCalledTimes(1);
  });
});
