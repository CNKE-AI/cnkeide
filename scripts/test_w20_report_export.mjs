/**
 * W20 统计导出测试
 * 验证：CSV 转义/公式注入防护/BOM、Markdown 报告结构、空数据处理、文件名
 *
 * 用法：npx tsx scripts/test_w20_report_export.mjs
 */
import {
  buildCsvReport, buildMarkdownReport, csvCell, formatTime, MD_MAX_ROWS, suggestFileName, UTF8_BOM,
} from '../electron/core-fork/analytics/ReportExport.js';
import { buildDashboard } from '../electron/core-fork/analytics/StatsModel.js';
import { filterSessions, sessionRows, sortRows } from '../electron/core-fork/analytics/HistoryStats.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}
const eq = (name, actual, expected) => log(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
const ok = (name, cond, detail = '') => log(!!cond, name, detail);

// ===== 1. 单元格转义 =====
console.log('\n[1] csvCell');
eq('普通文本原样', csvCell('统计看板'), '统计看板');
eq('空值转空串', csvCell(null), '');
eq('含逗号加引号', csvCell('a,b'), '"a,b"');
eq('含引号双写', csvCell('他说"你好"'), '"他说""你好"""');
eq('含换行加引号', csvCell('第一行\n第二行'), '"第一行\n第二行"');
eq('CRLF 归一为 LF', csvCell('a\r\nb'), '"a\nb"');
eq('负数保持数字（不加引号）', csvCell(-1500), '-1500');
eq('公式 = 前缀加单引号', csvCell('=1+1'), "'=1+1");
eq('公式 + 前缀加单引号', csvCell('+100'), "'+100");
eq('公式 @ 前缀加单引号', csvCell('@SUM(A1)'), "'@SUM(A1)");
eq('公式 - 文本加单引号', csvCell('-cmd|calc'), "'-cmd|calc");
eq('公式注入且含逗号时双层处理', csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);

// ===== 2. 时间格式 =====
console.log('\n[2] formatTime');
eq('无效时间返回空串', formatTime(0), '');
eq('格式化本地时间为 YYYY-MM-DD HH:mm:ss', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatTime(Date.now())), true);

// ===== 3. 构造真实数据 =====
const now = Date.now();
const DAY = 86_400_000;
const mkSession = (id, title, ws, dayOffset, tokens) => ({
  id,
  title,
  workspaceId: ws,
  createdAt: now - dayOffset * DAY,
  updatedAt: now - dayOffset * DAY,
  mode: 'craft',
  messages: [
    { id: `${id}-u`, role: 'user', content: `${title} 的需求说明`, displayContent: '帮我看看这个, 顺便"引用一下"', timestamp: now - dayOffset * DAY },
    {
      id: `${id}-a`,
      role: 'assistant',
      content: '好的，我来处理',
      timestamp: now - dayOffset * DAY + 60000,
      usage: {
        prompt_tokens: tokens,
        completion_tokens: Math.round(tokens / 2),
        total_tokens: Math.round(tokens * 1.5),
        model: 'claude-sonnet-4.5',
        prompt_tokens_details: { cached_tokens: Math.round(tokens * 0.4) },
      },
      toolCalls: [
        { name: 'read_file', result: { success: true } },
        { name: 'run_command', result: { success: false, error: 'exit 1' } },
      ],
    },
  ],
});

const sessions = [
  mkSession('s1', '统计看板导出', 'C:/ws/demo', 1, 1000),
  mkSession('s2', '任务工作区', 'C:/ws/demo', 2, 500),
  mkSession('s3', '未归属会话', '', 3, 300),
];
const rows = sortRows(sessionRows(filterSessions(sessions, { range: 'all' }, now)), 'updatedAt');
const dash = buildDashboard(sessions, { range: 'all' }, now);

// ===== 4. CSV =====
console.log('\n[3] buildCsvReport');
{
  const csv = buildCsvReport(rows, { range: 'all' });
  ok('以 UTF-8 BOM 开头（Excel 中文不乱码）', csv.startsWith(UTF8_BOM), JSON.stringify(csv.slice(0, 3)));
  const lines = csv.replace(UTF8_BOM, '').split('\r\n').filter((l) => l !== '');
  eq('表头 + 3 行数据', lines.length, 4);
  eq('表头列数与字段数一致', lines[0].split(',').length, 17);
  ok('含会话标题', csv.includes('统计看板导出'), '');
  ok('含模型名', csv.includes('claude-sonnet-4.5'), '');
  ok('含逗号的摘要被正确加引号', csv.includes('"帮我看看这个, 顺便""引用一下"""'), csv.split('\r\n')[1]);
  ok('CRLF 行尾', csv.includes('\r\n'), '');
  eq('空明细只有表头', buildCsvReport([]).replace(UTF8_BOM, '').split('\r\n').filter(Boolean).length, 1);
}

// ===== 5. Markdown =====
console.log('\n[4] buildMarkdownReport');
{
  const md = buildMarkdownReport(dash, rows, { range: 'all', workspaceLabel: 'demo', keyword: '' });
  const must = ['# CnkeIDE 使用统计报告', '## 概览', '## 核心指标', '## 用量趋势', '## 模型分布', '## 工具分布', '## 结论与建议', '## 会话明细'];
  for (const h of must) ok(`含章节 ${h}`, md.includes(h), '');
  ok('写明筛选条件', md.includes('范围：全部时间') && md.includes('工作区：demo'), '');
  ok('含模型名', md.includes('claude-sonnet-4.5'), '');
  ok('含会话标题', md.includes('统计看板导出'), '');
  ok('含工具失败信息', md.includes('run_command'), '');
  ok('表格分隔行正确', md.includes('| 指标 | 数值 |') && md.includes('| --- | --- |'), '');
  ok('关键词会出现在抬头', buildMarkdownReport(dash, rows, { keyword: '报表' }).includes('关键词：`报表`'), '');

  // 空数据
  const empty = buildDashboard([], { range: '7d' }, now);
  const mdEmpty = buildMarkdownReport(empty, [], { range: '7d' });
  ok('空数据给提示而不是空报告', mdEmpty.includes('没有历史记录'), mdEmpty);
  ok('空数据不输出明细表', !mdEmpty.includes('## 会话明细'), '');

  // 明细截断
  const many = Array.from({ length: MD_MAX_ROWS + 20 }, (_, i) => ({ ...rows[0], id: `x${i}`, title: `会话${i}` }));
  const mdMany = buildMarkdownReport(dash, many, {});
  ok('超量明细标注仅列前 N 条', mdMany.includes(`共 ${many.length} 条会话`) && mdMany.includes(`仅列出最近 ${MD_MAX_ROWS} 条`), '');
  eq('明细表行数受限', mdMany.split('\n').filter((l) => /\|\s*会话\d+\s*\|/.test(l)).length, MD_MAX_ROWS);

  // 竖线转义：标题里带 | 不能把表格撑坏
  const pipeRows = [{ ...rows[0], title: 'a|b' }];
  const mdPipe = buildMarkdownReport(dash, pipeRows, {});
  ok('标题里的竖线被转义', mdPipe.includes('a\\|b'), '');
}

// ===== 6. 文件名 =====
console.log('\n[5] suggestFileName');
{
  const t = new Date(2026, 9, 28, 15, 30).getTime();
  eq('CSV 文件名', suggestFileName('csv', t), '统计报告-20261028-1530.csv');
  eq('Markdown 文件名', suggestFileName('markdown', t), '统计报告-20261028-1530.md');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
