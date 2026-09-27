import { openFixture } from './helpers/connection-fixture';
import { test } from '@playwright/test';
import { verifyGrouping } from './helpers/connection-group.mjs';

test('moves the fixture connection into and out of a newly created group', async ({ page }) => {
  await openFixture(page);
  await verifyGrouping(page);
});
