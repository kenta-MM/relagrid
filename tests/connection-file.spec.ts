import { test, expect } from '@playwright/test';
import { openFixture } from './helpers/connection-fixture';

test('validates file size and JSON, preserves fields on failure and permits importing the same file again', async ({
  page,
}) => {
  await openFixture(page);
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const upload = dialog.getByLabel('接続ファイルを読み込む（JSON）');
  const database = dialog.getByLabel('データベース名');
  await database.fill('keep-this-draft');
  await upload.setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(65537, ' '),
  });
  await expect(dialog.getByRole('alert')).toContainText('64KB以下');
  await expect(database).toHaveValue('keep-this-draft');
  await upload.setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"password":"private'),
  });
  await expect(dialog.getByRole('alert')).toContainText('有効なJSON');
  await expect(dialog.getByRole('alert')).not.toContainText('private');
  await expect(database).toHaveValue('keep-this-draft');
  const valid = {
    name: 'connection.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      '\uFEFF' +
        JSON.stringify({
          host: ' localhost ',
          port: 3307,
          database: ' imported ',
          username: 'reader',
          password: '  test-only  ',
          group: ' QA ',
          readOnly: false,
        }),
    ),
  };
  await upload.setInputFiles(valid);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(database).toHaveValue('imported');
  await expect(dialog.getByLabel('ホスト')).toHaveValue('localhost');
  await expect(dialog.getByLabel('パスワード', { exact: true })).toHaveValue('  test-only  ');
  await expect(dialog.getByLabel('グループ名（任意）')).toHaveValue('QA');
  await expect(dialog.getByLabel('読み取り専用', { exact: true })).not.toBeChecked();
  await database.fill('edited');
  await upload.setInputFiles(valid);
  await expect(database).toHaveValue('imported');
  await dialog.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.status-bar')).toContainText('imported');
  await expect(page.locator('.status-bar')).toContainText('READ / WRITE');
});

test('connection dialog cannot close during a pending connection and recovers after rejection', async ({
  page,
}) => {
  let reject!: (error: Error) => void;
  await page.exposeFunction(
    'pendingConnect',
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await page.addInitScript(() =>
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command === 'load_queries') return Promise.resolve([]);
          if (command === 'load_connections')
            return Promise.resolve({ connections: [], groups: [] });
          if (command === 'connect_database')
            return (window as unknown as { pendingConnect(): Promise<unknown> }).pendingConnect();
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('データベース名').fill('fixture');
  await dialog.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect.poll(() => typeof reject).toBe('function');
  await expect(dialog.getByRole('button', { name: '接続中…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog).toBeVisible();
  reject(new Error('fixture connection unavailable'));
  await expect(dialog.getByRole('alert')).toContainText('fixture connection unavailable');
  await expect(dialog.getByRole('button', { name: '接続してスキーマを読み込む' })).toBeEnabled();
  await expect(dialog.getByLabel('データベース名')).toHaveValue('fixture');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.status-bar')).toContainText('未接続');
});
