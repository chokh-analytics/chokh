// The account the suite signs in as, and where its session is kept.
//
// In a file of its own because Playwright refuses to let one test file import
// another, and both the setup project and the signed-out case need the same
// two strings. A test password on a test port: the server refuses to boot in
// production without a real secret, and nothing here reaches one.
export const OWNER = { email: 'owner@chokh.test', password: 'a-long-enough-password' };

export const STATE = 'e2e/.auth/owner.json';
