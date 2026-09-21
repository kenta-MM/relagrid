// Launch npm run dev with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223.
// Reads the ignored local connection file; leaves the sample database connected.
import { chromium, expect } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = browser.contexts()[0].pages()[0];
  await page.getByRole('button', { name: 'リレーション', exact: true }).click();
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  const upload = page.getByLabel('接続ファイルを読み込む（JSON）');
  await upload.setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await expect(page.getByRole('alert')).toContainText('有効なJSON');
  await upload.setInputFiles('connections/relagrid-sample.local.json');
  await expect(page.getByRole('status')).toContainText('relagrid-sample.local.json');
  await expect(page.getByLabel('データベース名')).toHaveValue('relagrid_sample');
  await expect(page.getByLabel('読み取り専用', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await page
    .locator('.tree-table')
    .filter({ hasText: /^customers$/ })
    .click();
  await page.getByRole('button', { name: 'データを表示', exact: true }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(12);
  await expect(page.locator('.data-table')).toContainText('青木 商店');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'SQLクエリ' })
    .fill(
      'SELECT o.order_id, c.name, i.line_no FROM orders o JOIN customers c ON c.customer_id=o.customer_id JOIN order_items i ON i.order_id=o.order_id ORDER BY o.order_id, i.line_no',
    );
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByLabel('1ページの行数').selectOption('100');
  await expect(page.locator('.query-data tbody tr')).toHaveCount(72);
  await page
    .getByRole('textbox', { name: 'SQLクエリ' })
    .fill('SELECT * FROM orders WHERE employee_id IS NULL ORDER BY order_id');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.locator('.query-data tbody tr')).toHaveCount(9);
  await page.getByRole('button', { name: 'リレーション', exact: true }).click();
  await page.screenshot({ path: 'test-results/desktop-sample-connection.png' });
  console.log(
    'PASS: invalid file recovery, JSON import, real MySQL connection, 7 tables, 12 Japanese customer rows, 72 JOIN rows, 9 NULL-filter rows.',
  );
} finally {
  await browser.close();
}
