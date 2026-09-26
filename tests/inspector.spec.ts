import { test, expect } from '@playwright/test';

test('Ctrl+Alt+B toggles the inspector independently and preserves its state', async ({ page }) => {
  await page.goto('/');
  const details = page.locator('.relation-details .details-panel');
  const sidebar = page.locator('.sidebar');
  const main = page.locator('.main-panel:visible');
  await details.getByRole('tab', { name: 'カラム' }).click();
  const initialWidth = (await main.boundingBox())!.width;
  await page.keyboard.press('Control+Alt+b');
  await expect(details).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await expect(page.getByRole('button', { name: 'リレーション', exact: true })).toBeFocused();
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeHidden();
  await page.keyboard.press('Control+Alt+b');
  await expect(details).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(details.getByRole('tab', { name: 'カラム' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  const inspector = page.locator('.query-inspector');
  await editor.fill('SELECT * FROM Customer;');
  const sqlWidth = (await main.boundingBox())!.width;
  await editor.press('Control+Alt+b');
  await expect(inspector).toBeHidden();
  await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(sqlWidth);
  await expect(editor).toHaveText('SELECT * FROM Customer;');
  await editor.dispatchEvent('keydown', { key: 'b', ctrlKey: true, altKey: true, repeat: true });
  await expect(inspector).toBeHidden();
  await editor.press('Control+Alt+b');
  await expect(inspector).toBeVisible();
  await editor.dispatchEvent('keydown', {
    key: 'b',
    ctrlKey: true,
    altKey: true,
    isComposing: true,
  });
  await expect(inspector).toBeVisible();
  await page.getByRole('button', { name: '接続', exact: true }).click();
  await page.getByLabel('データベース名').press('Control+Alt+b');
  await expect(inspector).toBeVisible();
});
