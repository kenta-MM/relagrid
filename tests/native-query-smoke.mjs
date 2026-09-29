// Opt-in: build with tests/fixtures/tauri.qa.json, launch WebView2 CDP on 9223,
// and start the isolated MySQL fixture on 3307. See docs/qa-coverage.md.
// Uses real Tauri IPC and MySQL. Never run against the regular app profile.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (pages.length !== 1) throw new Error('Expected exactly one QA app page');
  const page = pages[0];
  // Fail closed before typing/saving if the wrong desktop process was launched.
  const identifier = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'),
  );
  expect(identifier).toBe('com.relagrid.qa');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.getByRole('button', { name: 'リレーション', exact: true }).click();
  await page.getByRole('button', { name: '接続を追加', exact: true }).click();
  await page.getByLabel('ポート').fill('3307');
  await page.getByLabel('データベース名').fill('relagrid_fixture');
  await page.getByRole('button', { name: '接続してスキーマを読み込む' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15000 });
  await expect(
    page.getByRole('navigation', { name: 'テーブル一覧' }).getByRole('button'),
  ).toHaveCount(2);
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await page.getByRole('button', { name: '新規クエリ', exact: true }).click();
  const tabName = await page
    .getByRole('tablist', { name: 'クエリ', exact: true })
    .getByRole('tab', { selected: true })
    .getAttribute('aria-label');
  const editor = page.getByRole('textbox', { name: 'SQLクエリ' });
  const results = page.getByRole('region', { name: 'クエリ実行結果' });
  const savedSql = "SELECT '日本語😀' AS label; SELECT NULL AS empty_value WHERE 0;";
  await editor.fill(savedSql);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(results.getByRole('cell', { name: '日本語😀', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '結果 2', exact: true }).click();
  await expect(
    results.getByRole('columnheader', { name: 'empty_value', exact: true }),
  ).toBeVisible();
  await expect(results).toContainText('結果は0件です');

  await editor.fill('UPDATE Customer SET name=name WHERE customer_id=1');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('読み取り専用');
  await editor.fill('SELECT SLEEP(4) AS slow;');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `${tabName}を閉じる`, exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('中断しました');
  await expect(page.getByRole('button', { name: `${tabName}を閉じる`, exact: true })).toBeEnabled();
  await editor.fill(savedSql);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(results.getByRole('cell', { name: '日本語😀', exact: true })).toBeVisible();
  await editor.press('Control+s');
  await expect(page.getByRole('status')).toContainText('保存しました');
  await expect(page.getByRole('tab', { name: tabName, exact: true })).not.toContainText('*');
  await editor.fill('SELECT unsaved_change;');
  await page.reload();
  await expect(page.locator('.status-bar')).toContainText('未接続');
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await page.getByRole('tab', { name: tabName, exact: true }).click();
  await expect(editor).toHaveText(savedSql);
  await expect(page.getByRole('button', { name: '実行', exact: true })).toBeDisabled();
  await expect(results).toContainText('SQLを実行すると');
  await page
    .getByRole('navigation', { name: '接続一覧' })
    .getByRole('button', { name: 'relagrid_fixture', exact: true })
    .last()
    .click();
  await page.getByRole('tab', { name: tabName, exact: true }).click();
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect(results.getByRole('cell', { name: '日本語😀', exact: true })).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/native-query.png', fullPage: true });
  await page.getByRole('button', { name: '切断', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('未接続');
  expect(errors).toEqual([]);
  console.log(
    'PASS: native SQL batches, empty columns, read-only rejection, cancellation/retry, saved-query reload and reconnect.',
  );
} finally {
  await browser.close();
}
