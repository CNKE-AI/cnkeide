import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const root = process.cwd();
const output = path.join(root, '.cnke', 'theme-review');
mkdirSync(output, { recursive: true });
const env = { ...process.env, CNKE_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`), VITE_DEV_SERVER_URL: 'http://127.0.0.1:4173' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(root, 'renderer', 'dist-electron', 'main.js')], env, timeout: 45000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('[title="设置"]').waitFor({ timeout: 30000 });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  await page.locator('[title="打开文件夹 (Ctrl+O)"]').click();
  await page.locator(`[title=${JSON.stringify(path.join(root, 'package.json'))}]`).first().click();
  await page.locator('.cm-editor').waitFor();
  const original = await page.locator('.cm-content').innerText();
  await page.locator('[title="设置"]').click();
  await page.getByRole('button', { name: '外观主题', exact: true }).click();
  for (const [name, id] of [['清透浅色', 'light'], ['极光青', 'aurora'], ['经典深色', 'dark'], ['极光青', 'aurora']]) {
    const button = page.getByRole('button', { name: new RegExp(name) });
    await button.click();
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, id);
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('cnke.theme')), id);
    assert.equal(await page.locator('.cm-content').innerText(), original);
  }
  await page.screenshot({ path: path.join(output, 'aurora-settings.png') });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  const editorBackground = await page.locator('.cm-editor').evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(editorBackground, 'rgb(14, 25, 35)');
  await page.screenshot({ path: path.join(output, 'aurora-workspace.png') });
  for (const id of ['dark', 'light', 'aurora']) {
    await page.locator('[aria-label^="切换主题："]').click();
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, id);
  }
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'aurora');
  await page.locator('[title="设置"]').click();
  await page.getByRole('button', { name: '外观主题', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /极光青/ }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log('PASS: theme cards, titlebar cycle, persisted reload, editor background, document preservation, no page errors');
  console.log(`Screenshots: ${output}`);
} finally {
  await app.close();
}
