// @vitest-environment node
import { version } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChokhProvider, identify, track, useTrack } from './index.js';

// Server rendering, with no window and no document at all: the provider renders
// exactly its children, and a hook or a plain call made during a server render
// does nothing rather than throwing. Run on React 19 and React 18 like the rest.

function Page(): React.ReactElement {
  const send = useTrack();
  void send;
  track('during_render');
  identify('u_42');
  return <main>page</main>;
}

describe('on a server', () => {
  it('runs with no window, on the React the project says', () => {
    expect(typeof window).toBe('undefined');
    expect(version.split('.')[0]).toBe(process.env.CHOKH_EXPECT_REACT);
  });

  it('renders the children and nothing else', () => {
    const html = renderToString(
      <ChokhProvider site="my_site" src="https://analytics.example.com/a.js" consent={false} vitals errors>
        <Page />
      </ChokhProvider>,
    );
    expect(html).toBe('<main>page</main>');
  });
});
