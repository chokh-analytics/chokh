import { randomBytes } from 'node:crypto';

import pg from 'pg';
import type { Pool } from 'pg';
import { inject } from 'vitest';

// One schema per test file, in the one database the run shares. A file makes
// its own, works in it through search_path and drops it when it is done, so
// files run side by side without seeing each other's tables.
export interface TestDatabase {
  // Every connection of this pool is in the schema.
  pool: Pool;
  schema: string;
  // The same database with the schema as its search path, for anything that
  // opens a connection of its own from a URL.
  url: string;
  // Drop the schema and everything in it, and end the pool.
  drop(): Promise<void>;
}

export function databaseUrl(): string {
  return inject('databaseUrl');
}

export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const base = databaseUrl();
  const schema = `t_${label}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: base, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const scoped = new URL(base);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const url = scoped.toString();
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // A connection the server closed while idle (the run ending, a restart) is
  // reported here, and an unhandled 'error' on an emitter ends the process.
  pool.on('error', () => undefined);
  return {
    pool,
    schema,
    url,
    async drop(): Promise<void> {
      await pool.end();
      const cleaner = new pg.Pool({ connectionString: base, max: 1 });
      try {
        await cleaner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleaner.end();
      }
    },
  };
}
