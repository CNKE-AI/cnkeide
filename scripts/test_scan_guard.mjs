/**
 * 扫描类输出防白屏回归测试（三道闸门）
 * 运行：npx tsx scripts/test_scan_guard.mjs
 */
import { clampLine, splitOutputLines, capTotalChars, MAX_LINE_CHARS, MAX_BATCH_LINES } from '../renderer/src/store/agentActivityStore.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
};
const mk = (s, i) => ({ id: i, text: s });

console.log('1) 单行截断 clampLine');
ok('短行原样', clampLine('abc') === 'abc');
ok('超长行截断并标注', clampLine('x'.repeat(MAX_LINE_CHARS + 500)).includes(`…（截断，原长 ${MAX_LINE_CHARS + 500} 字符）`));
ok('截断后长度有界', clampLine('x'.repeat(999999)).length <= MAX_LINE_CHARS + 40);

console.log('2) \r 重绘语义 splitOutputLines');
const progress = ['10%\r25%\r50%\r100%'].join('\n');
const r1 = splitOutputLines(progress, mk);
ok('进度条只留最终帧', r1.length === 1 && r1[0].text === '100%', JSON.stringify(r1));
const r2 = splitOutputLines('a\r\nb\r\nc', mk);
ok('\\r\\n 正常分行', r2.length === 3 && r2.map((l) => l.text).join(',') === 'a,b,c');
const r3 = splitOutputLines('head\r\n\r\n\r\n', mk);
ok('末尾空行剔除', r3.length === 1 && r3[0].text === 'head');

console.log('3) 批量行数上限');
const big = Array.from({ length: MAX_BATCH_LINES + 3000 }, (_, i) => `line-${i}`).join('\n');
const r4 = splitOutputLines(big, mk);
ok('超量只保留尾部', r4.length === MAX_BATCH_LINES, String(r4.length));
ok('保留的是最后一批', r4[r4.length - 1].text === `line-${MAX_BATCH_LINES + 2999}`);

console.log('4) 总字符预算 capTotalChars');
const huge = Array.from({ length: 2000 }, (_, i) => ({ text: 'y'.repeat(1000), id: i }));
const capped = capTotalChars(huge, 800_000);
ok('超预算后总量受控', capped.reduce((a, l) => a + l.text.length, 0) <= 800_000);
ok('保留尾部行', capped[capped.length - 1].id === 1999);
ok('未超预算原样返回', capTotalChars([{ text: 'a' }]).length === 1);

console.log('5) 空输入与边界');
ok('空串返回空', splitOutputLines('', mk).length === 0);
ok('纯换行返回空', splitOutputLines('\n\n\n', mk).length === 0);
ok('纯\r时行为有界', Array.isArray(splitOutputLines('\r\r\r', mk)));
ok('capTotalChars 单行超预算也保留至少一行', capTotalChars([{ text: 'z'.repeat(2_000_000) }]).length === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail === 0 ? 0 : 1);
