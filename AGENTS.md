# AGENTS.md: Chokh engineering rules

> **Status:** live · **Role:** the canonical rules for every agent and engineer
> working in this repository. Claude Code reaches this file through
> `CLAUDE.md`; Codex reads it natively. The tickets, their order and their
> acceptance live in `ANALYTICS_TASKS.md` in the Progsity workspace
> (`E:\Progsity Dev`); the reasons live in that workspace's ADR-0069 and in the
> artifact "Chokh Analytics Plan".

## 1. What this repository is

Chokh is a standalone, MIT licensed, first-party web analytics product: a
tracker script, a collector, a stats API, a realtime stream and a dashboard, in
one process and one Docker image. It is built to be dropped into anybody's
project. It has two masters: the site owner running it, and the open source
audience on GitHub. A change that helps one consumer but breaks the product for
everybody else is refused in review.

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

## 4. Stack (no substitutions)

- Runtime: Node 22, pnpm 10 workspace, TypeScript 5.x strict
- `packages/tracker`: TypeScript compiled by esbuild to one IIFE `a.js`, no
  dependencies
- `packages/server`: Fastify 5, Zod, pino (through Fastify's logger)
- `packages/dashboard`: Vite, React 19, built static and served by the server
- `packages/store-mongo`: the MongoDB adapter, indexes declared in the schema
  and applied by a `migrate` command, never `autoIndex`
- `packages/geo`: MaxMind GeoLite2-City through `maxmind`, DB-IP Lite as the
  keyless fallback, `ua-parser-js` 1.x for user agents
- `packages/sdk-node`: server-side `track` and `identify`
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
| `docker compose up` | Server, MongoDB and Redis for local development |

CI runs build, typecheck, lint, test and the tracker size gate on every push.
