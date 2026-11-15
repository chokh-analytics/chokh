---
title: Licence
lead: Chokh is open core. Everything is in one repository; most of it is MIT, and one directory is under a commercial licence.
description: What in Chokh is MIT and free to host, what is under the Chokh Enterprise Licence, and what a licence key does.
---

## Two licences, one repository

Everything in the repository except the `packages/ee` directory is under the
[MIT licence](https://github.com/chokh-analytics/chokh/blob/main/LICENSE). The
`packages/ee` directory is under the
[Chokh Enterprise Licence](https://github.com/chokh-analytics/chokh/blob/main/packages/ee/LICENSE),
version 1.0. Both are copyright BWJ Tech Ltd.

## What is in each half

| Core: MIT, free to host | `packages/ee`: commercial licence, needs a key |
| --- | --- |
| The tracker, the collector, the store and both database adapters, the dashboard and every report | Hosted Chokh Cloud |
| Events, goals, funnels, filters, segments, annotations | Alerts by email, Telegram and webhook |
| CSV and JSON exports, the public share page and the embed | Scheduled email and PDF digests |
| The stats API, the live stream, the SDKs, one team with owner, editor and viewer, roles on a single site, invitations | More than one team, and single sign-on through OpenID Connect |
| Retention of 1 to 3650 days per site, the audit log | White-label, priority support |
| Vitals, errors, retention cohorts, journeys | Session replay, heatmaps, surveys, experiments, flags |

What `packages/ee` holds today is alerts, digests, more than one team and
single sign-on. The rest of the right-hand column is planned and not built
yet.

## What the MIT half lets you do

Anything the MIT licence allows: use it, change it, host it for yourself or for
others, sell a service on it, with the copyright notice kept. There is no seat
count, no limit on how many sites or visits it measures, and no feature in it
that waits for a key.

## What the commercial half lets you do

Without a key you may read, copy, compile and change the code in `packages/ee`
to inspect it, audit it, test it and contribute to it, but not run it in
production. With a valid key you may run the features the key names, for your
own use, on as many sites and for as many people as you like unless the key
says otherwise. You may not pass the code on, run it as a service for somebody
else, or get round the licence check. The licence itself is the text that
counts; this is a summary of it.

## What a key is

A licence key is a signed token that names who it is for, the features it
turns on and the day it expires. It is checked on the server against a public
key built into Chokh, and nothing is sent anywhere to check it: **Chokh does
not phone home, with a key or without one.** An install with no key is a
complete install: the paid features are still in the dashboard, named and
described as part of Chokh Pro, and the free ones all work.

## Contributing

Patches are welcome on either side of the line. Before your first one, read
[CONTRIBUTING.md](https://github.com/chokh-analytics/chokh/blob/main/CONTRIBUTING.md):
there is a contributor licence agreement, signed by adding one line to a file
in the same pull request.
