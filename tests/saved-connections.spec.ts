import { test, expect } from '@playwright/test';
import type { SavedConnections } from '../src/data/connection-store';

test('saves connections and restores the list on restart without auto-connecting', async ({
  page,
}) => {
  let saved: SavedConnections = { connections: [], groups: [] };
  let connects = 0;
  await page.exposeFunction(
    'savedConnectionInvoke',
    (command: string, args: { data?: SavedConnections }) => {
      if (command === 'load_connections') return saved;
      if (command === 'save_connections') {
        saved = args.data!;
        return;
      }
      if (command === 'connect_database') {
        connects++;
        return { tables: [], relationships: [] };
      }
    },
  );
  await page.addInitScript(() =>
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: unknown = {}) =>
          (
            window as unknown as {
              savedConnectionInvoke(command: string, args: unknown): Promise<unknown>;
            }
          ).savedConnectionInvoke(command, args),
      },
    }),
  );
  await page.goto('/');
  await expect(page.locator('.status-bar')).toContainText('未接続');
  await expect(page.locator('.connection-item')).toHaveCount(0);
  await page.getByRole('button', { name: '接続を追加' }).click();
  await page.getByLabel('データベース名').fill('persisted');
  await page.getByLabel('パスワード', { exact: true }).fill('test-only-secret');
  await page.getByLabel('グループ名（任意）').fill('開発');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(saved.connections).toHaveLength(1);
  await page.reload();
  const connection = page.getByRole('button', { name: 'persisted', exact: true });
  await expect(connection).toBeEnabled();
  await expect(connection).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.connection-group summary')).toContainText('開発');
  expect(connects).toBe(1);
  await connection.click();
  await expect(connection).toHaveAttribute('aria-pressed', 'true');
  expect(connects).toBe(2);
  expect(saved.connections).toHaveLength(1);
  await page.getByRole('button', { name: '切断', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('未接続');
  await expect(connection).toBeVisible();
});
