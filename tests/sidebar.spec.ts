import { test, expect } from '@playwright/test';

test('Ctrl+B preserves the sidebar tree and expands both workspaces', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('.sidebar');
  const schema = sidebar.locator('.schema-tree details');
  await schema.locator('summary').click();
  const main = page.locator('.main-panel:visible');
  const initialWidth = (await main.boundingBox())!.width;
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeHidden();
  await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeVisible();
  await expect(schema).not.toHaveAttribute('open');
  await expect(sidebar).not.toContainText('データのつながりを、');

  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  await editor.fill('SELECT * FROM Customer;');
  const sqlWidth = (await main.boundingBox())!.width;
  await editor.press('Control+b');
  await expect(sidebar).toBeHidden();
  await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(sqlWidth);
  await expect(editor).toHaveText('SELECT * FROM Customer;');
  await editor.dispatchEvent('keydown', { key: 'b', ctrlKey: true, repeat: true });
  await expect(sidebar).toBeHidden();
  await editor.press('Control+b');
  await expect(sidebar).toBeVisible();
  await editor.dispatchEvent('keydown', { key: 'b', ctrlKey: true, isComposing: true });
  await expect(sidebar).toBeVisible();
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('データベース名').press('Control+b');
  await expect(sidebar).toBeVisible();
});
