import { test, expect } from '@playwright/test';

test('switches independent result sets and displays partial failure without hiding retained rows', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { sql?: string }) => {
          if (command === 'connect_database') return { tables: [], relationships: [] };
          if (command !== 'execute_query') return;
          const resultSets = [
            {
              columns: ['customer'],
              rows: Array.from({ length: 100 }, (_, i) => [`customer-${i}`]),
              affectedRows: 0,
              complete: true,
              truncated: false,
            },
            {
              columns: ['product', 'price'],
              rows: Array.from({ length: 100 }, (_, i) => [`product-${i}`, '500']),
              affectedRows: 0,
              complete: true,
              truncated: false,
            },
          ];
          return {
            ...resultSets[0],
            elapsedMs: 5,
            referencedTables: [],
            resultSets,
            error: args.sql?.includes('fail')
              ? '文3で失敗しました。取得済み結果を表示しています。'
              : null,
          };
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加' }).click();
  await page.getByLabel('データベース名').fill('fixture');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill('SELECT * FROM Customer; SELECT * FROM Product;');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.locator('.query-data')).toContainText('customer-0');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('tab', { name: '結果 2', exact: true }).click();
  await expect(page.locator('.query-data')).toContainText('product-0');
  await expect(page.locator('.query-data')).not.toContainText('customer-');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'エクスポート', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('Query 2-result-2.csv');
  await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
  await page.getByRole('tab', { name: 'Query 2', exact: true }).click();
  await expect(page.getByRole('tab', { name: '結果 2' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '結果 1', exact: true }).click();
  await expect(page.locator('.query-data')).toContainText('customer-10');
  await editor.fill("SELECT 'fail'; SELECT * FROM Product;");
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('実行全体は失敗');
  await expect(page.locator('.query-data')).toContainText('customer-0');
  await page.screenshot({ path: 'test-results/query-multiple.png', fullPage: true });
});

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
  await expect(page.getByRole('textbox', { name: 'SQLクエリ' })).toHaveText(
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

test('SQL editor completes types and scoped columns with Tab and marks mistyped types', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill('SELECT CAST(1 AS ');
  await editor.pressSequentially('VARC', { delay: 80 });
  await expect(page.getByRole('option', { name: /VARCHAR/ }).first()).toBeVisible();
  await editor.press('Tab');
  await expect(editor).toHaveText('SELECT CAST(1 AS VARCHAR');

  await editor.fill('SELECT  FROM Customer c');
  await editor.press('Control+Home');
  for (let i = 0; i < 7; i++) await editor.press('ArrowRight');
  await editor.pressSequentially('c.', { delay: 80 });
  await expect(page.getByRole('option', { name: /customer_id/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /email/ })).toBeVisible();
  await editor.pressSequentially('ema', { delay: 80 });
  await expect(page.getByRole('option', { name: /email/ })).toBeVisible();
  await editor.press('Tab');
  await expect(editor).toHaveText('SELECT c.email FROM Customer c');

  await editor.fill(
    'SELECT  FROM (SELECT customer_id AS id, COUNT(*) AS total FROM Customer GROUP BY customer_id) summary',
  );
  await editor.press('Control+Home');
  for (let i = 0; i < 7; i++) await editor.press('ArrowRight');
  await editor.pressSequentially('summary.', { delay: 60 });
  await expect(page.getByRole('option', { name: /total/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /email/ })).toHaveCount(0);
  await editor.press('ArrowDown');
  await editor.press('Tab');
  await expect(editor).toContainText('summary.total');

  await editor.fill('SELECT CAST(1 AS INTT)');
  await expect(page.locator('.cm-lintRange-error')).toHaveText('INTT');
  await page.screenshot({ path: 'test-results/query-type-error.png', fullPage: true });
  await editor.fill('SELECT CAST(1 AS SIGNED)');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  await editor.fill('SELECT CAST(1 AS ');
  await editor.pressSequentially('DEC', { delay: 80 });
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.screenshot({ path: 'test-results/query-completion.png', fullPage: true });
  await editor.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});
