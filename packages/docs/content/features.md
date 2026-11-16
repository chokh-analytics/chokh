---
title: Features
lead: What Chokh measures and shows, with a picture of each report and a link into the demo. Everything here is in the MIT core and free to host, except the one section that says it needs a key.
description: Every feature of Chokh, open source web analytics you host yourself: realtime, sources, events, goals, funnels, journeys, retention, identified people, page speed, an API and a share page.
---

The pictures are of the [demo](/demo/), which runs in your browser over
invented data. Each one opens the report it shows, so you can press on it
rather than take our word.

## The first screen

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/">Open it in the demo</a></p>

Visitors, visits, pageviews, bounce rate and visit duration, one chart, and
four cards: the top pages, sources, countries and devices. Every number
carries a comparison with the period before, because a number on its own is
not something anybody can act on. Pressing any row filters the whole page
rather than opening another one: press a country, and the pages, the sources
and the devices become that country's.

<a class="shot" href="../demo/" aria-label="Open the overview in the demo"><img class="shot-light" src="../images/dashboard-overview-light.png" width="1440" height="1100" loading="lazy" alt="The overview: the headline numbers with their comparisons, a chart of the week, and the top pages, sources, countries and devices."><img class="shot-dark" src="../images/dashboard-overview-dark.png" width="1440" height="1100" loading="lazy" alt="The same overview in the dark theme."></a>

## Who is on the site now

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/realtime/">Open it in the demo</a></p>

Realtime says who, and not only how many: everybody online, which page each
is on and how long they have been there, then everybody seen in the last half
hour. A map places one dot per city. The same list is a live stream your own
code can read.

<a class="shot" href="../demo/s_demo/realtime/" aria-label="Open Realtime in the demo"><img class="shot-light" src="../images/dashboard-realtime-light.png" width="1440" height="1100" loading="lazy" alt="Realtime: nine people online, pageviews per minute, a map with a dot per city, the pages and countries they are on, and a row per visitor."><img class="shot-dark" src="../images/dashboard-realtime-dark.png" width="1440" height="1100" loading="lazy" alt="The same Realtime report in the dark theme."></a>

## Pages, sources, places and devices

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/geo/">Open it in the demo</a></p>

- **Pages**: every page, the pages visits came in on and left from, time on
  page and scroll depth.
- **Sources**: referrers, channels (AI assistants are a channel of their
  own) and UTM campaigns.
- **Places**: country, region and city, from a database on your own server.
  No address is sent to anybody to be looked up.
- **Devices**: browser, system and kind of device.

<a class="shot" href="../demo/s_demo/geo/" aria-label="Open Geo in the demo"><img class="shot-light" src="../images/dashboard-geo-light.png" width="1440" height="1100" loading="lazy" alt="Geo: a world map shaded in five bands by visitors, and the countries as a table beside it."><img class="shot-dark" src="../images/dashboard-geo-dark.png" width="1440" height="1100" loading="lazy" alt="The same Geo report in the dark theme."></a>

## Events and goals

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/goals/?goal=g_signup">Open it in the demo</a></p>

An event is anything your pages or your server say happened, by name, with
the properties it carried; the report breaks each event down by them.
[Sending one is a line](/quickstart/#send-an-event).

A goal turns a page or an event into a success. Choose one, and every report
gains a conversion column: of the people from this campaign, this country or
this browser, how many reached it. A goal is a question asked of the events
already stored, so one added today answers for every day those events cover.

<a class="shot" href="../demo/s_demo/goals/?goal=g_signup" aria-label="Open Goals in the demo"><img class="shot-light" src="../images/dashboard-goals-light.png" width="1440" height="1100" loading="lazy" alt="Goals: each goal with how many people reached it and its conversion rate, one of them chosen."><img class="shot-dark" src="../images/dashboard-goals-dark.png" width="1440" height="1100" loading="lazy" alt="The same Goals report in the dark theme."></a>

## Funnels

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/funnels/?funnel=f_course">Open it in the demo</a></p>

Two to eight steps people take in order, each a page or one of your goals,
and how many got through each one: within the same visit, or an hour, a day,
7 days or 30 days from the first step to the last. Between two steps it says
how many left. Like a goal, a funnel reads the stored events, so it answers
for the past as well.

<a class="shot" href="../demo/s_demo/funnels/?funnel=f_course" aria-label="Open Funnels in the demo"><img class="shot-light" src="../images/dashboard-funnels-light.png" width="1440" height="1100" loading="lazy" alt="Funnels: four steps drawn as bars, each with its count and share, and how many people left between them."><img class="shot-dark" src="../images/dashboard-funnels-dark.png" width="1440" height="1100" loading="lazy" alt="The same funnel in the dark theme."></a>

## The paths visits took

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/pages/?pages=journeys">Open it in the demo</a></p>

Journeys draws where visits went from the page they came in on, through the
next three pages, and how many ended at each. Pressing a page narrows the
report to the visits that saw it.

<a class="shot" href="../demo/s_demo/pages/?pages=journeys" aria-label="Open Journeys in the demo"><img class="shot-light" src="../images/dashboard-journeys-light.png" width="1440" height="1100" loading="lazy" alt="Journeys: a flow of visits from the entry page through three more steps, with how many ended at each."><img class="shot-dark" src="../images/dashboard-journeys-dark.png" width="1440" height="1100" loading="lazy" alt="The same flow in the dark theme."></a>

## Who comes back

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/retention/">Open it in the demo</a></p>

- **Cohorts**: people grouped by the week or month they were first seen, and
  the share of each group that returned in every later one.
- **Activity**: daily, weekly and monthly active people, how sticky the site
  is, and how many days people came.
- **Attribution**: everybody who reached a goal, split by what first brought
  them and by the visit they converted in.

It needs visitor ids that last, which is [a setting of the
site](/quickstart/#what-is-counted-and-what-is-kept); on a cookieless site
the report says why nobody is seen to return.

<a class="shot" href="../demo/s_demo/retention/" aria-label="Open Retention in the demo"><img class="shot-light" src="../images/dashboard-retention-light.png" width="1440" height="1100" loading="lazy" alt="Retention: twelve weekly cohorts as a grid, each row the people first seen that week and each cell the share of them who came back in a later week, shaded by that share."><img class="shot-dark" src="../images/dashboard-retention-dark.png" width="1440" height="1100" loading="lazy" alt="The same cohort grid in the dark theme."></a>

## People you identify

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/people/v/v_abcdef0001/">Open it in the demo</a></p>

A site that signs people in can name them by its own id. Each person then
has a history: the visits, the pages and the events, in order. Your server
can [sign the identify](/server-events/#sign-an-identify), so nobody names
themselves as somebody else. Names and addresses are shown only to an account
with the permission to read them, and every such read is a row in the audit
log.

<a class="shot" href="../demo/s_demo/people/v/v_abcdef0001/" aria-label="Open a profile in the demo"><img class="shot-light" src="../images/dashboard-people-light.png" width="1440" height="1100" loading="lazy" alt="A profile on the People report: one visitor's visits, pages and events in order."><img class="shot-dark" src="../images/dashboard-people-dark.png" width="1440" height="1100" loading="lazy" alt="The same profile in the dark theme."></a>

## Page speed and errors

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/health/">Open it in the demo</a></p>

Core Web Vitals as your own visitors met them (LCP, INP, CLS, FCP and TTFB),
by page and by kind of device, and the JavaScript errors their browsers
raised. Each is a small script of its own, loaded only on a site that asks
for it, so a site that does not want them pays nothing for them.

<a class="shot" href="../demo/s_demo/health/" aria-label="Open Health in the demo"><img class="shot-light" src="../images/dashboard-health-light.png" width="1440" height="1100" loading="lazy" alt="Health: LCP, INP and CLS at the 75th percentile, each rated with the share of good, needs improvement and poor page loads and a figure per device, then FCP and TTFB, then the slow pages."><img class="shot-dark" src="../images/dashboard-health-dark.png" width="1440" height="1100" loading="lazy" alt="The same Health report in the dark theme."></a>

## Segments, routes and marks on the chart

<p class="feature-meta"><span class="tag">Free</span></p>

- **Segments**: any list of filters saved under a name, applied again in one
  press, and drawn against the chart as a second line.
- **Routes**: `/courses/:slug` reads every course as one row.
- **Exclusions**: your own traffic kept out by address, path or query
  parameter.
- **Annotations**: a deploy, a campaign or an outage as a mark on the chart,
  added by hand or posted by your deploy pipeline.

## Exports, a public page and embeds

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/share/tok_demo/">Open the shared page in the demo</a></p>

A report downloads as CSV or JSON, with the range and the filters on screen
(People and Realtime do not: one is identity, the other a moment). A site can have one public link that
shows its headline numbers to anybody who has it, with a password if you
want one, and nothing about a person. With it come a badge for a README and
a small page an iframe may hold.

## Teams, roles and the audit log

<p class="feature-meta"><span class="tag">Free</span> <a href="../demo/s_demo/team/">Open it in the demo</a></p>

One team with owners, editors and viewers, and a role on a single site for
somebody who should see that site and nothing else, which is how a client
sees their own. Invitations are links you send yourself. The audit log
records who read which visitor's name or address, who was let in and who was
removed; nothing in it can be changed.

<a class="shot" href="../demo/s_demo/team/" aria-label="Open Team in the demo"><img class="shot-light" src="../images/dashboard-team-light.png" width="1440" height="1100" loading="lazy" alt="Team: an invitation form, the invitations waiting, the people in the team and the people on this one site."><img class="shot-dark" src="../images/dashboard-team-dark.png" width="1440" height="1100" loading="lazy" alt="The same Team page in the dark theme."></a>

## An API for all of it

<p class="feature-meta"><span class="tag">Free</span></p>

Everything the dashboard shows it reads from a JSON API, and so can you:
[every route is documented](/api/), with an OpenAPI file beside it. There
are packages for [Next.js](/nextjs/) and React, and one for [events from
your server](/server-events/).

## Privacy as settings

<p class="feature-meta"><span class="tag">Free</span></p>

By default Chokh sets no cookie and stores no full address. Per site you
choose cookieless or lasting visitor ids; full, anonymised or no addresses;
and how long raw data is kept, [from 1 to 3650
days](/self-hosting/#how-long-data-is-kept). Bots are filtered out. Nothing
is sent to us or to anybody else: [what is counted, and what is
kept](/quickstart/#what-is-counted-and-what-is-kept).

## One process, your database

<p class="feature-meta"><span class="tag">Free</span></p>

The tracker, the collector, the API and the dashboard are one process on one
address, started by `docker compose up`, on PostgreSQL 15 or newer or on
MongoDB 5 or newer. The script a page loads is under 3 KB. History from
Plausible, Umami and Google Analytics 4 [can be brought
in](/self-hosting/#moving-from-another-tool). The rest is in
[Self-hosting](/self-hosting/).

## What needs a key

<p class="feature-meta"><span class="tag pro">Chokh Pro</span></p>

Four things for larger teams are under a commercial licence and run only
with a licence key:

- Alerts to an email address, Telegram or a webhook: traffic off its usual
  level, a goal count, a burst of errors, or silence.
- Digests by email, every morning or once a week, with one page attached.
- More than one team.
- Single sign-on through OpenID Connect.

An install without a key is a complete install, and the key is checked on
your own server: [what is in each half](/licence/#what-is-in-each-half).
