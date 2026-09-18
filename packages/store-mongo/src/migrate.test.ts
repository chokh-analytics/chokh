import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apply, formatReport, runCli, verify } from './migrate.js';
import { DECLARED_INDEX_COUNT, schema } from './schema.js';

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri('chokh_migrate'));
  await client.connect();
  db = client.db();
}, 120_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});

describe('migrate', () => {
  it('reports everything missing before it runs', async () => {
    const before = await verify(db);
    expect(before.presentIndexes).toBe(0);
    expect(before.missingIndexes).toBe(DECLARED_INDEX_COUNT);
  });

  it('creates every collection and index the schema declares', async () => {
    const applied = await apply(db);
    expect(applied.collectionsCreated).toHaveLength(schema.length);
    expect(applied.indexesCreated).toHaveLength(DECLARED_INDEX_COUNT);
    expect(applied.missingIndexes).toBe(0);
    expect(applied.undeclaredIndexes).toBe(0);
  });

  it('reports missing: 0 afterwards, which is the ticket verify line', async () => {
    const after = await verify(db);
    expect(after.missingIndexes).toBe(0);
    expect(after.presentIndexes).toBe(DECLARED_INDEX_COUNT);
    expect(formatReport(after)).toContain('missing: 0');
  });

  it('is safe to run twice', async () => {
    const again = await apply(db);
    expect(again.collectionsCreated).toEqual([]);
    expect(again.indexesCreated).toEqual([]);
    expect(again.missingIndexes).toBe(0);
  });

  it('keeps the per site retention as a TTL that expires on the document', async () => {
    const indexes = await db.collection('events').listIndexes().toArray();
    const ttl = indexes.find((index) => index.name === 'event_ttl');
    expect(ttl?.expireAfterSeconds).toBe(0);
    expect(ttl?.key).toEqual({ expiresAt: 1 });
  });

  it('reports an index nobody declared without dropping it', async () => {
    await db.collection('events').createIndex({ title: 1 }, { name: 'someone_elses_index' });
    const report = await verify(db);
    expect(report.undeclaredIndexes).toBe(1);
    expect(report.missingIndexes).toBe(0);
    const after = await apply(db);
    expect(after.undeclaredIndexes).toBe(1);
    await db.collection('events').dropIndex('someone_elses_index');
  });
});

describe('the migrate command line', () => {
  it('verifies green and exits zero', async () => {
    const lines: string[] = [];
    const code = await runCli(['--verify-only', '--uri', server.getUri('chokh_migrate')], (line) =>
      lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.join('')).toContain('missing: 0');
  });

  it('exits 1 when an index is missing, so a deployment can gate on it', async () => {
    const lines: string[] = [];
    const code = await runCli(['--verify-only', '--uri', server.getUri('chokh_untouched')], (line) =>
      lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines.join('')).toContain(`missing: ${DECLARED_INDEX_COUNT}`);
  });

  it('prints the usage when neither flag is given', async () => {
    const lines: string[] = [];
    const code = await runCli([], (line) => lines.push(line));
    expect(code).toBe(2);
    expect(lines.join('')).toContain('--verify-only');
  });
});
