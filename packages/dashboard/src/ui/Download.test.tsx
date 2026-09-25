// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import * as download from '../lib/download.js';
import { Download } from './Download.js';

// The control every card carries: CSV is a link to the server's file, JSON
// saves what the page holds and waits until it holds something.

describe('Download', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a group named for the card, with a CSV link and a JSON button', () => {
    render(
      <Download
        csvHref="/api/sites/s_test/export.csv?report=goals&from=1&to=2"
        json={() => ({ rows: [] })}
        name="s_test-goals-2026-09-17-2026-09-18"
        title="Goals"
      />,
    );
    const group = screen.getByRole('group', { name: 'Download Goals' });
    expect(group).toBeInTheDocument();
    const csv = screen.getByRole('link', { name: 'Download CSV' });
    expect(csv).toHaveAttribute('href', '/api/sites/s_test/export.csv?report=goals&from=1&to=2');
    expect(csv).toHaveAttribute('download');
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeEnabled();
  });

  it('saves what the page holds under the file name, and cannot until it holds it', async () => {
    const save = vi.spyOn(download, 'saveJson').mockImplementation(() => {});
    const { rerender } = render(
      <Download csvHref="/x.csv" json={() => undefined} name="s_test-goals-a-b" title="Goals" />,
    );
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeDisabled();

    rerender(
      <Download csvHref="/x.csv" json={() => ({ rows: [1] })} name="s_test-goals-a-b" title="Goals" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download JSON' }));
    expect(save).toHaveBeenCalledWith('s_test-goals-a-b', { rows: [1] });
  });
});
