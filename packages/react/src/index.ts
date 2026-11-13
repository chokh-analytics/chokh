// @chokh/react: the Chokh tracker in a React app.
//
// <ChokhProvider> adds the tracker's tag once per document; useTrack and
// useChokh call it with types. The tracker itself counts every page and every
// client navigation, so nothing here sends a pageview and React strict mode
// cannot double one. No tracker code is in this package: a.js is loaded from
// your Chokh server (or a first-party path to it), as it is without React.

export { ChokhProvider, type ChokhProviderProps } from './provider.js';
export { useChokh, useTrack, type Chokh } from './hooks.js';
export { CHOKH_QUEUE_STUB, consent, ensureStub, identify, reset, track, type ChokhProps } from './pa.js';
export {
  ERRORS_ID,
  TRACKER_ID,
  VITALS_ID,
  siblingScript,
  trackerAttributes,
  type ChokhTagOptions,
} from './tag.js';
