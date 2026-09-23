import type { FunnelRow } from '../funnel.js';

// Seeded funnel sequences, shared so that two tests fold exactly the same
// rows: the brute force in @chokh/store holds funnelDepth to the definition,
// and store-mongo holds its $reduce to funnelDepth on the same list.
//
// The rows are drawn to hit the cases a fold gets wrong: timestamps are whole
// units and the window is a whole number of them, so a chain whose last step
// lands exactly on the window's edge happens often; several rows share a
// timestamp; a row can reach more than one step; and the rows come out in no
// particular order, so each consumer has to sort them the way the contract
// says.

export interface FunnelSequence {
  steps: number;
  windowMs: number;
  // In the order they were drawn, not in funnel order.
  rows: FunnelRow[];
}

export const FUNNEL_SEQUENCE_COUNT = 500;
export const FUNNEL_SEQUENCE_SEED = 20260923;

const UNIT = 60_000;

// mulberry32: small, fast, and the same numbers on every machine.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function funnelSequences(
  count = FUNNEL_SEQUENCE_COUNT,
  seed = FUNNEL_SEQUENCE_SEED,
): FunnelSequence[] {
  const next = random(seed);
  const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  const out: FunnelSequence[] = [];
  for (let index = 0; index < count; index += 1) {
    const steps = int(2, 8);
    // One in eight has no bound, the way the visit window folds.
    const windowMs = next() < 0.125 ? Number.MAX_SAFE_INTEGER : int(1, 8) * UNIT;
    const length = int(0, 16);
    const rows: FunnelRow[] = [];
    for (let row = 0; row < length; row += 1) {
      const hits = Array.from({ length: steps }, () => next() < 0.3);
      if (!hits.includes(true)) {
        hits[int(0, steps - 1)] = true;
      }
      rows.push({ ts: 1_700_000_000_000 + int(0, 12) * UNIT, hits });
    }
    out.push({ steps, windowMs, rows });
  }
  return out;
}
