import { StrictMode, act, useEffect, useState, version, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChokhProvider, useChokh, useTrack } from './index.js';

// Every case runs twice, on React 19 and on React 18 (vitest.config.ts), and the
// first one proves which React this run really loaded.
//
// jsdom does not run the scripts these cases add, so what is asserted is the
// document (one tag, its attributes) and the tracker's own queue, window.pa.q,
// which is what a.js replays when it boots. The real a.js, booted in a real
// browser under strict mode, is the Playwright case in e2e/.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Queued {
  pa?: ((...args: unknown[]) => void) & { q?: unknown[][] };
}
const page = (): Queued => window as unknown as Queued;
const queued = (): unknown[][] => page().pa?.q ?? [];
const tags = (): HTMLScriptElement[] => Array.from(document.querySelectorAll('script'));

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  for (const script of tags()) script.remove();
  delete page().pa;
});

function render(element: ReactElement): void {
  act(() => {
    root ??= createRoot(container);
    root.render(element);
  });
}

const SRC = 'https://analytics.example.com/a.js';

describe('the React this run loaded', () => {
  it('is the one the project says', () => {
    expect(version.split('.')[0]).toBe(process.env.CHOKH_EXPECT_REACT);
  });
});

describe('<ChokhProvider>', () => {
  it('renders its children and adds the tracker tag, with its settings', () => {
    render(
      <ChokhProvider site="my_site" src={SRC} api="/_pa" visitorId="persistent" hashRouting respectDnt>
        <p>hello</p>
      </ChokhProvider>,
    );
    expect(container.innerHTML).toBe('<p>hello</p>');
    expect(tags()).toHaveLength(1);
    const tag = tags()[0] as HTMLScriptElement;
    expect(tag.id).toBe('chokh-tracker');
    expect(tag.src).toBe(SRC);
    expect(tag.async).toBe(true);
    expect(Object.fromEntries(tag.getAttributeNames().filter((name) => name.startsWith('data-')).map((name) => [name, tag.getAttribute(name)]))).toEqual({
      'data-site': 'my_site',
      'data-api': '/_pa',
      'data-visitor-id': 'persistent',
      'data-hash': '',
      'data-dnt': '',
    });
    expect(tag.parentElement).toBe(document.head);
  });

  it('adds one tag under strict mode, whose effects run twice', () => {
    render(
      <StrictMode>
        <ChokhProvider site="my_site" src={SRC}>
          <p>strict</p>
        </ChokhProvider>
      </StrictMode>,
    );
    expect(tags()).toHaveLength(1);
  });

  it('adds one tag for two providers, and none over a tag already in the page', () => {
    render(
      <>
        <ChokhProvider site="my_site" src={SRC} />
        <ChokhProvider site="my_site" src={SRC} />
      </>,
    );
    expect(tags()).toHaveLength(1);
    act(() => root?.unmount());
    root = undefined;

    for (const script of tags()) script.remove();
    const written = document.createElement('script');
    written.id = 'chokh-tracker';
    document.head.appendChild(written);
    render(<ChokhProvider site="my_site" src={SRC} />);
    expect(tags()).toEqual([written]);
  });

  it('keeps the tag when it unmounts and adds no second one when it mounts again', () => {
    render(<ChokhProvider site="my_site" src={SRC} />);
    act(() => root?.unmount());
    root = undefined;
    expect(tags()).toHaveLength(1);
    render(<ChokhProvider site="my_site" src={SRC} />);
    expect(tags()).toHaveLength(1);
  });

  it('never sends a pageview of its own: the tracker counts pages', () => {
    render(
      <StrictMode>
        <ChokhProvider site="my_site" src={SRC} />
      </StrictMode>,
    );
    expect(queued().filter((call) => call[0] === 'pageview')).toEqual([]);
    expect(queued()).toEqual([]);
  });

  it('adds v.js and e.js beside the tracker, or from their own URLs', () => {
    render(<ChokhProvider site="my_site" src={SRC} vitals errors />);
    expect(tags().map((tag) => [tag.id, tag.src])).toEqual([
      ['chokh-tracker', SRC],
      ['chokh-vitals', 'https://analytics.example.com/v.js'],
      ['chokh-errors', 'https://analytics.example.com/e.js'],
    ]);
    act(() => root?.unmount());
    root = undefined;
    for (const script of tags()) script.remove();

    render(<ChokhProvider site="my_site" src="/_pa/a.js" vitals="/cdn/vitals.js" errors={false} />);
    expect(tags().map((tag) => tag.getAttribute('src'))).toEqual(['/_pa/a.js', '/cdn/vitals.js']);
  });

  it('with no consent prop, puts no gate on the tag and says nothing about consent', () => {
    render(<ChokhProvider site="my_site" src={SRC} />);
    expect(tags()[0]?.hasAttribute('data-consent')).toBe(false);
    expect(queued()).toEqual([]);
  });

  it('with a consent prop, gates the tag, sends a grant, and later a withdrawal, once each', () => {
    function Banner(): ReactElement {
      const [granted, setGranted] = useState(false);
      return (
        <ChokhProvider site="my_site" src={SRC} consent={granted}>
          <button type="button" onClick={() => setGranted(!granted)}>
            Toggle
          </button>
        </ChokhProvider>
      );
    }
    render(
      <StrictMode>
        <Banner />
      </StrictMode>,
    );
    expect(tags()[0]?.getAttribute('data-consent')).toBe('');
    // Not yet granted is not withdrawn: a starting false is never sent, or the
    // tracker would throw away the pageview it is holding.
    expect(queued()).toEqual([]);
    act(() => container.querySelector('button')?.click());
    expect(queued()).toEqual([['consent', true]]);
    act(() => container.querySelector('button')?.click());
    expect(queued()).toEqual([
      ['consent', true],
      ['consent', false],
    ]);
    expect(tags()).toHaveLength(1);
  });

  it('sends a consent granted from the start, once, under strict mode', () => {
    render(
      <StrictMode>
        <ChokhProvider site="my_site" src={SRC} consent />
      </StrictMode>,
    );
    expect(queued()).toEqual([['consent', true]]);
  });
});

describe('useTrack and useChokh', () => {
  it('useTrack is the same function on every render, and queues the event for the tracker', () => {
    const seen: unknown[] = [];
    function Button(): ReactElement {
      const track = useTrack();
      const [count, setCount] = useState(0);
      seen.push(track);
      return (
        <button
          type="button"
          onClick={() => {
            track('signup', { plan: 'pro', seats: 3 });
            setCount(count + 1);
          }}
        >
          {count}
        </button>
      );
    }
    render(<Button />);
    act(() => container.querySelector('button')?.click());
    act(() => container.querySelector('button')?.click());
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
    expect(queued()).toEqual([
      ['event', 'signup', { plan: 'pro', seats: 3 }],
      ['event', 'signup', { plan: 'pro', seats: 3 }],
    ]);
  });

  it('useChokh names, forgets and gates, with the signature as the fourth argument', () => {
    function Session(): ReactElement {
      const chokh = useChokh();
      useEffect(() => {
        chokh.identify('u_42', { plan: 'pro' }, 'sig_from_server');
        chokh.reset();
        chokh.consent(true);
      }, [chokh]);
      return <p>session</p>;
    }
    render(
      <StrictMode>
        <Session />
      </StrictMode>,
    );
    // Strict mode runs the effect twice; that is the application's effect, and
    // what it sends twice is an identify, never a page.
    expect(queued().slice(0, 3)).toEqual([
      ['identify', 'u_42', { plan: 'pro' }, 'sig_from_server'],
      ['reset'],
      ['consent', true],
    ]);
  });

  it('calls a booted tracker directly rather than queueing', () => {
    const calls: unknown[][] = [];
    page().pa = (...args: unknown[]) => calls.push(args);
    function Button(): ReactElement {
      const track = useTrack();
      return (
        <button type="button" onClick={() => track('clicked')}>
          go
        </button>
      );
    }
    render(<Button />);
    act(() => container.querySelector('button')?.click());
    expect(calls).toEqual([['event', 'clicked', undefined]]);
  });
});
