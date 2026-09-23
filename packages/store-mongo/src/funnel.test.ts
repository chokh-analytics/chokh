import {
  compareFunnelRows,
  firstHit,
  funnelDepth,
  hitMask,
  type FunnelRow,
} from '@chokh/store';
import { FUNNEL_SEQUENCE_COUNT, funnelSequences } from '@chokh/store/conformance';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { funnelFoldStages } from './pipelines.js';

// The funnel fold exists twice: funnelDepth in the contract, which the
// in-memory adapter runs and a brute force proves, and the $reduce this
// adapter runs so a busy range is folded where it lives. This holds the second
// to the first on the same seeded sequences, through the exact stages the read
// uses: the sort, the cap, the $push and the $reduce. The rows go in in the
// order they were drawn, so the database has to put them in funnel order
// itself, equal timestamps included.

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

const sequences = funnelSequences();

interface FoldDoc {
  visitorId: string;
  sessionId: string;
  ts: number;
  hits: readonly boolean[];
  first: number;
  mask: number;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri('chokh_funnel_fold'));
  await client.connect();
  db = client.db();
  const docs: FoldDoc[] = [];
  sequences.forEach((sequence, index) => {
    sequence.rows.forEach((row, at) => {
      docs.push({
        visitorId: `s${index}`,
        // Two visits per sequence, alternating, so the visit window's
        // partition is folded too.
        sessionId: `s${index}_${at % 2}`,
        ts: row.ts,
        hits: row.hits,
        first: firstHit(row.hits),
        mask: hitMask(row.hits),
      });
    });
  });
  await db.collection<FoldDoc>('fold').insertMany(docs);
}, 120_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});

async function mongoDepth(index: number, byVisit: boolean): Promise<number> {
  const sequence = sequences[index];
  if (sequence === undefined) throw new Error(`no sequence ${index}`);
  const [row] = await db
    .collection('fold')
    .aggregate([
      { $match: { visitorId: `s${index}` } },
      ...funnelFoldStages(sequence.steps, sequence.windowMs, byVisit),
    ])
    .toArray();
  return (row?.depth as number | undefined) ?? 0;
}

describe('the $reduce fold', () => {
  it(`agrees with funnelDepth on the same ${FUNNEL_SEQUENCE_COUNT} seeded sequences`, async () => {
    expect(sequences).toHaveLength(FUNNEL_SEQUENCE_COUNT);
    let ties = 0;
    let edges = 0;
    for (const [index, sequence] of sequences.entries()) {
      const ordered = [...sequence.rows].sort(compareFunnelRows);
      expect({ index, depth: await mongoDepth(index, false) }).toEqual({
        index,
        depth: funnelDepth(ordered, sequence.windowMs),
      });
      if (new Set(ordered.map((row) => row.ts)).size < ordered.length) ties += 1;
      if (ordered.some((a) => ordered.some((b) => b.ts - a.ts === sequence.windowMs))) edges += 1;
    }
    // The list is only a proof if it reaches equal times and the exact edge.
    expect(ties).toBeGreaterThan(100);
    expect(edges).toBeGreaterThan(100);
  }, 120_000);

  it('agrees on the visit window, one fold per visit and the deepest kept', async () => {
    for (const [index, sequence] of sequences.entries()) {
      const perVisit = new Map<number, FunnelRow[]>();
      sequence.rows.forEach((row, at) => {
        perVisit.set(at % 2, [...(perVisit.get(at % 2) ?? []), row]);
      });
      let depth = 0;
      for (const rows of perVisit.values()) {
        depth = Math.max(depth, funnelDepth([...rows].sort(compareFunnelRows), sequence.windowMs));
      }
      expect({ index, depth: await mongoDepth(index, true) }).toEqual({ index, depth });
    }
  }, 120_000);
});
