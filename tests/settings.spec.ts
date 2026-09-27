import { test, expect, type Page } from '@playwright/test';
async function settings(page: Page) {
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.getByRole('button', { name: 'Short cut key', exact: true }).click();
}
test('settings saves separate sidebar keys and supports a shared toggle', async ({ page }) => {
  await page.goto('/');
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
  await page.goto('/');
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
