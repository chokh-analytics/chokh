import { answer } from '../../e2e/fixture-answers.mjs';
// The server's own tables for a report's CSV: the demo's file has the
// columns a real install's has. Pure functions with type imports only, so
// they run in a browser; the demo build is the only thing that brings them
// into the dashboard.
import {
  breakdownTable,
  csvOf,
  engagementTable,
  eventsTable,
  funnelTable,
  goalsTable,
  journeysTable,
  propertiesTable,
  timeseriesTable,
  type CsvTable,
} from '../../../server/src/lib/csv-report.js';

// The demo's downloads.
//
// A report's "Download CSV" is a plain link to /api/sites/:siteId/export.csv,
// which the server answers with a file. The demo has no server, and a static
// host answers that address with its own 404, outside the demo. So a click on
// any link into /api is caught before the browser follows it, and the file is
// made here, from the same answers the demo's reports are drawn from. An
// address it cannot make a file for gets a short notice instead, and the
// reader stays where they were.

type Data = Record<string, unknown>;

function data(path: string, params: URLSearchParams): Data | null {
  const found = answer(path, params, { licensed: true });
  const body = found.body as { success?: boolean; data?: Data };
  return found.status === 200 && body.success === true && body.data !== undefined ? body.data : null;
}

// The table for one export address, or null when there is none to make.
export function demoCsvTable(url: URL): CsvTable | null {
  const match = /^\/api\/sites\/([^/]+)\/export\.csv$/.exec(url.pathname);
  if (match === null) {
    return null;
  }
  const site = `/api/sites/${match[1]}`;
  const params = url.searchParams;
  const kind = params.get('report') ?? 'breakdown';
  const read = (route: string): Data | null => data(`${site}/${route}`, params);
  // Each table is built as the server builds it, and a shape it does not
  // expect is a file not made, never a page that breaks.
  try {
    switch (kind) {
      case 'breakdown': {
        const result = read('stats/breakdown');
        return result === null ? null : breakdownTable(result as never, params.get('goal') !== null);
      }
      case 'timeseries': {
        const result = read('stats/timeseries');
        return result === null ? null : timeseriesTable(result as never);
      }
      case 'engagement': {
        const result = read('stats/engagement');
        return result === null ? null : engagementTable(result as never);
      }
      case 'events': {
        const result = read('stats/events');
        return result === null ? null : eventsTable(result as never);
      }
      case 'properties': {
        const result = read('stats/properties');
        return result === null ? null : propertiesTable(result as never);
      }
      case 'goals': {
        const result = read('stats/goals');
        const goals = read('goals');
        return result === null || goals === null ? null : goalsTable(result as never, goals['goals'] as never);
      }
      case 'funnel': {
        const result = read('stats/funnel');
        const funnels = (read('funnels')?.['funnels'] ?? []) as { id: string }[];
        const funnel = funnels.find((one) => one.id === params.get('funnel'));
        return result === null || funnel === undefined ? null : funnelTable(result as never, funnel as never);
      }
      case 'journeys': {
        const result = read('stats/journeys');
        return result === null ? null : journeysTable(result as never);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function save(name: string, text: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// A notice at the foot of the screen, read out once, gone after a while.
function notice(text: string): void {
  const box = document.createElement('p');
  box.setAttribute('role', 'status');
  box.textContent = text;
  Object.assign(box.style, {
    position: 'fixed',
    left: '50%',
    bottom: '16px',
    transform: 'translateX(-50%)',
    margin: '0',
    padding: '8px 16px',
    maxWidth: 'calc(100vw - 32px)',
    background: 'var(--paper)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow-pop)',
    zIndex: '1000',
  });
  document.body.append(box);
  window.setTimeout(() => box.remove(), 5000);
}

export function installDemoDownloads(): void {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(target instanceof HTMLAnchorElement)) {
      return;
    }
    const url = new URL(target.href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return;
    }
    event.preventDefault();
    const table = demoCsvTable(url);
    if (table === null) {
      notice('Downloads of this report are switched off in the demo.');
      return;
    }
    const kind = url.searchParams.get('report') ?? url.searchParams.get('dim') ?? 'report';
    save(`chokh-demo-${kind}.csv`, csvOf(table));
  });
}
