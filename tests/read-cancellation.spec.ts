import { test, expect } from '@playwright/test';

test('cancels a pending connection read from the connection dialog', async ({ page }) => {
  await page.addInitScript(() => {
    let rejectRead: ((error: Error) => void) | undefined;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'load_queries') return [];
          if (command === 'load_connections') return { connections: [], groups: [] };
          if (command === 'connect_database')
            return new Promise((_, reject) => {
              rejectRead = reject;
            });
          if (command === 'cancel_database_reads') {
            rejectRead?.(new Error('読み込みを中断しました。'));
            return;
          }
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加' }).click();
  await page.getByLabel('データベース名').fill('fixture');
  await page.getByLabel('ユーザー名').fill('fixture_reader');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('button', { name: '接続中…' })).toBeDisabled();
  await page.getByRole('button', { name: '読み込みを中断', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('読み込みを中断しました');
  await expect(page.getByRole('button', { name: '接続してスキーマを読み込む' })).toBeEnabled();
  await expect(page.getByLabel('データベース名')).toHaveValue('fixture');
});

test('disconnect remains available while schema refresh is pending', async ({ page }) => {
  await page.addInitScript(() => {
    let rejectRead: ((error: Error) => void) | undefined;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'load_queries') return [];
          if (command === 'load_connections') return { connections: [], groups: [] };
          if (command === 'save_connections') return;
          if (command === 'connect_database')
            return { sessionId: 'fixture', tables: [], relationships: [] };
          if (command === 'refresh_schema')
            return new Promise((_, reject) => {
              rejectRead = reject;
            });
          if (command === 'disconnect_database') {
            rejectRead?.(new Error('読み込みを中断しました。'));
            return;
          }
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '接続を追加' }).click();
  await page.getByLabel('データベース名').fill('fixture');
  await page.getByLabel('ユーザー名').fill('fixture_reader');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '切断', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '切断', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('未接続');
  await expect(page.getByRole('button', { name: '読み込みを中断', exact: true })).toHaveCount(0);
});
