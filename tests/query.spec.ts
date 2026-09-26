import { test, expect } from '@playwright/test';

test('header shortcuts select a workspace and preserve SQL when returning', async ({ page }) => {
  await page.goto('/');
  const relations = page.getByRole('button', { name: 'リレーション', exact: true });
  const sql = page.getByRole('button', { name: 'SQL', exact: true });
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await expect(page.getByRole('navigation', { name: '画面切り替え' })).toHaveCount(1);
  await page.keyboard.press('Control+2');
  await expect(sql).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toBeFocused();
  await editor.fill('SELECT 42;');
  await editor.press('Control+2');
  await expect(editor).toHaveText('SELECT 42;');
  await editor.press('Control+1');
  await expect(relations).toHaveAttribute('aria-pressed', 'true');
  await expect(relations).toBeFocused();
  await page.keyboard.press('Control+1');
  await expect(page.locator('.graph-area')).toBeVisible();
  const header = await page.locator('.window-header').boundingBox();
  const graph = await page.locator('.graph-area').boundingBox();
  expect(graph!.y).toBe(header!.y + header!.height);
  await page.keyboard.press('Control+2');
  await expect(editor).toHaveText('SELECT 42;');
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('データベース名').press('Control+1');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sql).toHaveAttribute('aria-pressed', 'true');
});

test('keyboard commands share execution and tab actions while respecting focus and IME', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill('SELECT * FROM Customer LIMIT 3;');
  await editor.press('Home');
  await editor.press('Control+Shift+ArrowRight');
  await editor.press('F5');
  await expect(page.locator('.query-data tbody tr')).toHaveCount(3);
  await expect(page.locator('.query-history button')).toHaveCount(1);
  await editor.press('Control+Enter');
  await expect(page.locator('.query-history button')).toHaveCount(2);
  await editor.press('Control+t');
  await expect(page.getByRole('tab', { name: 'Query 2', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(editor).toBeFocused();
  await editor.press('Control+Shift+Tab');
  await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(editor).toBeFocused();
  await editor.press('Control+Tab');
  page.once('dialog', (dialog) => dialog.dismiss());
  await editor.press('Control+w');
  await expect(page.getByRole('tab', { name: 'Query 2', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await editor.press('Control+w');
  await expect(page.getByRole('tab', { name: 'Query 2', exact: true })).toHaveCount(0);
  await expect(editor).toBeFocused();
  await editor.dispatchEvent('keydown', { key: 'F5', code: 'F5', isComposing: true });
  await expect(page.locator('.query-history button')).toHaveCount(2);
  await editor.press('Control+Shift+m');
  await expect(page.locator('.graph-area')).toBeVisible();
  await page.keyboard.press('Control+Shift+m');
  await expect(editor).toBeFocused();
  const search = page.getByRole('textbox', { name: 'テーブル・カラムを検索' });
  await search.press('Control+Shift+m');
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('データベース名').press('Control+Shift+m');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
});

test('switches independent result sets and displays partial failure without hiding retained rows', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const exported = { name: '', text: '', complete: false, executions: 0 };
    Object.assign(window, {
      exported,
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { sql?: string; name?: string; text?: string }) => {
          if (command === 'begin_csv_export') {
            exported.name = args.name!;
            return 'export-1';
          }
          if (command === 'write_csv_export') {
            exported.text += args.text;
            return;
          }
          if (command === 'finish_csv_export') {
            exported.complete = true;
            return;
          }
          if (command === 'connect_database') return { tables: [], relationships: [] };
          if (command !== 'execute_query') return;
          exported.executions++;
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
  await page.getByRole('button', { name: 'エクスポート', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('100件 / 2列（全ページ）');
  await expect(dialog).toContainText('型保持形式は未対応');
  await dialog.getByRole('button', { name: '保存先を選んで出力' }).click();
  await expect(dialog.getByRole('status')).toContainText('100件の保存が完了');
  const exported = await page.evaluate(
    () =>
      (
        window as unknown as {
          exported: { name: string; text: string; complete: boolean; executions: number };
        }
      ).exported,
  );
  expect(exported.name).toBe('Query 2-result-2.csv');
  expect(exported.complete).toBe(true);
  expect(exported.executions).toBe(1);
  expect(exported.text).toMatch(/^\uFEFF"product","price"\r\n/);
  expect(exported.text).toContain('"product-99","500"');
  expect(exported.text).not.toContain('customer-');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).first().click();
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
  await expect(page.getByRole('region', { name: 'SQLエディタ', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: '保存先を選んで出力' }).click();
  expect((await download).suggestedFilename()).toBe('Query 1.csv');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '閉じる', exact: true })
    .first()
    .click();
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
