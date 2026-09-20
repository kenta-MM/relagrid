import { test, expect } from '@playwright/test';
test('explores a table, searches columns, and previews data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'リレーションシップマップ' })).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await page.keyboard.press('/');
  await expect(page.getByRole('textbox', { name: 'テーブル・カラムを検索' })).toBeFocused();
  await page.getByRole('button', { name: 'データを表示', exact: true }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(8);
  await page.getByRole('textbox', { name: 'テーブル・カラムを検索' }).fill('email');
  await expect(page.locator('.tree-table')).toHaveCount(1);
  await page.locator('.tree-table').click();
  await expect(page.locator('.selected-table h3')).toHaveText('Customer');
  await expect(page.locator('.data-table')).toHaveCount(0);
  await page.getByRole('button', { name: '検索をクリア' }).click();
  await expect(page.locator('.tree-table')).toHaveCount(7);
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Order$/ })
    .click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(8);
  await expect(page.locator('.data-table th').first()).toHaveText('order_id');
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Customer$/ })
    .click();
  await page.getByRole('button', { name: 'データを表示', exact: true }).click();
  await expect(page.locator('.data-table th').first()).toHaveText('customer_id');
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Order$/ })
    .click();
  await expect(page.locator('.data-table th').first()).toHaveText('order_id');
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Customer$/ })
    .click();
  await expect(page.locator('.data-table th').first()).toHaveText('customer_id');
  await page.getByRole('button', { name: '関連テーブルを強調' }).click();
  await expect(page.locator('.table-node.is-muted')).toHaveCount(5);
  await page.getByRole('button', { name: 'すべての関係を表示' }).click();
  await page.getByRole('tab', { name: 'カラム' }).click();
  await expect(page.locator('.column-details > div')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/explorer.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('connection dialog explains desktop requirement without losing demo data', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '接続', exact: true }).click();
  await page.getByLabel('データベース名').fill('sales');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('alert')).toContainText('デスクトップ版');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
});
