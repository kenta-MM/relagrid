import { test, expect } from '@playwright/test';

// UI/IPC fixture only. Actual Express coverage is the opt-in Rust smoke test.
test('SQL Server selection survives save and reload and uses T-SQL in the editor', async ({
  page,
}) => {
  const snapshot = {
    sessionId: 'express-fixture',
    tables: [
      {
        id: '[dbo].[Order]',
        schema: 'dbo',
        name: 'Order',
        estimatedRows: null,
        columns: [{ name: 'id', dataType: 'int', primaryKey: true, nullable: false }],
      },
    ],
    relationships: [],
  };
  let saved = { connections: [] as unknown[], groups: [] as string[] };
  await page.exposeFunction(
    'fixtureInvoke',
    (command: string, args: { config?: { databaseKind?: string }; data?: typeof saved }) => {
      if (command === 'load_queries') return [];
      if (command === 'load_connections') return saved;
      if (command === 'save_connections') {
        saved = args.data!;
        return;
      }
      if (command === 'connect_database') {
        if (args.config?.databaseKind !== 'sqlServer')
          throw new Error('SQL Serverの接続設定ではありません');
        return snapshot;
      }
      if (command === 'refresh_schema') return snapshot;
    },
  );
  await page.addInitScript(() =>
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: unknown = {}) =>
          (
            window as unknown as { fixtureInvoke(command: string, args: unknown): Promise<unknown> }
          ).fixtureInvoke(command, args),
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('データベースの種類').selectOption('sqlServer');
  await expect(page.getByLabel('ポート')).toHaveValue('1433');
  await page.getByLabel('ポート').fill('51433');
  await page.getByLabel('データベースの種類').selectOption('mysql');
  await expect(page.getByLabel('ポート')).toHaveValue('51433');
  await page.getByLabel('接続ファイルを読み込む（JSON）').setInputFiles({
    name: 'express.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        host: '127.0.0.1',
        port: 51433,
        database: 'ExpressFixture',
        username: 'reader',
        databaseKind: 'sqlServer',
        tlsEnabled: false,
      }),
    ),
  });
  await expect(page.getByLabel('データベースの種類')).toHaveValue('sqlServer');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.status-bar')).toContainText('SQL Server · ExpressFixture');
  await page.reload();
  await page.getByRole('button', { name: 'ExpressFixture', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('SQL Server · ExpressFixture');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQLクエリ' })).toContainText(
    'SELECT TOP (100) * FROM [dbo].[Order]',
  );
  await page.getByRole('tab', { name: '実行計画', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '実行計画を取得（EXPLAIN）', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: 'test-results/sql-server-editor.png', fullPage: true });
});
