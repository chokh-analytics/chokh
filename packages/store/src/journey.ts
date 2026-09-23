import {
  DEFAULT_JOURNEY_BRANCHES,
  JOURNEY_STEPS,
  MAX_JOURNEY_BRANCHES,
  StoreQueryError,
  type JourneyLink,
  type JourneyNode,
  type JourneyQuery,
  type JourneyResult,
} from './query.js';

// The journeys report's arithmetic, in one place. The in-memory adapter runs
// every step here; the MongoDB adapter builds the paths and folds them in the
// database, over two round trips, and hands its grouped counts to
// finishJourneys, so the report is assembled the same way from both.

// How many branches a read keeps per column: the one asked for, else five.
export function journeyBranches(query: JourneyQuery): number {
  const branches = query.branches ?? DEFAULT_JOURNEY_BRANCHES;
  if (!Number.isInteger(branches) || branches < 1 || branches > MAX_JOURNEY_BRANCHES) {
    throw new StoreQueryError(
      'INVALID_BRANCHES',
      `A journeys read keeps between 1 and ${MAX_JOURNEY_BRANCHES} branches per column`,
    );
  }
  return branches;
}

export interface JourneyPath {
  // The first JOURNEY_STEPS pages, repeats back to back counted once.
  steps: string[];
  // Whether the visit went on past them.
  onward: boolean;
}

// One visit's pageview paths, in time order, as a journey.
export function journeyPath(paths: readonly string[]): JourneyPath {
  const collapsed: string[] = [];
  for (const path of paths) {
    if (collapsed[collapsed.length - 1] !== path) {
      collapsed.push(path);
    }
  }
  return { steps: collapsed.slice(0, JOURNEY_STEPS), onward: collapsed.length > JOURNEY_STEPS };
}

// Code unit order, which is what MongoDB's $sort does to an ASCII path and
// what localeCompare does not, so a tie breaks the same way in both adapters.
function byKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Each column's most visited pages, most first, ties by path.
export function topJourneyPages(paths: readonly JourneyPath[], branches: number): string[][] {
  const tops: string[][] = [];
  for (let column = 0; column < JOURNEY_STEPS; column += 1) {
    const counts = new Map<string, number>();
    for (const path of paths) {
      const page = path.steps[column];
      if (page !== undefined) counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    tops.push(
      [...counts]
        .sort((left, right) => right[1] - left[1] || byKey(left[0], right[0]))
        .slice(0, branches)
        .map(([page]) => page),
    );
  }
  return tops;
}

// What one visit says about one column: the node it was at, and whether it went
// on to a node of the next column, ended there, or went on past the last.
export interface JourneyStepCount {
  column: number;
  from: string | null;
  to: string | null;
  end: 'next' | 'exit' | 'onward';
  visits: number;
}

// Every visit folded onto the top pages and counted per column. The MongoDB
// adapter's second round trip answers exactly these rows.
export function journeyStepCounts(
  paths: readonly JourneyPath[],
  tops: readonly (readonly string[])[],
): JourneyStepCount[] {
  const counts = new Map<string, JourneyStepCount>();
  for (const path of paths) {
    const keys = path.steps.map((page, column) =>
      tops[column]?.includes(page) === true ? page : null,
    );
    keys.forEach((from, column) => {
      const hasNext = column + 1 < keys.length;
      const end = hasNext
        ? 'next'
        : column === JOURNEY_STEPS - 1 && path.onward
          ? 'onward'
          : 'exit';
      const to = hasNext ? (keys[column + 1] ?? null) : null;
      const id = JSON.stringify([column, from, to, end]);
      const seen = counts.get(id);
      if (seen === undefined) {
        counts.set(id, { column, from, to, end, visits: 1 });
      } else {
        seen.visits += 1;
      }
    });
  }
  return [...counts.values()];
}

// Most visited first, ties by path, and Other last whatever its size: it is
// the rest of the column, not a page.
function compareKeys(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return byKey(left, right);
}

export function finishJourneys(
  counts: readonly JourneyStepCount[],
  branches: number,
): JourneyResult {
  const columns: Map<string | null, JourneyNode>[] = Array.from(
    { length: JOURNEY_STEPS },
    () => new Map(),
  );
  const links: JourneyLink[] = [];
  for (const count of counts) {
    const nodes = columns[count.column];
    if (nodes === undefined) continue;
    const node = nodes.get(count.from) ?? { key: count.from, visits: 0, exits: 0, onward: 0 };
    nodes.set(count.from, node);
    node.visits += count.visits;
    if (count.end === 'exit') node.exits += count.visits;
    if (count.end === 'onward') node.onward += count.visits;
    if (count.end === 'next') {
      links.push({ column: count.column, from: count.from, to: count.to, visits: count.visits });
    }
  }
  const ordered = columns.map((nodes) =>
    [...nodes.values()].sort(
      (left, right) =>
        (left.key === null ? 1 : 0) - (right.key === null ? 1 : 0) ||
        right.visits - left.visits ||
        compareKeys(left.key, right.key),
    ),
  );
  links.sort(
    (left, right) =>
      left.column - right.column ||
      right.visits - left.visits ||
      compareKeys(left.from, right.from) ||
      compareKeys(left.to, right.to),
  );
  const visits = ordered[0]?.reduce((total, node) => total + node.visits, 0) ?? 0;
  return { visits, columns: ordered, links, branches, rawOnly: true };
}
