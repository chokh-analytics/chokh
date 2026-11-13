'use client';

import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

import { consent as sendConsent, ensureStub } from './pa.js';
import {
  ERRORS_ID,
  TRACKER_ID,
  VITALS_ID,
  siblingScript,
  trackerAttributes,
  type ChokhTagOptions,
} from './tag.js';

export interface ChokhProviderProps extends ChokhTagOptions {
  // The tracker's URL, a.js on your Chokh server or a first-party path to it.
  src: string;
  // Core Web Vitals (v.js) and JavaScript errors (e.js): true for the file next
  // to src, a string for a URL of its own. Both report through a.js, so they
  // share its consent gate and its batch.
  vitals?: boolean | string;
  errors?: boolean | string;
  children?: ReactNode;
}

function addScript(id: string, src: string, attributes: Record<string, string> = {}): void {
  // Found again by id, so a second effect (React strict mode runs every effect
  // twice in development), a second provider or a tag the server already
  // rendered adds nothing. A second a.js would boot a second tracker and count
  // every page twice.
  if (document.getElementById(id) !== null) return;
  const script = document.createElement('script');
  script.id = id;
  script.src = src;
  script.async = true;
  for (const [name, value] of Object.entries(attributes)) {
    script.setAttribute(name, value);
  }
  document.head.appendChild(script);
}

// Loads the tracker once per document and keeps its consent in step with a
// prop. Renders its children and nothing else, so the server renders exactly
// what it would without it and there is nothing to hydrate; everything happens
// in effects, which never run on a server.
//
// It never sends a pageview: a.js counts the first page and every client
// navigation itself. And it never removes the tag on unmount, because removing
// a script does not stop what it started.
export function ChokhProvider(props: ChokhProviderProps): ReactElement {
  const { src, vitals, errors, children, consent, ...rest } = props;
  const attributes = trackerAttributes({ ...rest, ...(consent === undefined ? {} : { consent }) });
  // The attributes are read when the tag is first added and never again: the
  // tracker reads them once, when it boots. The effect is keyed on their text,
  // so a parent that passes a new object on every render does not rerun it.
  const key = JSON.stringify([src, attributes, vitals, errors]);

  useEffect(() => {
    ensureStub();
    addScript(TRACKER_ID, src, attributes);
    const vitalsSrc = siblingScript(src, vitals, 'v.js');
    if (vitalsSrc !== undefined) addScript(VITALS_ID, vitalsSrc);
    const errorsSrc = siblingScript(src, errors, 'e.js');
    if (errorsSrc !== undefined) addScript(ERRORS_ID, errorsSrc);
  }, [key]);

  // Consent is sent when it is granted and when it changes, never as the
  // starting false: the tag's data-consent already holds every event until it is
  // granted, and the tracker reads a false as consent withdrawn, which throws
  // away what it was holding, the first pageview among it. The last value sent
  // is kept in a ref, so strict mode's second run of the effect sends nothing.
  const sent = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (consent === undefined || consent === sent.current) return;
    if (sent.current === undefined && !consent) {
      sent.current = false;
      return;
    }
    sent.current = consent;
    sendConsent(consent);
  }, [consent]);

  return <>{children}</>;
}
