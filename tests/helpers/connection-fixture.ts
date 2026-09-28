import { expect, type Page } from '@playwright/test';
import { demoGateway, demoSnapshot } from '../fixtures/demo';

// Test-only backend. No fixture schemas or credentials are bundled into the app.
export async function openFixture(page: Page) {
  await page.exposeFunction(
    'fixtureInvoke',
    async (command: string, args: { tableId?: string; sql?: string; explain?: boolean }) => {
      if (command === 'load_queries') return [];
      if (command === 'load_connections') return { connections: [], groups: [] };
      if (command === 'connect_database' || command === 'refresh_schema') return demoSnapshot;
      if (command === 'preview_table')
        return demoGateway.preview(demoSnapshot.tables.find((t) => t.id === args.tableId)!);
      if (command === 'execute_query') return demoGateway.execute(args.sql!, args.explain);
    },
  );
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: unknown = {}) =>
          (
            window as unknown as { fixtureInvoke(command: string, args: unknown): Promise<unknown> }
          ).fixtureInvoke(command, args),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('データベース名').fill('SalesDB');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .locator('.tree-table')
    .filter({ hasText: /^Order$/ })
    .click();
}
