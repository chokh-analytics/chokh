# AGENTS.md: Chokh engineering rules

> **Status:** live · **Role:** the canonical rules for every agent and engineer
> working in this repository. Claude Code reaches this file through
> `CLAUDE.md`; Codex reads it natively. The tickets, their order and their
> acceptance live in `ANALYTICS_TASKS.md` in the Progsity workspace
> (`E:\Progsity Dev`); the reasons live in that workspace's ADR-0069 and in the
> artifact "Chokh Analytics Plan".

## 1. What this repository is

Chokh is a standalone, first-party web analytics product: a tracker script, a
collector, a stats API, a realtime stream and a dashboard, in one process and
one Docker image. It is built to be dropped into anybody's project. It has two
masters: the site owner running it, and the open source audience on GitHub. A
change that helps one consumer but breaks the product for everybody else is
refused in review.

It is **open core** (ADR-0073). Everything outside `packages/ee` is MIT and free
to self-host in full, with no key and no limit. `packages/ee` is Chokh Pro,
under the Chokh Enterprise Licence in that directory, and runs only with a
`CHOKH_LICENSE_KEY` verified offline against a public key compiled into the
build. Nothing phones home, with a key or without one, and the published image
carries both halves so that one image is a complete install. Rules 10 to 12
below are how that line is kept, and `CONTRIBUTING.md` is where an outside
contributor reads it.

Progsity is a user of this product, never its owner in the code.

## 2. Source of truth and reading order

1. This file.
2. `README.md` for the shape of the product.
3. `ANALYTICS_TASKS.md` in the Progsity workspace for the ticket you are on.
4. ADR-0069 and the artifact "Chokh Analytics Plan" sections 3 to 7 for the
   architecture, feature catalogue, data model, API contract and dashboard
   rules.

If a ticket and this file disagree, stop and report. Do not pick one.

## 3. Repository rules (review refuses these)

1. **No import of anything Progsity.** No model, no helper, no RBAC, no copied
   type. The word "progsity" appears in this repository only in the README's
   "used by" line.
2. **No hard-coded site, domain or key.** Anything one deployment wants and
   another would not is a site setting or an environment variable. Progsity's
   own choices (full IP storage, persistent visitor ids) are configuration, not
   defaults.
3. **No query outside the `AnalyticsStore` adapter.** Services ask the
   interface; only an adapter package knows MongoDB, Postgres or ClickHouse.
4. **The tracker stays dependency-free and under 3 KB gzipped.** CI asserts the
   size on every push; it is a gate, not a habit.
5. **Every adapter passes the one conformance suite.** A new adapter adds no
   tests of its own for behaviour the suite already covers.
6. **The API envelope never varies.** Success is
   `{ success: true, data, meta? }`; failure is
   `{ success: false, error: { code, message, details? } }`. Every route, every
   time, including errors raised by a framework hook.
7. **TypeScript strict, zero build errors, tests beside the code.** No `any`,
   no `@ts-ignore`, no type-assertion hacks. A test file sits next to the file
   it tests, named `<name>.test.ts`.
8. **English UI strings live in one messages file per surface**, so Bangla and
   other languages can follow without hunting through components.
9. **No em dashes anywhere**: code, comments, docs, commit messages, UI copy.
   Use commas, colons, parentheses or hyphens.
10. **A gated feature is described, never simulated and never hidden.** A
    feature this install has not licensed is drawn where it would be, named,
    with one sentence saying it is part of Chokh Pro and that a key turns it on.
    Not removed from the navigation, not a locked rectangle over a screenshot of
    numbers that are not yours, not a modal. Three reasons: somebody deciding
    whether to self-host needs the whole shape of the product before they
    install it rather than after; an install with a licence and a misconfigured
    key looks identical to one that never bought anything if the feature simply
    is not there, and the person who has to fix that is reading this dashboard;
    and a blurred picture of invented numbers is a lie on a page whose whole
    promise is that it draws no number nobody measured. There is a test that
    fails when a gated control is removed rather than labelled.
11. **The paid half lands nowhere but `packages/ee`, and the core never reads
    the licence key.** One file in the core knows `packages/ee` exists,
    `packages/server/src/lib/load-extensions.ts`, and its whole job is to load
    it if it is there and carry on if it is not. `scripts/ee-boundary.mjs` and
    an ESLint rule refuse a crossing in either direction, and CI injects both
    crossings on every push to prove the check still bites. It matters because
    it cannot be undone: a feature released under MIT is free for ever, so a
    paid one that lands in `packages/server` by accident is not a bug to fix
    next week, it is a feature given away.
12. **Each package validates its own environment with Zod.**
    `packages/server/src/config/env.ts` is the only reader in the core;
    `packages/ee/src/license/env.ts` is the only reader of `CHOKH_LICENSE_KEY`
    anywhere. "No raw `process.env`" still holds everywhere, and so does "one
    reader per package".

## 4. Stack (no substitutions)

- Runtime: Node 22, pnpm 10 workspace, TypeScript 5.x strict
- `packages/tracker`: TypeScript compiled by esbuild to one IIFE `a.js`, no
  dependencies
- `packages/server`: Fastify 5, Zod, pino (through Fastify's logger),
  `@fastify/cookie` for the session cookie, `@node-rs/argon2` for password hashing
  (prebuilt, including the musl build the alpine image needs)
- `packages/dashboard`: Vite, React 19, built static and served by the server
- `packages/store`: the `AnalyticsStore` contract and the one conformance suite;
  `packages/server/src/store/AnalyticsStore.ts` re-exports it, so an adapter
  package depends on the contract and never on the server
- `packages/store-mongo`: the MongoDB adapter, indexes declared in the schema
  and applied by a `migrate` command, never `autoIndex`
- `packages/geo`: MaxMind GeoLite2-City through `maxmind`, DB-IP Lite as the
  keyless fallback, `ua-parser-js` 1.x for user agents
- `packages/sdk-node`: server-side `track` and `identify`, and the one line that
  signs an identify. It is not imported by the server: a product does not depend on
  its own client SDK, so the collector keeps its own copy of that line and a shared
  test vector in both packages is what stops the two drifting
- `packages/ee`: Chokh Pro. Not MIT. It depends on `packages/server` and nothing
  in the core depends on it, so deleting the directory leaves a product that
  builds and boots; CI proves that on every push rather than asserting it
- Redis is optional everywhere. Presence and the live feed use it when it is
  configured and fall back to memory when it is not, so one image is a complete
  install.

## 5. Architecture contracts

**API envelope, every endpoint.** Success `{ success: true, data, meta? }`;
error `{ success: false, error: { code, message, details? } }`. The helpers in
`packages/server/src/lib/envelope.ts` are the only way to build one.

**Server layering.** Each layer knows only the one below it.

- `routes/` register paths and attach a controller. No logic, no validation.
- `controllers/` validate input with Zod, call a service, return the envelope.
  No storage access, no business rules.
- `services/` hold the logic. No HTTP knowledge, no direct storage driver.
- `store/` holds the `AnalyticsStore` interface. Adapters implement it and are
  the only code that knows a database dialect.
- `plugins/`, `lib/` and `config/` hold framework wiring, pure helpers and
  validated environment.

**Zod at every boundary.** No raw `request.body`, no raw `process.env`.

**Privacy is a setting, not a branch.** IP mode, visitor id mode, retention,
bot filtering and exclusions are read from the site row. Reading an IP or an
identified person's history needs the `read:identity` scope, and every such read
writes an audit row.

**No secrets in the repository.** Not in code, not in comments, not in examples,
not in task notes. Placeholders only.

## 6. Execution contract

One ticket per session, in the order `ANALYTICS_TASKS.md` gives. Tickets marked
**plan first** get a plan before any edit.

- **Minimal diff only.** No unrelated refactor, no cleanup outside the ticket,
  no absorbing the next ticket's scope.
- **Read the real current code before writing.** Follow the imports, naming and
  patterns already here.
- **Do the simplest production-grade change that satisfies the acceptance
  criteria.** A bug fix does not need surrounding cleanup.
- **Verify in proportion to risk.** Run the ticket's verify line. Run
  `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm test` before declaring
  anything done.
- **Audit every claim against tool output from this session.** Report only work
  you can point at evidence for. If something is not verified, say so.
- **Tick the box only after verification passes**, with the commit hash and a
  one-paragraph "shipped" note in the ticket.
- **Commit and push each green ticket.** Conventional Commits. Stage only the
  files the ticket owns. Never stage a `.env`.
- **If something in the ticket cannot be done as written, stop and report.** Do
  not pick an alternative.

A reviewing session reads the commits afterwards and writes a **Review**
paragraph under the ticket: accepted, or a list of must-fix items. A must-fix
reopens the box, and no ticket in the next wave starts while one is open.

## 7. Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install the workspace |
| `pnpm build` | Build every package |
| `pnpm typecheck` | Typecheck every package |
| `pnpm lint` | ESLint across the repository |
| `pnpm test` | Vitest in every package that has tests |
| `pnpm size:tracker` | Assert the built tracker is at most 3 KB gzipped |
| `pnpm --filter @chokh/tracker test:e2e` | The Playwright smoke against a fixture page |
| `node scripts/ee-boundary.mjs` | Assert the line between the MIT core and `packages/ee` |
| `node scripts/cla-check.mjs --dry-run` | Assert the CLA check accepts a signed author and refuses an unsigned one |
| `node packages/ee/dist/cli/chokh-license.js` | Mint and read a licence key. `keygen` is run once, by the founder, on their own machine |
| `node packages/store-mongo/dist/migrate.js --apply` | Create the declared collections and indexes |
| `node packages/store-mongo/dist/migrate.js --verify-only` | Report them, exit 1 unless `missing: 0` |
| `docker compose up` | Server, MongoDB and Redis for local development |

CI runs five jobs on every push: build, typecheck, lint, test and the tracker
size gate, with a `redis` service beside it so the Redis presence backend is
proved against a real Redis; a browser job that loads the fixture page in
Chromium and asserts the collect payloads; and a job that brings the stack up
with `docker compose up --build -d`, asserts `GET /health` answers with
`"success":true` and runs both migrate commands against the real MongoDB, so the
image, the compose file and the index migration are never unproven. A fifth job
deletes `packages/ee`, installs, builds, runs the server suite and boots the
result, so "the core is free to self-host in full" is checked rather than
claimed; and on a pull request a sixth reads `CLA-SIGNATURES.md` and refuses a
contributor who has not signed. That one runs on `pull_request` and never on
`pull_request_target`: a fork's pull request has to run with a read-only token
and no secrets.

The gates run in CI's order on CI's state. `pnpm typecheck` comes before
`pnpm build`, and `packages/ee` is written against `packages/server`, so a stale
`dist` on a laptop hides a break that a fresh clone finds. Delete every `dist`
before a run that is meant to prove anything.

The store conformance suite runs on `mongodb-memory-server`, a downloaded
`mongod`, locally and in CI. No machine needs Docker to prove an adapter;
`docker compose` stays the way a person runs the product. The presence suite is
the one thing a laptop cannot finish: without `REDIS_URL` the Redis half skips
and says so, and CI's service container runs it.
