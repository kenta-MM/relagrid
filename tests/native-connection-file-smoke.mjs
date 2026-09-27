// Launch npm run dev with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223.
// Requires the isolated MySQL fixture documented in README (localhost:3307).
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
  await upload.setInputFiles({
    name: 'fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        host: '127.0.0.1',
        port: 3307,
        database: 'relagrid_fixture',
        username: 'root',
        password: '',
        readOnly: true,
      }),
    ),
  });
  await expect(page.getByLabel('データベース名')).toHaveValue('relagrid_fixture');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.status-bar')).toContainText('未接続');
  const connection = page.getByRole('button', { name: 'relagrid_fixture', exact: true }).last();
  await connection.click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2, { timeout: 15000 });
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Order$/ })
    .click();
  await page.getByRole('button', { name: 'データを表示', exact: true }).click();
  await expect(page.locator('.data-table')).toContainText('1234.50');
  console.log(
    'PASS: invalid JSON recovery, import, encrypted persistence, reload, reconnect, preview.',
  );
} finally {
  await browser.close();
}
