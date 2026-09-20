import { test } from '@playwright/test';
import { verifyDemoGrouping } from './helpers/demo-group.mjs';

test('moves the initial demo SalesDB into and out of a newly created group', async ({ page }) => {
  await page.goto('/');
  await verifyDemoGrouping(page);
});
