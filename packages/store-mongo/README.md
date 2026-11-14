# @chokh/store-mongo

The MongoDB storage adapter for Chokh: the `AnalyticsStore` and `AccountStore`
contracts of `@chokh/store` on MongoDB 5.0 or newer.

It implements both contracts in full and passes the one conformance suite every
adapter passes. The server opens it when `MONGODB_URI` is set.

**It is not the default, and it is not a lesser path.** `docker compose up` at
the root of the repository runs the product on PostgreSQL, for the reasons the
root `README.md` gives. This adapter is the older of the two and the one that
has run in production the longest, it is tested on every push beside the other,
and it is not going away. To run the product on it:

```bash
docker compose -f docker-compose.mongodb.yml up -d
```

An install started from the root compose file before PostgreSQL became the
default has its rows in the `mongo-data` volume, and that file is the one that
reads it. There is no tool that copies rows from MongoDB into PostgreSQL.

## The migration command

Chokh never builds an index while it is running. One command owns them: run it
before the collector writes anything and again after every upgrade.

```bash
node packages/store-mongo/dist/migrate.js --apply
```

```bash
node packages/store-mongo/dist/migrate.js --verify-only
```

`--apply` creates anything missing. `--verify-only` changes nothing and exits 1
unless it reports `missing: 0`, so a deployment can gate on it. An index nobody
declared is reported and never dropped. In the compose stack, run either
through the server's container:

```bash
docker compose -f docker-compose.mongodb.yml exec server node packages/store-mongo/dist/migrate.js --apply
```

### What waits for it, and what does not

MongoDB answers a read with no index, slowly, so everything Chokh did before it
had teams of more than one person still works on a database nobody migrated:
collecting, every report, accounts, keys, the audit log. That has always been
true and stays true.

Three collections are different: `site_members`, `invitations` and
`identities`. What keeps their rows single is a unique index (one role per
person and site, one invitation waiting per address, one account per outside
identity), and a rule like that cannot rest on somebody remembering to run a
command. So until `--apply` has made those indexes, a write to any of the three
is refused with `MIGRATION_REQUIRED` and the command to run. The adapter looks
once and remembers a yes; after a refusal it looks again, so the first write
after the migration goes through with no restart.

`packages/server/README.md` has the rest: why 5.0 is the floor, how retention
works on a TTL index, and what each number in a report means.

## Running the tests

```bash
pnpm --filter @chokh/store-mongo test
```

The suite runs on `mongodb-memory-server`, which downloads a `mongod` the first
time and starts it for the run. Nothing is installed and nothing is left
running.
