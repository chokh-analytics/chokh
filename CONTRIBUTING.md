# Contributing to Chokh

Chokh is first-party web analytics you host yourself. It is built by one small
company, BWJ Tech Ltd., in the open, and patches from outside are welcome.

Two things are worth knowing before you write any code: there is a contributor
licence agreement, and there is a line between the free part and the paid part.
Both are below, and neither is long.

## Sign the CLA

Add one row to [CLA-SIGNATURES.md](CLA-SIGNATURES.md) in the same pull request
as your first change. The agreement is [CLA.md](CLA.md); the short version is
that you keep the copyright in what you write, and the company gets the right
to license it, including the right to move a part of the project between the
MIT core and the paid directory later.

CI refuses a pull request whose author, or any of whose commit authors, is not
on that list. It is not a bot you have to talk to: it reads a file in the
repository, and the file is the signature.

## Which side of the line a change belongs to

Chokh is open core. The core is MIT and free to self-host in full, with no key
and no limit. The paid features live in `packages/ee/` under the
[Chokh Enterprise Licence](packages/ee/LICENSE) and run only with a licence
key, which is verified offline against a public key baked into the build.
Nothing phones home, ever, and the published image carries both halves so that
one image is a complete install.

| Core, MIT, free to self-host | `packages/ee/`, commercial licence, needs a key |
| --- | --- |
| The tracker, the collector, the store and both adapters, the dashboard and every report | Hosted Chokh Cloud |
| Events, goals, funnels, filters, segments, annotations | Alerts by email, Telegram and webhook |
| CSV and JSON exports, the public share page and the embed | Scheduled email and PDF digests |
| The stats API, the SSE stream, the SDKs, one team with owner, editor and viewer | Multi-team and OIDC single sign-on |
| Retention up to 400 days, the audit log | Retention beyond 400 days, white-label, priority support |
| Vitals, errors, retention cohorts, journeys | Session replay, heatmaps, surveys, experiments, flags |

Two rules follow, and review enforces both mechanically:

- **A change to the core never touches `packages/ee/`, and never reads
  `CHOKH_LICENSE_KEY`.** `scripts/ee-boundary.mjs` and an ESLint rule fail a
  build that crosses.
- **A paid feature lands nowhere but `packages/ee/`.** The one file in the core
  that knows the paid directory exists is
  `packages/server/src/lib/load-extensions.ts`, and its whole job is to load it
  if it is there and carry on if it is not.

If you want a feature that is on the paid side, the answer is pricing rather
than a patch, and we would rather tell you that before you write it than after.
Open an issue first.

## What good looks like here

The rules the project holds itself to are in [AGENTS.md](AGENTS.md). The ones
that most often come up in review:

1. No import of anything Progsity. Progsity is a user of this product, not its
   owner in the code.
2. No hard-coded site, domain or key. Anything one deployment wants and another
   would not is a site setting or an environment variable.
3. No query outside the `AnalyticsStore` adapter.
4. The tracker stays dependency-free and under 3 KB gzipped. CI asserts it.
5. Every adapter passes the one conformance suite.
6. The API envelope never varies: `{ success: true, data, meta? }`, or
   `{ success: false, error: { code, message, details? } }`.
7. TypeScript strict, zero build errors, tests beside the code. No `any`, no
   `@ts-ignore`.
8. English UI strings live in one messages file per surface, so other languages
   can follow.
9. No em dashes anywhere: code, comments, docs, commit messages, UI copy.
10. A gated feature is described, never simulated and never hidden.

## Running it

```bash
pnpm install
pnpm build
pnpm test
```

Node 22 and pnpm 10. Before you open a pull request:

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm size:tracker && pnpm size:dashboard
pnpm --filter @chokh/dashboard run test:e2e
```

`docker compose up` runs the whole product locally with MongoDB and Redis
beside it. The store conformance suite runs on `mongodb-memory-server`, so you
do not need Docker to prove an adapter.

## Commits and pull requests

Conventional Commits. One change per pull request, with the smallest diff that
does the job: no unrelated refactor, no cleanup outside the change. Say in the
description what you verified and paste what it printed.

Questions: support@progsity.io.
