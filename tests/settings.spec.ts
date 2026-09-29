import { openFixture } from './helpers/connection-fixture';
import { test, expect, type Page } from '@playwright/test';
async function settings(page: Page) {
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByRole('button', { name: 'Short cut key', exact: true }).click();
}

test('storage errors retain the settings draft and leave active shortcuts unchanged', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('fixture full', 'QuotaExceededError');
    };
  });
  await openFixture(page);
  await settings(page);
  await page.getByLabel('サイドバーを開く', { exact: true }).press('F8');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('設定を保存できませんでした');
  await expect(page.getByLabel('サイドバーを開く', { exact: true })).toHaveValue('F8');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.keyboard.press('F8');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeHidden();
  await settings(page);
  await expect(page.getByLabel('サイドバーを開く', { exact: true })).toHaveValue('Ctrl/Cmd + B');
});

test('disabled shortcuts remain disabled after reload and defaults can be restored', async ({
  page,
}) => {
  await openFixture(page);
  await settings(page);
  await page.getByRole('button', { name: 'サイドバーを開くを解除', exact: true }).click();
  await page.getByRole('button', { name: 'サイドバーを閉じるを解除', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '接続を追加' })).toBeEnabled();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeVisible();
  await settings(page);
  await expect(page.getByLabel('サイドバーを開く', { exact: true })).toHaveValue('未設定');
  await page.getByRole('button', { name: '初期設定に戻す', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeHidden();
});
test('settings saves separate sidebar keys and supports a shared toggle', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('RelaGrid');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await settings(page);
  await expect(page.getByLabel('サイドバーを開く', { exact: true })).toHaveValue('Ctrl/Cmd + B');
  await page.getByLabel('サイドバーを開く', { exact: true }).press('Control+Shift+o');
  await page.getByLabel('サイドバーを閉じる', { exact: true }).press('Control+Shift+l');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.keyboard.press('Control+Shift+l');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.keyboard.press('Control+Shift+l');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.keyboard.press('Control+Shift+o');
  await page.keyboard.press('Control+Shift+o');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.reload();
  await page.keyboard.press('Control+Shift+l');
  await expect(page.locator('.sidebar')).toBeHidden();
  await settings(page);
  await page.getByLabel('サイドバーを開く', { exact: true }).press('Control+Shift+l');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.keyboard.press('Control+Shift+l');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.keyboard.press('Control+Shift+l');
  await expect(page.locator('.sidebar')).toBeHidden();
});
test('settings prevents collisions, cancels drafts and remaps SQL execution', async ({ page }) => {
  await openFixture(page);
  await settings(page);
  await page.getByLabel('サイドバーを開く', { exact: true }).press('Control+2');
  await expect(page.getByRole('alert')).toContainText('同じキー');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await settings(page);
  await expect(page.getByLabel('サイドバーを開く', { exact: true })).toHaveValue('Ctrl/Cmd + B');
  await page.getByLabel('SQL全文を実行', { exact: true }).press('F6');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await page.getByRole('textbox', { name: 'SQLクエリ' }).press('F6');
  await expect(page.locator('.query-data tbody tr')).toHaveCount(8);
});
