import { test, expect } from '@playwright/test';

test('separates SQL workspace, executes and preserves tabs across screen changes', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'SQLエディタ' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'アクティビティ', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'データプレビュー', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'SQLクエリ' }).fill('SELECT * FROM Customer LIMIT 3;');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.locator('.query-data tbody tr')).toHaveCount(3);
  await expect(page.locator('.query-data')).toContainText('Aoki');
  await page.getByRole('button', { name: '複製', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Query 2', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'SQLクエリ' }).fill('SELECT * FROM Product LIMIT 2;');
  await page.getByRole('textbox', { name: 'SQLクエリ' }).press('Control+Enter');
  await expect(page.locator('.query-data tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'リレーション', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'アクティビティ', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'クエリ詳細' })).toHaveCount(0);
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQLクエリ' })).toHaveValue(
    'SELECT * FROM Product LIMIT 2;',
  );
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await expect(page.locator('.query-data tbody tr')).toHaveCount(3);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'エクスポート', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('Query 1.csv');
  await page.getByRole('tab', { name: '実行計画', exact: true }).click();
  await page.getByRole('button', { name: '実行計画を取得（EXPLAIN）' }).click();
  await expect(page.locator('.query-data')).toContainText('デモの実行計画');
  await page.getByRole('tab', { name: '結果', exact: true }).click();
  await page.screenshot({ path: 'test-results/query.png', fullPage: true });
  await page.getByRole('textbox', { name: 'SQLクエリ' }).fill('DELETE FROM Customer');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('デモでは');
  await page.setViewportSize({ width: 1000, height: 750 });
  await expect(page.getByRole('button', { name: '実行', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '次へ', exact: true })).toBeInViewport();
});

test('connection mode defaults to read only and can be changed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加' }).click();
  const option = page.getByRole('checkbox', { name: '読み取り専用', exact: true });
  await expect(option).toBeChecked();
  await option.uncheck();
  await expect(option).not.toBeChecked();
});
