# @chokh/store-postgres

The PostgreSQL storage adapter for Chokh: the `AnalyticsStore` and
`AccountStore` contracts of `@chokh/store` on plain PostgreSQL 15 or newer,
through `pg`. No extension is needed, so a managed Postgres with an ordinary
role is enough.

This package is being built in parts (`AN-STO02`). What is here today is the
schema, the migration command and the monthly partitions of `events`; the
adapter itself and the server's `DATABASE_URL` follow.

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
purge removes a site's rows past its retention, and a month is dropped once it
is empty.

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
database in another encoding to prove it is refused, and one marks an index
invalid. CI runs the suite this way against `postgres:17-alpine` and
`postgres:15-alpine`.

You need that variable in two cases. On Windows, a checkout deep enough that
the bundled server's own files pass the 260 character path limit cannot
initialise it (the run says so); move the checkout nearer the drive's root or
name a database. And on a platform the package has no binaries for, or after an
install that skipped optional dependencies, there is nothing to start.
