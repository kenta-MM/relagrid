import { expect } from '@playwright/test';

export async function verifyDemoGrouping(page) {
  await page.getByRole('button', { name: 'グループを追加' }).click();
  await page.getByRole('dialog').getByLabel('グループ名', { exact: true }).fill('テスト');
  await page.getByRole('dialog').getByRole('button', { name: '追加', exact: true }).click();
  const connections = page.getByRole('navigation', { name: '接続一覧' });
  const group = connections.locator('.connection-group').filter({ hasText: 'テスト' });
  const sales = connections.getByRole('button', { name: 'SalesDB', exact: true });
  await expect(group.locator('.group-count')).toHaveText('0');
  await sales.dragTo(group.locator('summary'));
  await expect(group.getByRole('button', { name: 'SalesDB', exact: true })).toBeVisible();
  await expect(group.locator('.group-count')).toHaveText('1');
  await expect(sales).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await page.screenshot({ path: 'test-results/demo-grouped.png' });

  const bounds = await sales.boundingBox();
  await page.mouse.move(bounds.x + 30, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 45, bounds.y + bounds.height / 2, { steps: 3 });
  const outside = page.locator('.connection-ungroup-drop');
  await expect(outside).toBeVisible();
  const target = await outside.boundingBox();
  await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 5 });
  await page.mouse.move(target.x + 31, target.y + target.height / 2);
  await page.mouse.up();
  await expect(group.locator('.group-count')).toHaveText('0');
  await expect(connections.locator(':scope > .connection-item')).toHaveText('SalesDB');
  await group.locator('summary').click();
  await sales.dragTo(group.locator('summary'));
  await expect(group.getByRole('button', { name: 'SalesDB', exact: true })).toBeVisible();
  await expect(group.locator('.group-count')).toHaveText('1');
}
