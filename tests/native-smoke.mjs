// Opt-in integration smoke test. Launch the debug desktop app with WebView2
// remote debugging on port 9223 and the isolated MySQL fixture on port 3307.
import { chromium, expect } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = browser.contexts()[0].pages()[0];
  await expect(page.getByRole('heading', { name: 'リレーションシップマップ' })).toBeVisible();
  await page.getByRole('button', { name: '接続', exact: true }).click();
  await page.getByLabel('ポート').fill('3307');
  await page.getByLabel('データベース名').fill('relagrid_fixture');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await page
    .locator('.tree-table')
    .filter({ hasText: /^order$/i })
    .click();
  await page.getByRole('button', { name: 'データを表示', exact: true }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.data-table')).toContainText('1234.50');
  await expect(page.locator('.data-table')).toContainText('00FF');
  // A failed replacement must leave the existing connection intact.
  await page.getByRole('button', { name: '接続', exact: true }).click();
  await page.getByLabel('ポート').fill('3307');
  await page.getByLabel('データベース名').fill('relagrid_nonexistent_fixture');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await page.getByRole('button', { name: 'デモに切り替え・切断' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Order$/ })
    .click();
  await page.getByRole('tab', { name: 'アクティビティ', exact: true }).click();
  await page.getByRole('button', { name: '全体表示', exact: true }).click();
  await page.screenshot({ path: 'test-results/desktop.png' });
  console.log(
    'Native smoke passed: IPC, MySQL schema, preview, failed reconnect, refresh, disconnect.',
  );
} finally {
  await browser.close();
}
