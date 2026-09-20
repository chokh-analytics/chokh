// The account the suite signs in as, and where its session is kept.
//
// In a file of its own because Playwright refuses to let one test file import
// another, and both the setup project and the signed-out case need the same
// two strings. A test password on a test port: the server refuses to boot in
// production without a real secret, and nothing here reaches one.
export const OWNER = { email: 'owner@chokh.test', password: 'a-long-enough-password' };

export const STATE = 'e2e/.auth/owner.json';

// The same string server.mjs pins, written twice for the same reason the
// account is: that file is a .mjs and cannot import this one. The SSO case
// signs a token with it and the server verifies against it, which is the whole
// exchange.
export const SSO_SECRET = 'chokh-e2e-sso-secret-not-for-production';
