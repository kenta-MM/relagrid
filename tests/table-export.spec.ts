import { test, expect } from '@playwright/test';

test('exports the selected table independently of the preview limit', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, {
      isTauri: true,
      exportCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (
          command: string,
          args: { tableId?: string; progress?: { onmessage(value: { rows: number }): void } },
        ) => {
          calls.push(command);
          if (command === 'connect_database')
            return {
              tables: [
                {
                  id: 'fixture.target',
                  name: 'target',
                  schema: 'fixture',
                  estimatedRows: 9000,
                  columns: [{ name: 'id', dataType: 'int', nullable: false, primaryKey: true }],
                },
              ],
              relationships: [],
            };
          if (command === 'preview_table') return { columns: ['id'], rows: [['1']] };
          if (command === 'begin_csv_export') return 'job';
          if (command === 'export_table_csv') {
            if (args.tableId !== 'fixture.target') throw new Error('wrong source');
            args.progress?.onmessage({ rows: 1200 });
            return 1205;
          }
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加' }).click();
  await page.getByLabel('データベース名').fill('fixture');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await page.getByRole('button', { name: 'データを表示', exact: true }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'テーブル全件をCSV出力' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('fixture.target');
  await expect(dialog).toContainText('プレビューの100件制限は適用しません');
  await dialog.getByRole('button', { name: '保存先を選んで全件出力' }).click();
  await expect(dialog.getByRole('status')).toContainText('1205件の保存が完了');
  const calls = await page.evaluate(
    () => (window as unknown as { exportCalls: string[] }).exportCalls,
  );
  expect(calls.filter((command) => command === 'export_table_csv')).toHaveLength(1);
  expect(calls).not.toContain('execute_query');
  await page.screenshot({ path: 'test-results/table-export.png', fullPage: true });
});
