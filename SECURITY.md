# Security

## Reporting a vulnerability

Please report it privately, through GitHub's form for this repository:
**[Report a vulnerability](https://github.com/chokh-analytics/chokh/security/advisories/new)**
(the **Security** tab, then **Report a vulnerability**). Only the maintainers
see what you send. Please do not open a public issue, a pull request or a
discussion about it first.

Say what you found, how to reproduce it, and what somebody could do with it.
A proof of concept is welcome; please do not test against an install that is
not yours.

## What happens next

You get an answer in the advisory itself. We confirm the problem, fix it on
`main`, publish a new image and new packages, and then publish the advisory,
with your name if you want it there.

## What is in scope

Everything in this repository: the tracker, the collector and the server, the
dashboard, the database adapters, the npm packages, and `packages/ee`. A
problem in a dependency is in scope when Chokh's use of it is what makes it
reachable.

Out of scope: an install somebody else runs (tell them), denial of service by
volume alone, and reports from automated scanners with no way to reproduce.

## Versions

Chokh is before its 1.0. Fixes go to `main` and to the next image and
packages; there is no older line kept up.
