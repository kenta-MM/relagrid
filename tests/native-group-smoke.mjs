// Run against a freshly launched desktop app with WebView2 remote debugging on port 9224.
import { chromium } from '@playwright/test';
import { verifyDemoGrouping } from './helpers/demo-group.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
try {
  const page = browser.contexts()[0].pages()[0];
  await verifyDemoGrouping(page);
  await page.screenshot({ path: 'test-results/desktop-grouped.png' });
  console.log(
    'Native grouping passed: demo SalesDB moved into, out of, and back into a collapsed group.',
  );
} finally {
  await browser.close();
}
