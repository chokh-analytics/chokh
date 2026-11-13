import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Analytics } from './analytics.js';
import { ChokhConsent } from './consent.js';

// What <Analytics /> asks next/script for, read off the element it returns. The
// example app's browser case (examples/next-app) is where the tags are rendered
// by Next itself and a page load and a navigation are counted.

interface Tag {
  id?: string;
  src?: string;
  data: Record<string, string>;
}

function tags(element: ReactElement): Tag[] {
  const children = (element.props as { children: unknown[] }).children;
  return children.filter(isValidElement).map((child) => {
    const props = child.props as Record<string, unknown>;
    const data = Object.fromEntries(
      Object.entries(props).filter(([name]) => name.startsWith('data-')),
    ) as Record<string, string>;
    return {
      ...(typeof props.id === 'string' ? { id: props.id } : {}),
      ...(typeof props.src === 'string' ? { src: props.src } : {}),
      data,
    };
  });
}

describe('<Analytics />', () => {
  it('first-party by default: the stub, then /_pa/a.js posting to /_pa', () => {
    expect(tags(Analytics({ site: 'my_site', visitorId: 'persistent' }))).toEqual([
      { id: 'chokh-stub', data: {} },
      { id: 'chokh-tracker', src: '/_pa/a.js', data: { 'data-site': 'my_site', 'data-api': '/_pa', 'data-visitor-id': 'persistent' } },
    ]);
  });

  it('takes another path, and loads v.js and e.js beside the tracker', () => {
    expect(tags(Analytics({ site: 's', path: '/stats/', vitals: true, errors: true })).map((tag) => tag.src)).toEqual([
      undefined,
      '/stats/a.js',
      '/stats/v.js',
      '/stats/e.js',
    ]);
  });

  it('with a src of its own, posts beside it unless api says otherwise', () => {
    const own = tags(Analytics({ site: 's', src: 'https://analytics.example.com/a.js' }));
    expect(own[1]).toEqual({ id: 'chokh-tracker', src: 'https://analytics.example.com/a.js', data: { 'data-site': 's' } });
    const api = tags(Analytics({ site: 's', src: 'https://analytics.example.com/a.js', api: '/collect-here' }));
    expect(api[1]?.data['data-api']).toBe('/collect-here');
  });

  it('with consent, gates the tag and adds the one client part that follows it', () => {
    const element = Analytics({ site: 's', consent: false });
    expect(tags(element)[1]?.data['data-consent']).toBe('');
    const children = (element.props as { children: unknown[] }).children.filter(isValidElement);
    expect(children.some((child) => child.type === ChokhConsent)).toBe(true);
    const ungated = (Analytics({ site: 's' }).props as { children: unknown[] }).children.filter(isValidElement);
    expect(ungated.some((child) => child.type === ChokhConsent)).toBe(false);
  });
});
