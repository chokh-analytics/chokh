import {
  BOT_DIMENSION,
  FUNNEL_WINDOW_MS,
  MAX_FUNNEL_STEPS,
  MIN_FUNNEL_STEPS,
  SESSION_DIMENSIONS,
  StoreQueryError,
  conversionMatcher,
  type Filter,
  type FunnelRead,
  type FunnelResult,
  type FunnelStepResult,
  type FunnelWindow,
  type GoalMatch,
} from './query.js';
import type { StoredEvent } from './types.js';

// The funnel fold, in one place, and the helpers both adapters count with.
//
// The fold exists twice: here, which the in-memory adapter runs, and as a
// $reduce in the MongoDB adapter, because shipping every step row of a busy
// range to this process to fold it here would cost more than the read. Two
// tests keep them one rule: a brute force over every possible chain on seeded
// sequences holds this one to the definition in query.ts, and store-mongo
// runs the same sequences through its $reduce and compares.

// How many step rows of one visitor a read folds: the first thousand in time
// order. No person reaches it; it is what stops a read that asks for the bots
// from gathering one crawler's hundred thousand rows into one group.
export const MAX_FUNNEL_ROWS_PER_VISITOR = 1000;

// The length of a window in milliseconds. A visit has no bound beyond the
// visit, which is a partition and not a length, so its number is one no two
// timestamps are ever that far apart.
export function funnelWindowMs(window: FunnelWindow): number {
  return window === 'visit' ? Number.MAX_SAFE_INTEGER : FUNNEL_WINDOW_MS[window];
}

// A read's belt to the route's braces: a funnel of one step is a goal, and a
// funnel longer than the ceiling is a read nobody sized.
export function assertFunnelSteps(funnel: FunnelRead): void {
  if (funnel.steps.length < MIN_FUNNEL_STEPS || funnel.steps.length > MAX_FUNNEL_STEPS) {
    throw new StoreQueryError(
      'INVALID_FUNNEL',
      `A funnel has between ${MIN_FUNNEL_STEPS} and ${MAX_FUNNEL_STEPS} steps`,
    );
  }
}

// One row as the fold sees it: when, and which steps it reaches. A row can
// reach more than one step (a pattern and an exact path on the same page, or a
// funnel that repeats a page).
export interface FunnelRow {
  ts: number;
  hits: readonly boolean[];
}

export function funnelHits(steps: readonly GoalMatch[]): (event: StoredEvent) => boolean[] {
  const matchers = steps.map((step) => conversionMatcher(step));
  return (event) => matchers.map((reached) => reached(event));
}

// The lowest step a row reaches, and every step it reaches as one number.
// Together with the time they are the order rows are folded in, so two rows at
// the same millisecond are taken in the funnel's order in both adapters, and
// two rows that differ only in what else they reach are still in one order.
export function firstHit(hits: readonly boolean[]): number {
  const at = hits.indexOf(true);
  return at === -1 ? hits.length : at;
}

export function hitMask(hits: readonly boolean[]): number {
  return hits.reduce((mask, hit, index) => (hit ? mask + 2 ** index : mask), 0);
}

export function compareFunnelRows(left: FunnelRow, right: FunnelRow): number {
  return (
    left.ts - right.ts ||
    firstHit(left.hits) - firstHit(right.hits) ||
    hitMask(left.hits) - hitMask(right.hits)
  );
}

// How many steps one visitor reached, from their rows in funnel order.
//
// For each step it keeps the latest start of any chain that has reached it. A
// later start with the same progress is never worse: the rows still to come are
// the same for both, and it has more of the window left. So keeping only that
// one is exact rather than greedy. A row reaching step k extends the best chain
// at step k - 1 when it is inside the window of that chain's start; a row
// reaching the first step starts a chain. Every step is updated from the state
// before the row, which is what stops one row from being two steps.
export function funnelDepth(rows: readonly FunnelRow[], windowMs: number): number {
  const steps = rows[0]?.hits.length ?? 0;
  let best: (number | null)[] = new Array<number | null>(steps).fill(null);
  for (const row of rows) {
    const next = best.slice();
    for (let step = 0; step < steps; step += 1) {
      if (row.hits[step] !== true) {
        continue;
      }
      if (step === 0) {
        next[0] = row.ts;
        continue;
      }
      const start = best[step - 1] ?? null;
      if (start !== null && row.ts - start <= windowMs) {
        const current = next[step] ?? null;
        next[step] = current === null ? start : Math.max(current, start);
      }
    }
    best = next;
  }
  // A step is only ever reached from the one before it, so the reached steps
  // are always the first few.
  return best.filter((start) => start !== null).length;
}

// Which of a read's filters narrow the people by their rows, and which by
// their stays. The bot filter is neither: it chooses the side of the line every
// half reads.
export function splitVisitFilters(filters: Filter[] | undefined): {
  event: Filter[];
  stay: Filter[];
} {
  const event: Filter[] = [];
  const stay: Filter[] = [];
  for (const filter of filters ?? []) {
    if (filter.dim === BOT_DIMENSION) continue;
    (SESSION_DIMENSIONS.includes(filter.dim) ? stay : event).push(filter);
  }
  return { event, stay };
}

// From how many people stopped at each depth to the steps as a report.
// depths holds the segment's people by the number of steps they reached, zero
// included or not; segment is how many people the filters left.
export function finishFunnel(
  depths: Iterable<readonly [number, number]>,
  segment: number,
  stepCount: number,
): FunnelResult {
  const reached = new Array<number>(stepCount + 1).fill(0);
  for (const [depth, visitors] of depths) {
    const at = Math.min(Math.max(depth, 0), stepCount);
    reached[at] = (reached[at] ?? 0) + visitors;
  }
  // From "stopped at k" to "got at least as far as k".
  for (let depth = stepCount - 1; depth >= 1; depth -= 1) {
    reached[depth] = (reached[depth] ?? 0) + (reached[depth + 1] ?? 0);
  }
  const steps: FunnelStepResult[] = [];
  const first = reached[1] ?? 0;
  for (let step = 1; step <= stepCount; step += 1) {
    const visitors = reached[step] ?? 0;
    const previous = step === 1 ? null : (reached[step - 1] ?? 0);
    steps.push({
      visitors,
      dropOff: previous === null ? 0 : previous - visitors,
      rate: first === 0 ? null : visitors / first,
      stepRate: previous === null || previous === 0 ? null : visitors / previous,
    });
  }
  return { visitors: segment, steps, rawOnly: true };
}
