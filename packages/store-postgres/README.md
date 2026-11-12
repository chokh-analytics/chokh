# @chokh/store-postgres

The PostgreSQL storage adapter for Chokh: the `AnalyticsStore` and
`AccountStore` contracts of `@chokh/store` on plain PostgreSQL 15 or newer,
through `pg`. No extension is needed, so a managed Postgres with an ordinary
role is enough.

It implements both contracts in full and passes the one conformance suite every
adapter passes, against a real PostgreSQL. The server opens it when
`DATABASE_URL` is set; `packages/server/README.md` has the variables.

## Opening it

```ts
import { createPostgresStore } from '@chokh/store-postgres';

const store = await createPostgresStore({ url: 'postgresql://chokh:secret@db.internal:5432/chokh' });
```

| Option | Default | What it is |
| --- | --- | --- |
| `url` | required | A `postgres://` or `postgresql://` connection string |
| `poolSize` | 10 | How many connections this process may hold |
| `statementTimeoutMs` | 30000 | How long one statement may run before the server cancels it |
| `onIdleError` | none | Told when the server drops a connection nobody was using |
| `onOutsideWindow` | none | Told how many rows of a batch were outside the window a partition may exist for |
| `presence` | a map in this process | Where who is live is kept: Redis when a deployment has one |
| `now` | the clock | Injected so a test can say what today is |

Opening refuses, with the command to run, a database the migration has not
reached, one that is not `UTF8` and a server older than PostgreSQL 15. It never
creates a table itself.

**TLS** is the URL's business: the driver reads `sslmode` from it and nothing
else needs setting. For a managed PostgreSQL, use
`postgresql://user:secret@host:5432/chokh?sslmode=verify-full`, which encrypts
the connection and checks the server's certificate and name. Most managed
services sign with a certificate authority of their own and give you its file;
name it with `&sslrootcert=/path/to/ca.pem`. Two things to know about this
driver (`pg` 8): it reads `sslmode=require` as `verify-full` too, with a
warning that a later version will not, so write `verify-full` and mean it; and
`sslmode=no-verify` encrypts without checking who answered, which is for a
database on a network you already trust and for nothing else.

**The statement timeout** is what stops one slow report from holding a
connection for minutes while the collector waits for one. A statement that
outlives it is cancelled by the server and the connection goes back to the pool
fit to use. The jobs that are meant to be long lift it for themselves.

**A restart of the database** closes every connection the pool was holding.
The pool replaces them as they are next needed and the process carries on;
`onIdleError` is there only so a host can log that it happened.

`close()` ends the pool. A statement already running is allowed to finish
first, and so is a caller that was still waiting for a connection, so a
shutdown in the middle of a write does not cut the write in half or leave a
request unanswered. A batch is written by one statement: it is stored whole or
not at all.

## Reads and the day

No statement draws a day or a bucket. The contract does, in the site's own
time zone, and hands SQL the boundaries as a parameter; SQL groups by them
(`width_bucket`). So a report means the same day on any server, whatever its
`TimeZone` setting and however old its time zone data, and the same day the
other adapters mean.

A row whose instant no partition may exist for (see below) is not stored and
does not fail the rows beside it; `onOutsideWindow` is told how many, and
`store.outsideWindow` keeps the running count.

## The migration command

Nothing but this command creates a table or an index. Run it before the
collector writes anything and again after every upgrade:

```bash
node packages/store-postgres/dist/migrate.js --apply
```

```bash
node packages/store-postgres/dist/migrate.js --verify-only
```

The database comes from `DATABASE_URL`, or from `--url <connection string>`.
`--apply` is one transaction, so an apply that fails leaves the database as it
found it, and running it twice creates nothing the second time. `--verify-only`
changes nothing and exits 1 unless it reports `missing: 0`, so a deployment can
gate on it. An index nobody declared is reported and never dropped.

The database has to be `UTF8`. Every official image and managed service creates
one; a database made by hand on Windows takes the machine's code page unless
told otherwise, and would refuse the first page title outside it, so the
command refuses that database instead.

## How `events` is stored

One partition per calendar month of UTC, named `events_pYYYYMM`. The migration
creates this month and the next; the adapter creates any other month the first
time a batch needs it, by making a table beside `events` and attaching it, which
blocks neither a report that is reading nor a batch that is writing. A
partition is only ever made for a month between the longest retention a site
can have (ten years back) and the month after this one, so an install holds at
most 122 of them whatever it is sent.

Retention is per site, so it is a delete and not a partition drop: the hourly
purge removes a site's rows past its retention, in one transaction, and a month
wholly older than that is dropped once it holds no row of any site, which gives
its disk back at once. A drop needs `events` to itself for an instant, so it
waits at most half a second for a report that is reading and otherwise leaves
the month for the next hourly pass. A month that was dropped is made again the
first time a row needs it.

The daily rollups are an ordinary table, `rollups_daily`, and not a
materialised view: a view is recomputed from the raw rows, and the raw rows are
what retention takes away. A day is replaced in one transaction, so no report
finds it missing while it is being rewritten.

## The long jobs

A rollup, a route regroup and the retention purge are allowed to run past the
statement timeout: each lifts it for its own transaction and for nothing else.
A route regroup rewrites only the rows whose route changes, not every row of
the site.

## Running the tests

```bash
pnpm --filter @chokh/store-postgres test
```

The tests need a real PostgreSQL and bring their own: the `embedded-postgres`
package carries the server's binaries for your platform, they arrive with
`pnpm install`, and the run starts one in a temporary directory, stops it and
deletes the directory when it ends. Nothing is downloaded at test time and
nothing is installed or left running.

To use a PostgreSQL of your own instead, for example one in Docker, name it:

```bash
CHOKH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm --filter @chokh/store-postgres test
```

Each test file works in a schema of its own and drops it, so the database you
name is left as it was. The role has to be a superuser: one test creates a
database in another encoding to prove it is refused, one marks an index
invalid and one ends another connection's session. CI runs the suite this way against `postgres:17-alpine` and
`postgres:15-alpine`.

You need that variable in two cases. On Windows, a checkout deep enough that
the bundled server's own files pass the 260 character path limit cannot
initialise it (the run says so); move the checkout nearer the drive's root or
name a database. And on a platform the package has no binaries for, or after an
install that skipped optional dependencies, there is nothing to start.
