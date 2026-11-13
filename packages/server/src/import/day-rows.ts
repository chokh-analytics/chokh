import {
  BOT_DIMENSION,
  ROLLUP_TOTAL_DIM,
  routeMatchers,
  routeOf,
  zeroTotals,
  type ImportRow,
  type RollupDim,
  type Totals,
} from '../store/AnalyticsStore.js';

// What an importer builds: totals per day, dimension and value, added up as
// rows of the source arrive (a source's rows are often finer than a rollup's:
// browser versions, a page per hostname), then written out as import rows.

export interface Accumulator {
  add(date: string, dim: RollupDim, key: string, totals: Partial<Totals>): void;
  // Rows the source had that could not be filed, by reason, for the report.
  skip(reason: string, count?: number): void;
  readonly skipped: ReadonlyMap<string, number>;
  rows(routeRules: readonly string[]): ImportRow[];
}

const DIM_ORDER = (dim: RollupDim): number => (dim === ROLLUP_TOTAL_DIM ? 0 : dim === BOT_DIMENSION ? 1 : 2);

export function createAccumulator(): Accumulator {
  const cells = new Map<string, { date: string; dim: RollupDim; key: string; totals: Totals }>();
  const skipped = new Map<string, number>();

  function add(date: string, dim: RollupDim, key: string, totals: Partial<Totals>): void {
    const id = `${date}\n${dim}\n${key}`;
    let cell = cells.get(id);
    if (cell === undefined) {
      cell = { date, dim, key, totals: zeroTotals() };
      cells.set(id, cell);
    }
    cell.totals.visitors += totals.visitors ?? 0;
    cell.totals.pageviews += totals.pageviews ?? 0;
    cell.totals.visits += totals.visits ?? 0;
    cell.totals.bounces += totals.bounces ?? 0;
    cell.totals.durationSum += totals.durationSum ?? 0;
  }

  return {
    add,
    skip(reason, count = 1) {
      skipped.set(reason, (skipped.get(reason) ?? 0) + count);
    },
    skipped,
    rows(routeRules) {
      // The route of each page under the site's rules, as rollupDay files it;
      // without rules a route is its page. Visitors of pages a rule folds
      // together are added, so a person on two of them counts twice.
      const matchers = routeMatchers(routeRules);
      const pages = [...cells.values()].filter((cell) => cell.dim === 'page');
      for (const page of pages) {
        add(page.date, 'route', routeOf(page.key, matchers), page.totals);
      }
      // The bot series beside the totals: everything imported is people, so
      // a read asking for humans only finds the same numbers.
      const totals = [...cells.values()].filter((cell) => cell.dim === ROLLUP_TOTAL_DIM);
      for (const total of totals) {
        add(total.date, BOT_DIMENSION, 'false', total.totals);
      }
      return [...cells.values()]
        .map((cell): ImportRow => ({
          date: cell.date,
          dim: cell.dim,
          key: cell.key,
          visitors: Math.round(cell.totals.visitors),
          pageviews: Math.round(cell.totals.pageviews),
          visits: Math.round(cell.totals.visits),
          bounces: Math.round(cell.totals.bounces),
          durationSum: Math.round(cell.totals.durationSum),
        }))
        .sort(
          (left, right) =>
            (left.date < right.date ? -1 : left.date > right.date ? 1 : 0) ||
            DIM_ORDER(left.dim) - DIM_ORDER(right.dim) ||
            (left.dim < right.dim ? -1 : left.dim > right.dim ? 1 : 0) ||
            (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
        );
    },
  };
}

// A whole number of 0 or more from a CSV or JSON cell; anything else is 0, and
// the parser that called it decides whether that is worth a word.
export function count(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// A device as the collector files it: desktop, mobile or tablet.
export function deviceOf(value: string | undefined): 'desktop' | 'mobile' | 'tablet' | undefined {
  const lower = (value ?? '').trim().toLowerCase();
  if (lower === 'desktop' || lower === 'laptop') return 'desktop';
  if (lower === 'mobile' || lower === 'phone' || lower === 'smartphone') return 'mobile';
  if (lower === 'tablet') return 'tablet';
  return undefined;
}

// A source's "nothing here": empty, or one of the placeholders tools write.
export function isUnset(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed === '(not set)' || trimmed === '(none)' || trimmed === '(direct)' || trimmed === 'Unknown';
}
