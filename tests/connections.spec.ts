import { test, expect } from '@playwright/test';

test('groups added connections, collapses groups and switches the active database', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { config?: { database: string } }) => {
          if (command === 'disconnect_database') return;
          const database = args.config?.database ?? 'sales';
          return {
            tables: [
              {
                id: `${database}.orders`,
                schema: database,
                name: 'orders',
                estimatedRows: 0,
                columns: [],
              },
            ],
            relationships: [],
          };
        },
      },
    });
  });
  await page.goto('/');
  for (const [database, group] of [
    ['SalesDB', ' 本番環境 '],
    ['BillingDB', '本番環境'],
    ['SalesDB-Stg', '検証環境'],
    ['DevLocal', '   '],
  ]) {
    await page.getByRole('button', { name: '接続を追加' }).click();
    await page.getByLabel('データベース名').fill(database);
    await page.getByLabel('グループ名（任意）').fill(group);
    await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const connections = page.getByRole('navigation', { name: '接続一覧' });
  await expect(connections.locator('.connection-group')).toHaveCount(2);
  const production = connections.locator('.connection-group').filter({ hasText: '本番環境' });
  await expect(production.locator('.group-count')).toHaveText('2');
  await expect(connections.locator(':scope > .connection-item')).toHaveText('DevLocal');
  await production.locator('summary').click();
  await expect(production.getByRole('button', { name: 'SalesDB', exact: true })).toBeHidden();
  await production.locator('summary').focus();
  await page.keyboard.press('Enter');
  await production.getByRole('button', { name: 'SalesDB', exact: true }).click();
  await expect(production.getByRole('button', { name: 'SalesDB', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.schema-tree summary')).toContainText('SalesDB');
  await expect(connections.getByRole('button')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/connections.png', fullPage: true });
  await page.setViewportSize({ width: 1000, height: 750 });
  await page.getByRole('button', { name: '接続を追加' }).click();
  await expect(page.getByLabel('グループ名（任意）')).toBeInViewport();
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '接続してスキーマを読み込む' })).toBeInViewport();
});
