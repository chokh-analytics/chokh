// @chokh/sdk-node: what an application's own server needs from Chokh.
//
// Two jobs, and they are separate on purpose.
//
// The two signing lines are the ones that cannot live anywhere else. A page
// calling pa('identify', userId) can claim to be anybody, so a site whose
// administrators can then read that person's addresses and pages signs the userId
// on its server and hands the page the signature; and a first-party proxy in front
// of the collector is the peer it sees, so the proxy signs the visitor's address
// it forwards. signUserId and signForwardedAddress are the lines that make those,
// and they are here rather than imported from the collector because a product must
// not depend on its own client SDK: the server verifies, this signs, and a shared
// test vector in both packages is what stops each pair drifting apart. They live
// in sign.ts.
//
// createClient is the other half: track and identify for facts a backend knows
// and a browser either cannot see or cannot be trusted about, queued, batched per
// person and retried, so a checkout never waits on analytics. It lives in
// client.ts, with the reasons for every limit it keeps.
//
// No dependency beyond Node's standard library.

export { signForwardedAddress, signUserId } from './sign.js';
export {
  ChokhError,
  DEFAULTS,
  LIMITS,
  createClient,
  type ChokhAttributes,
  type ChokhBatch,
  type ChokhClient,
  type ChokhClientOptions,
  type ChokhDrop,
  type ChokhEvent,
  type ChokhEventType,
  type ChokhSendResult,
  type DropReason,
  type FlushResult,
  type IdentifyOptions,
  type QueuedEvent,
  type TrackOptions,
} from './client.js';
