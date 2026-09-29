// Run against a freshly launched desktop app with WebView2 remote debugging on port 9224.
import { chromium } from '@playwright/test';
import { verifyGrouping } from './helpers/connection-group.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
try {
  const page = browser.contexts()[0].pages()[0];
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('ポート').fill('3307');
  await page.getByLabel('データベース名').fill('relagrid_fixture');
  await page.getByLabel('ユーザー名').fill('root');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await verifyGrouping(page, 'relagrid_fixture', 2);
  await page.screenshot({ path: 'test-results/desktop-grouped.png' });
  console.log(
    'Native grouping passed: fixture connection moved into, out of, and back into a collapsed group.',
  );
} finally {
  await browser.close();
}
