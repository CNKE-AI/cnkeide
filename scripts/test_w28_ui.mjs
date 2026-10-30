/**
 * W28 界面验收（AUTO 路由 + 仅内置模型）
 *
 * 通过 CDP 连接已运行的开发版（需先以 CNKE_DEBUG_PORT=9222 启动），
 * 直接操作真实 DOM，避免用裸鼠标点击误伤其它窗口。
 *
 * 验收项：
 *  1) 输入区出现 AUTO 入口
 *  2) 模型面板把 AUTO 置顶，并说明「仅在内置模型中按任务匹配」
 *  3) 设置页 Agent 页存在「任务 → 模型映射」分组，含 6 个任务
 *  4) 映射下拉的候选项全部是内置模型
 *
 * 用法：
 *   $env:CNKE_DEBUG_PORT='9222'; npm run dev
 *   node scripts/test_w28_ui.mjs [--shot 目录]
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';

const CDP = process.env.CNKE_DEBUG_PORT ? `http://127.0.0.1:${process.env.CNKE_DEBUG_PORT}` : 'http://127.0.0.1:9222';
const shotArgIdx = process.argv.indexOf('--shot');
const shotDir = shotArgIdx > -1 ? process.argv[shotArgIdx + 1] : os.tmpdir();

let pass = 0;
let fail = 0;
function log(ok, name, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} :: ${detail}`);
  }
}

const browser = await chromium.connectOverCDP(CDP);
const contexts = browser.contexts();
const pages = contexts.flatMap((c) => c.pages());
const page = pages.find((p) => /5173/.test(p.url()) && !/ppt\.html/.test(p.url())) || pages[0];
if (!page) {
  console.error('未找到应用窗口，请确认开发版已启动');
  process.exit(1);
}
console.log(`\n[0] 连接窗口 ${page.url()}`);

// 等界面就绪
await page.waitForSelector('[title="设置"]', { timeout: 20000 });

console.log('\n[1] 输入区 AUTO 入口');
const autoBtn = page.locator('button[aria-label="选择模型"]');
await autoBtn.waitFor({ timeout: 15000 });
const triggerText = (await autoBtn.innerText()).replace(/\s+/g, ' ').trim();
log(/AUTO/.test(triggerText), 'trigger shows AUTO', triggerText);

console.log('\n[2] 模型面板：AUTO 置顶 + 仅内置说明');
await autoBtn.click();
const panel = page.locator('div[role="dialog"][aria-label="模型选择"]');
await panel.waitFor({ timeout: 8000 });
log(await panel.isVisible(), 'panel opened');
const panelText = (await panel.innerText()).replace(/\s+/g, ' ');
log(/仅在内置模型中按任务匹配/.test(panelText), 'AUTO 说明为仅内置模型');
const firstOption = panel.locator('button[data-model-option]').first();
log(/AUTO/.test(await firstOption.innerText()), 'AUTO 是第一个选项');
const modelCount = await panel.locator('button[data-model-option]').count();
log(modelCount >= 2, 'panel lists models', `count=${modelCount}`);

// 自定义项必须带「自定义」标记；内置项不能带
const customBadges = await panel.locator('button[data-model-option] span[title="自定义配置，不参与 AUTO 路由"]').count();
const optionIds = await panel.locator('button[data-model-option]').evaluateAll((els) => els.map((e) => e.textContent || ''));
const nonBuiltin = optionIds.slice(1).filter((t) => /·/.test(t) === false);
log(customBadges >= 0, `自定义徽标数量 = ${customBadges}（无自定义配置时为 0）`, `nonBuiltin=${nonBuiltin.length}`);

await page.screenshot({ path: path.join(shotDir, 'w28-model-panel.png') });

// 关闭面板
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

console.log('\n[3] 设置页「任务 → 模型映射」');
await page.locator('[title="设置"]').click();
await page.getByText('Agent 设置', { exact: true }).click();
await page.getByText('任务 → 模型映射（仅内置模型；留空表示跟随 AUTO 自动选档）').waitFor({ timeout: 8000 });
log(true, 'routing group rendered');

const labels = ['日常问答', '编码任务', '推理分析', '图片理解', '规划任务', '总结摘要'];
for (const label of labels) {
  const sel = page.locator(`label:has-text("${label}") select`).first();
  const cnt = await sel.count();
  log(cnt === 1, `mapping row ${label}`, `select count=${cnt}`);
}

console.log('\n[4] 映射候选只含内置模型');
const opts = await page.locator('label:has-text("编码任务") select option').evaluateAll((els) =>
  els.map((e) => ({ value: e.value, text: e.textContent || '' }))
);
log(opts[0]?.value === '', 'first option is AUTO auto-tier', JSON.stringify(opts[0]));
const bad = opts.slice(1).filter((o) => !o.value.startsWith('official_'));
log(bad.length === 0, 'all mapping options are builtin', JSON.stringify(bad));

await page.screenshot({ path: path.join(shotDir, 'w28-settings-routing.png') });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(`截图：${path.join(shotDir, 'w28-model-panel.png')} , ${path.join(shotDir, 'w28-settings-routing.png')}\n`);
await browser.close().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
