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
  await page.getByRole('button', { name: 'グループを追加' }).click();
  const groupDialog = page.getByRole('dialog');
  await groupDialog.getByLabel('グループ名', { exact: true }).fill('   ');
  await expect(groupDialog.getByRole('button', { name: '追加', exact: true })).toBeDisabled();
  await groupDialog.getByLabel('グループ名', { exact: true }).fill('  テスト環境  ');
  await groupDialog.getByRole('button', { name: '追加', exact: true }).click();
  const emptyGroup = page.locator('.connection-group').filter({ hasText: 'テスト環境' });
  await expect(emptyGroup.locator('.group-count')).toHaveText('0');
  await page.getByRole('button', { name: 'グループを追加' }).click();
  await groupDialog.getByLabel('グループ名', { exact: true }).fill('テスト環境');
  await expect(groupDialog.getByRole('alert')).toContainText('すでにあります');
  await expect(groupDialog.getByRole('button', { name: '追加', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
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
  await expect(connections.locator('.connection-group')).toHaveCount(3);
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
  await connections
    .getByRole('button', { name: 'DevLocal', exact: true })
    .dragTo(emptyGroup.locator('summary'));
  await expect(emptyGroup.getByRole('button', { name: 'DevLocal', exact: true })).toBeVisible();
  await expect(emptyGroup.locator('.group-count')).toHaveText('1');
  const staging = connections.locator('.connection-group').filter({ hasText: '検証環境' });
  async function dragOutside(name: string) {
    const source = connections.getByRole('button', { name, exact: true });
    await source.scrollIntoViewIfNeeded();
    const bounds = (await source.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 15, bounds.y + bounds.height / 2, {
      steps: 3,
    });
    const target = page.locator('.connection-ungroup-drop');
    await expect(target).toBeVisible();
    const dropBounds = (await target.boundingBox())!;
    await page.mouse.move(
      dropBounds.x + dropBounds.width / 2,
      dropBounds.y + dropBounds.height / 2,
      { steps: 5 },
    );
    await page.mouse.move(
      dropBounds.x + dropBounds.width / 2 + 1,
      dropBounds.y + dropBounds.height / 2,
    );
    await expect(target).toHaveClass(/drop-target/);
    await page.mouse.up();
  }
  await connections
    .getByRole('button', { name: 'DevLocal', exact: true })
    .dragTo(production.locator('summary'));
  await expect(production.getByRole('button', { name: 'DevLocal', exact: true })).toBeVisible();
  await expect(production.locator('.group-count')).toHaveText('3');
  await dragOutside('SalesDB-Stg');
  await expect(connections.locator(':scope > .connection-item')).toHaveText('SalesDB-Stg');
  await expect(staging.locator('.group-count')).toHaveText('0');
  await staging.locator('summary').click();
  await production
    .getByRole('button', { name: 'DevLocal', exact: true })
    .dragTo(staging.locator('summary'));
  await expect(staging.getByRole('button', { name: 'DevLocal', exact: true })).toBeVisible();
  await expect(staging.locator('.group-count')).toHaveText('1');
  await dragOutside('SalesDB');
  await expect(connections.locator(':scope > .connection-item.active')).toHaveText('SalesDB');
  await expect(page.locator('.schema-tree summary')).toContainText('SalesDB');
  await expect(connections.getByRole('button')).toHaveCount(4);
  await expect(page.locator('.connection-ungroup-drop')).toHaveCount(0);
  await expect(page.locator('.drop-target')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/connections.png', fullPage: true });
  await page.setViewportSize({ width: 1000, height: 750 });
  await page.getByRole('button', { name: '接続を追加' }).click();
  await expect(page.getByLabel('グループ名（任意）')).toBeInViewport();
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '接続してスキーマを読み込む' })).toBeInViewport();
});
