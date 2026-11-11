import type { Page } from '@playwright/test';

// Every destination, in the order the bar draws them.
export const DESTINATIONS = [
  'Overview',
  'Realtime',
  'Pages',
  'Sources',
  'Geo',
  'Devices',
  'Events',
  'Goals',
  'Funnels',
  'People',
  'Alerts',
];

// Go to a destination the way a person would (AN-DSH03): its link in the row
// when it is there, and through More when it is not. A case that only clicked
// row links would pass on a bar that hid a destination with no way to it.
export async function goTo(page: Page, label: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Report' });
  const link = nav.getByRole('link', { name: label, exact: true });
  if ((await link.count()) > 0) {
    await link.click();
    return;
  }
  await nav.getByRole('button', { name: /^More destinations/ }).click();
  await page
    .getByRole('group', { name: 'More destinations' })
    .getByRole('link', { name: label, exact: true })
    .click();
}
