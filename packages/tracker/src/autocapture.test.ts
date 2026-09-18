import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { elementProps, linkEvent, watchClicks } from './autocapture';

function anchor(href: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  return link;
}

beforeAll(() => {
  // jsdom cannot navigate, and a real anchor click would try. The tracker reads
  // the click before the default action, so cancelling it changes nothing.
  document.addEventListener('click', (event) => {
    event.preventDefault();
  });
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('elementProps', () => {
  it('reads every data-pa-prop attribute', () => {
    const el = document.createElement('button');
    el.setAttribute('data-pa-event', 'cta_click');
    el.setAttribute('data-pa-prop-plan', 'pro');
    el.setAttribute('data-pa-prop-place', 'header');
    el.setAttribute('data-other', 'ignored');
    expect(elementProps(el)).toEqual({ plan: 'pro', place: 'header' });
  });

  it('is undefined when the element carries none', () => {
    const el = document.createElement('button');
    el.setAttribute('data-pa-event', 'cta_click');
    expect(elementProps(el)).toBeUndefined();
  });
});

describe('linkEvent', () => {
  it('calls a link to another host outbound', () => {
    expect(linkEvent(anchor('https://elsewhere.test/page'), 'example.test')).toBe('outbound_link');
  });

  it('calls a link to a file on this host a download', () => {
    expect(linkEvent(anchor('https://example.test/files/report.pdf'), 'example.test')).toBe(
      'file_download',
    );
  });

  it('ignores an ordinary link on this host', () => {
    expect(linkEvent(anchor('https://example.test/courses'), 'example.test')).toBeNull();
  });

  it('ignores mailto and tel links', () => {
    expect(linkEvent(anchor('mailto:someone@example.test'), 'example.test')).toBeNull();
    expect(linkEvent(anchor('tel:+8801000000'), 'example.test')).toBeNull();
  });

  it('ignores an extension that is not a download', () => {
    expect(linkEvent(anchor('https://example.test/page.html'), 'example.test')).toBeNull();
  });
});

describe('watchClicks', () => {
  it('tracks a marked element with its properties', () => {
    const track = vi.fn();
    watchClicks(document, 'example.test', track);

    document.body.innerHTML =
      '<button data-pa-event="cta_click" data-pa-prop-plan="pro"><span>Buy</span></button>';
    document.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(track).toHaveBeenCalledWith('cta_click', { plan: 'pro' });
  });

  it('tracks an outbound click with the url', () => {
    const track = vi.fn();
    watchClicks(document, 'example.test', track);

    document.body.innerHTML = '<a href="https://elsewhere.test/x">Go</a>';
    document.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(track).toHaveBeenCalledWith('outbound_link', { url: 'https://elsewhere.test/x' });
  });

  it('leaves an ordinary click alone', () => {
    const track = vi.fn();
    watchClicks(document, 'example.test', track);

    document.body.innerHTML = '<div>nothing here</div>';
    document.querySelector('div')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(track).not.toHaveBeenCalled();
  });
});
