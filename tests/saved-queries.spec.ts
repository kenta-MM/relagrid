import { test, expect, type Page } from '@playwright/test';
import type { SavedQuery } from '../src/data/query-store';

async function openQueryStore(page: Page, loadError = false) {
  let saved: SavedQuery[] = [];
  let failSave = false;
  await page.exposeFunction(
    'queryStoreInvoke',
    (command: string, args: { data?: SavedQuery[] }) => {
      switch (command) {
        case 'load_connections':
          return { connections: [], groups: [] };
        case 'load_queries':
          if (loadError) throw new Error('fixture unreadable query file');
          return saved;
        case 'save_queries':
          if (failSave) throw new Error('fixture disk full');
          saved = structuredClone(args.data!);
          return;
        default:
          throw new Error(`Unexpected command: ${command}`);
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
              queryStoreInvoke(command: string, args: unknown): Promise<unknown>;
            }
          ).queryStoreInvoke(command, args),
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SQLクエリ' })).toBeVisible();
  return {
    failSaves: () => {
      failSave = true;
    },
  };
}

test('saved queries survive reload while unsaved edits do not', async ({ page }) => {
  await openQueryStore(page);
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill("SELECT '保存済み😀';");
  await editor.press('Control+s');
  await expect(page.getByRole('status')).toContainText('保存しました');
  await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).not.toContainText('*');
  await editor.press('Control+n');
  await editor.fill('SELECT 22;');
  await editor.press('Control+Shift+s');
  await expect(page.getByRole('tab', { name: 'Query 2', exact: true })).not.toContainText('*');
  await editor.fill('SELECT unsaved;');
  await expect(page.getByRole('tab', { name: 'Query 2', exact: true })).toContainText('*');
  await page.reload();
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await expect(editor).toHaveText("SELECT '保存済み😀';");
  await page.getByRole('tab', { name: 'Query 2', exact: true }).click();
  await expect(editor).toHaveText('SELECT 22;');
  await expect(page.getByRole('button', { name: '実行', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'クエリ実行結果' })).toContainText(
    'SQLを実行すると',
  );
});

test('failed save retains dirty SQL and a cancelled close keeps the editor intact', async ({
  page,
}) => {
  const store = await openQueryStore(page);
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill('SELECT 77;');
  store.failSaves();
  await editor.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('fixture disk full');
  await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toContainText('*');
  await editor.press('Control+w');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveText('SELECT 77;');
  await expect(editor).toBeFocused();
});

test('unreadable saved queries disable saving through both buttons and shortcuts', async ({
  page,
}) => {
  await openQueryStore(page, true);
  await expect(page.getByRole('alert')).toContainText('fixture unreadable query file');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'すべて保存', exact: true })).toBeDisabled();
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill('SELECT 99;');
  await editor.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('fixture unreadable query file');
  await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toContainText('*');
});
