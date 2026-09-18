import { pathToFileURL } from 'node:url';

import { MongoClient, type Db, type IndexDescription } from 'mongodb';

import { schema, type CollectionSchema } from './schema.js';

// The only code in Chokh that creates a collection or an index. Run it once
// before the collector writes anything, and again after every upgrade:
//
//   node packages/store-mongo/dist/migrate.js --apply
//   node packages/store-mongo/dist/migrate.js --verify-only
//
// --verify-only exits 1 when anything is missing, so a deployment can gate on
// it. An index nobody declared is reported and never dropped: it may be one a
// person added on purpose, and a migration is not the place to lose it.

export interface IndexReport {
  collection: string;
  declared: number;
  present: string[];
  missing: string[];
  undeclared: string[];
}

export interface MigrateReport {
  database: string;
  collections: IndexReport[];
  collectionsCreated: string[];
  indexesCreated: string[];
  declaredIndexes: number;
  presentIndexes: number;
  missingIndexes: number;
  undeclaredIndexes: number;
}

function indexName(index: IndexDescription): string {
  return index.name ?? Object.keys(index.key).join('_');
}

async function inspect(db: Db, collection: CollectionSchema): Promise<IndexReport> {
  const declared = collection.indexes.map(indexName);
  let existing: string[] = [];
  try {
    const indexes = await db.collection(collection.name).listIndexes().toArray();
    existing = indexes.map((index) => String(index.name)).filter((name) => name !== '_id_');
  } catch {
    // A collection nobody has written to does not exist yet, which is not an
    // error: it is exactly what --apply is for.
    existing = [];
  }
  return {
    collection: collection.name,
    declared: declared.length,
    present: declared.filter((name) => existing.includes(name)),
    missing: declared.filter((name) => !existing.includes(name)),
    undeclared: existing.filter((name) => !declared.includes(name)),
  };
}

async function report(
  db: Db,
  created: { collections: string[]; indexes: string[] },
): Promise<MigrateReport> {
  const collections: IndexReport[] = [];
  for (const collection of schema) {
    collections.push(await inspect(db, collection));
  }
  return {
    database: db.databaseName,
    collections,
    collectionsCreated: created.collections,
    indexesCreated: created.indexes,
    declaredIndexes: collections.reduce((total, row) => total + row.declared, 0),
    presentIndexes: collections.reduce((total, row) => total + row.present.length, 0),
    missingIndexes: collections.reduce((total, row) => total + row.missing.length, 0),
    undeclaredIndexes: collections.reduce((total, row) => total + row.undeclared.length, 0),
  };
}

export function verify(db: Db): Promise<MigrateReport> {
  return report(db, { collections: [], indexes: [] });
}

export async function apply(db: Db): Promise<MigrateReport> {
  const created = { collections: [] as string[], indexes: [] as string[] };
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  for (const collection of schema) {
    if (!existing.has(collection.name)) {
      await db.createCollection(collection.name);
      created.collections.push(collection.name);
    }
    const before = await inspect(db, collection);
    if (before.missing.length === 0) {
      continue;
    }
    const wanted = collection.indexes.filter((index) => before.missing.includes(indexName(index)));
    await db.collection(collection.name).createIndexes(wanted);
    for (const index of wanted) {
      created.indexes.push(`${collection.name}.${indexName(index)}`);
    }
  }
  return report(db, created);
}

export function formatReport(result: MigrateReport): string {
  const lines = [`chokh migrate: ${result.database}`];
  for (const row of result.collections) {
    const note = row.undeclared.length === 0 ? '' : `, undeclared: ${row.undeclared.join(', ')}`;
    lines.push(
      `  ${row.collection.padEnd(14)} indexes ${row.present.length}/${row.declared}${note}`,
    );
  }
  if (result.collectionsCreated.length > 0) {
    lines.push(`collections created: ${result.collectionsCreated.join(', ')}`);
  }
  if (result.indexesCreated.length > 0) {
    lines.push(`indexes created: ${result.indexesCreated.join(', ')}`);
  }
  lines.push(
    `collections: ${result.collections.length}, ` +
      `indexes: ${result.presentIndexes} present of ${result.declaredIndexes}, ` +
      `missing: ${result.missingIndexes}, unexpected: ${result.undeclaredIndexes}`,
  );
  return lines.join('\n');
}

const USAGE = `chokh migrate: create the collections and indexes Chokh declares.

  migrate --apply         create anything missing, then report
  migrate --verify-only   report only, exit 1 if anything is missing

The database comes from MONGODB_URI, or from --uri <connection string>.
`;

function argValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

export async function runCli(argv: string[], write: (line: string) => void): Promise<number> {
  const wantsApply = argv.includes('--apply');
  const wantsVerify = argv.includes('--verify-only');
  if (wantsApply === wantsVerify) {
    write(USAGE);
    return 2;
  }
  const uri = argValue(argv, '--uri') ?? process.env.MONGODB_URI;
  if (uri === undefined || uri === '') {
    write('No database: set MONGODB_URI or pass --uri.\n');
    return 2;
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const result = wantsApply ? await apply(db) : await verify(db);
    write(`${formatReport(result)}\n`);
    return result.missingIndexes === 0 ? 0 : 1;
  } finally {
    await client.close();
  }
}

// Only when run as a command, so importing this file from a test costs nothing.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2), (line) => process.stdout.write(line));
}
