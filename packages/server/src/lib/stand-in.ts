import { createHmac } from 'node:crypto';

// A stand-in for an id that says who somebody is, shown to a caller who may
// not be told.
//
// The audit log names whoever acted by their account's id. An id this install
// made (`u_` and a random part, or a key's) says nothing about anybody. An
// account another application signs in is different: its id is `sso_` and
// that application's own name for the person, and nothing stops an install
// using an address or a username there. For a caller without read:identity
// that id is replaced by this.
//
// Keyed, with a key derived from the session secret for this one purpose, so
// it cannot be turned back or checked against a guess without the server's
// secret; and a plain function of the id, so the same account is the same
// stand-in on every row and every page, and a reader can still see that two
// rows were the same somebody.
export function createStandIn(secret: string): (id: string) => string {
  const key = createHmac('sha256', secret).update('chokh audit stand-in v1').digest();
  return (id: string): string =>
    // The prefix says what kind of account it is, which the reader may know.
    `sso~${createHmac('sha256', key).update(id).digest('base64url').slice(0, 22)}`;
}
