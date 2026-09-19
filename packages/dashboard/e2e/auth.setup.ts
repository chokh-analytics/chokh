import { expect, test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { OWNER, STATE } from './fixture-account.js';

// One sign-in for the whole suite.
//
// The login route is rate limited by address, which is the point of it, so a
// suite that signs in before every case trips its own server's limiter around
// the ninth test and reports a product bug that is nothing of the kind. This
// signs in once, saves the session cookie, and every case that wants a session
// starts with it. The one case about signing in clears it and uses the form.

setup('sign in once', async ({ page }) => {
  const answer = await page.request.post('/api/auth/login', { data: OWNER });
  expect(answer.ok(), 'the fixture owner could not sign in').toBe(true);
  mkdirSync(dirname(STATE), { recursive: true });
  await page.context().storageState({ path: STATE });
});
