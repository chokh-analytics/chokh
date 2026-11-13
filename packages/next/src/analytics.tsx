import {
  CHOKH_QUEUE_STUB,
  ERRORS_ID,
  TRACKER_ID,
  VITALS_ID,
  siblingScript,
  trackerAttributes,
  type ChokhTagOptions,
} from '@chokh/react';
import Script from 'next/script';
import type { ReactElement } from 'react';

import { ChokhConsent } from './consent.js';
import { normalisePath } from './config.js';

export interface AnalyticsProps extends ChokhTagOptions {
  // The first-party path withChokh serves the scripts under and the collect
  // route answers on. Default /_pa: the tracker is /_pa/a.js and posts to
  // /_pa/collect.
  path?: string;
  // The tracker's URL when it is not served first-party, for example
  // https://analytics.example.com/a.js. It then posts beside itself unless api
  // says otherwise.
  src?: string;
  // Core Web Vitals (v.js) and JavaScript errors (e.js), from beside a.js, or a
  // string for a URL of their own.
  vitals?: boolean | string;
  errors?: boolean | string;
}

// The tracker in an App Router layout, in one line:
//
//   <Analytics site="my_site" visitorId="persistent" vitals errors />
//
// What it renders: the tracker's queue stub inline (so v.js, e.js or your own
// track() calls that run before a.js boots wait for it instead of being lost),
// then the scripts through next/script, after hydration and off the first
// paint's path, de-duplicated by id. Nothing here sends a pageview: a.js counts
// the first page and every client navigation itself (the App Router navigates
// with history.pushState, which the tracker watches), so a page load and a
// <Link> each count once.
//
// consent works as it does on <ChokhProvider>: left out, no gate; a boolean puts
// data-consent on the tag, holds every event until it is true, and a later
// false withdraws.
export function Analytics(props: AnalyticsProps): ReactElement {
  const { path, src, vitals, errors, api, ...tag } = props;
  const firstParty = src === undefined;
  const base = normalisePath(path);
  const trackerSrc = src ?? `${base}/a.js`;
  const attributes = trackerAttributes({
    ...tag,
    ...(api !== undefined ? { api } : firstParty ? { api: base } : {}),
  });
  const vitalsSrc = siblingScript(trackerSrc, vitals, 'v.js');
  const errorsSrc = siblingScript(trackerSrc, errors, 'e.js');

  return (
    <>
      <script id="chokh-stub" dangerouslySetInnerHTML={{ __html: CHOKH_QUEUE_STUB }} />
      <Script id={TRACKER_ID} src={trackerSrc} strategy="afterInteractive" {...attributes} />
      {vitalsSrc === undefined ? null : <Script id={VITALS_ID} src={vitalsSrc} strategy="afterInteractive" />}
      {errorsSrc === undefined ? null : <Script id={ERRORS_ID} src={errorsSrc} strategy="afterInteractive" />}
      {tag.consent === undefined ? null : <ChokhConsent consent={tag.consent} />}
    </>
  );
}
