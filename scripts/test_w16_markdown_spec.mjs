/**
 * 验证 Markdown 规范提示词 + CodeBlock 兜底逻辑
 */
import fs from 'node:fs/promises';
import path from 'node:path';

let pass = 0, fail = 0;
const log = (ok, n, d='') => { if (ok) { pass++; console.log('  PASS  '+n); } else { fail++; console.log('  FAIL  '+n+' :: '+d); } };

const am = await fs.readFile('electron/core-fork/agent/AgentManager.ts', 'utf-8');
const md = await fs.readFile('renderer/src/components/chat/Markdown.tsx', 'utf-8');

console.log('\n[1] REPLY_FORMAT_STRUCTURED 覆盖 6 类规范');
for (const [k, re] of Object.entries({
  '代码块': /^一、代码块/m, '标题': /^二、标题/m, '列表': /^三、列表/m,
  '表格': /^四、表格/m, '强调': /^五、强调与其它/m, '整体': /^六、整体/m,
})) log(re.test(am), k + ' 章节存在');
log((am.match(/^1?\d\. /gm) || []).length >= 20 || /^21\. /m.test(am), '规范条目 >= 20 条');
log(/围栏必须成对闭合/.test(am), '含"围栏成对闭合"要求');
log(/层级严格递进/.test(am), '含"标题层级递进"要求');
log(/嵌套必须缩进/.test(am), '含"列表嵌套缩进"要求');
log(/分隔行/.test(am), '含"表格分隔行"要求');
log(/不要滥用加粗|一段内不超过/.test(am), '含"加粗节制"要求');
log(/绝不要用.*代码块围栏.*单行|单行内容一律不要用围栏代码块/.test(am), '含"单行不用代码块"要求');

console.log('\n[2] 提示词未引入未提及的技术栈 / 未写实现步骤');
log(!/electron|react|vue|typescript/i.test(am.slice(am.indexOf('REPLY_FORMAT_STRUCTURED'), am.indexOf('const PLAN_GUIDE'))), '规范段未指定技术栈');
log(!/第一步.*安装|npm install/.test(am.slice(am.indexOf('REPLY_FORMAT_STRUCTURED'), am.indexOf('const PLAN_GUIDE'))), '规范段无安装/教程步骤');

console.log('\n[3] CodeBlock 兜底：单行内容降级为行内 code');
// 锚点取 CodeBlock 组件定义起点：注释块可能被改写成多行，不能依赖固定注释文本。
// 从关键字正则常量开始截取，兜底函数依赖它，单独取函数体会 ReferenceError。
const FN_START = md.indexOf('const CODE_LEADING_KEYWORD_RE');
const FN_END = md.indexOf('const CodeBlock');
if (FN_START < 0 || FN_END <= FN_START) throw new Error('Markdown.tsx 测试锚点失效：CODE_LEADING_KEYWORD_RE / CodeBlock 未找到');
const fn = md.slice(FN_START, FN_END);
log(!/if \(!match && looksLikeNonCodeLine/.test(md), '已移除 !match 限制（有语言标注也走兜底）');
log(/if \(looksLikeNonCodeLine\(codeText\)\)/.test(md), '兜底条件不再要求无语言标识');
log(/裸标识符/.test(fn), '新增"裸标识符"识别规则');

console.log('\n[4] 兜底函数行为（运行时）');
const body = fn;
// 去掉 TS 类型标注后再求值（参数与返回值类型）
const src = body
  .slice(0, body.lastIndexOf('}') + 1)
  .replace(/function looksLikeNonCodeLine\(text: string\): boolean/, 'function looksLikeNonCodeLine(text)');
const looksLikeNonCodeLine = new Function(src + '; return looksLikeNonCodeLine;')();
for (const t of ['create_file','apply_diff','rename_file','delete_file','list_directory','project_structure','execute_command','AgentManager.ts','AgentManager.ts:281','C:\\x\\y.ts','./src/a.ts','读取文件'])
  log(looksLikeNonCodeLine(t) === true, '单行非代码 → 降级: ' + t);
// 命令/关键字开头（git/npm/cd/return 等）一律按真代码保留
for (const t of ['git status', 'npm run build', 'return 0', 'const a = 1'])
  log(looksLikeNonCodeLine(t) === false, '命令/关键字开头 → 保留代码块: ' + t);
// 多行代码、含 JSON/语法符号的片段必须保留为代码块；
// 注意 "ls -la" 这类单行命令会被降级为行内 code —— 这是刻意的取舍：
// 单行命令渲染成占满宽度的大灰框比行内 code 更难看，提示词已引导模型
// 单行不放代码块；多行命令块（\n 分隔）仍会正常走代码块渲染。
for (const t of ['const a = 1;\nconsole.log(a);','ls -la\ncd /tmp','{"a":1}','if (x) { y(); }','a\nb',''])
  log(looksLikeNonCodeLine(t) === false, '真代码/多行 → 保留代码块: ' + JSON.stringify(t));
log(looksLikeNonCodeLine('ls -la') === true, '单行短命令 → 降级为行内 code（刻意取舍）');

console.log('\n结果: ' + pass + ' PASS, ' + fail + ' FAIL, 共 ' + (pass+fail));
process.exit(fail > 0 ? 1 : 0);
