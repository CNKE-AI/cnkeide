/**
 * W25 权限档位单测：分类 / 三档裁决 / 命令白名单 / 域名白名单 / 与信任规则的优先级
 * 运行：npx tsx scripts/test_w25_permission.mjs
 */
import {
  classifyTool,
  evaluatePermission,
  normalizeMode,
  matchCommand,
  matchDomain,
  parseUrl,
  PERMISSION_MODE_INFO,
} from '../electron/core-fork/checkpoint/PermissionTier';

let pass = 0;
let fail = 0;
const log = (ok, name, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const decide = (name, args = {}, opts = {}) => evaluatePermission({ name, arguments: args }, opts);

console.log('\n[1] 工具副作用分类');
{
  log(classifyTool('read_file') === 'read', 'read_file → read');
  log(classifyTool('git_status') === 'read', 'git_status → read');
  log(classifyTool('get_plan') === 'read', 'get_plan → read（计划工具无外部副作用）');
  log(classifyTool('web_fetch') === 'network', 'web_fetch → network');
  log(classifyTool('browser_navigate') === 'browser', 'browser_navigate → browser');
  log(classifyTool('write_to_file') === 'write', 'write_to_file → write');
  log(classifyTool('apply_diff') === 'write', 'apply_diff → write');
  log(classifyTool('delete_file') === 'destructive', 'delete_file → destructive');
  log(classifyTool('rename_file') === 'destructive', 'rename_file → destructive');
  log(classifyTool('execute_command') === 'exec', 'execute_command → exec');
  log(classifyTool('git_commit') === 'exec', 'git_commit → exec');
  log(classifyTool('browser_click') === 'exec', 'browser_click → exec');
  log(classifyTool('mcp__github__create_issue') === 'external', 'mcp__xxx → external');
  log(classifyTool('some_new_tool') === 'unknown', '未知工具 → unknown');
  log(classifyTool('') === 'unknown', '空名 → unknown');
  log(classifyTool('READ_FILE') === 'read', '大小写不敏感');
}

console.log('\n[2] 档位名归一化');
{
  log(normalizeMode('read-only') === 'read-only', 'read-only');
  log(normalizeMode('readonly') === 'read-only', 'readonly 别名');
  log(normalizeMode('full') === 'full-access', 'full 别名');
  log(normalizeMode(undefined) === 'standard', '未配置 → standard');
  log(normalizeMode('乱写') === 'standard', '非法值回落 standard');
  log(!!PERMISSION_MODE_INFO['read-only'].label && !!PERMISSION_MODE_INFO.standard.summary, '三档都有文案');
}

console.log('\n[3] 只读档：只能看');
{
  log(decide('read_file', {}, { mode: 'read-only' }).action === 'allow', 'read_file 放行');
  log(decide('grep', {}, { mode: 'read-only' }).action === 'allow', 'grep 放行');
  log(decide('web_fetch', { url: 'https://example.com' }, { mode: 'read-only' }).action === 'allow', 'web_fetch 放行');

  const w = decide('write_to_file', { path: 'a.txt' }, { mode: 'read-only' });
  log(w.action === 'deny', 'write_to_file 被拦');
  log(String(w.message).includes('只读'), '拦截提示含「只读」', w.message);
  log(w.matchedBy === 'mode', 'matchedBy=mode');
  log(decide('delete_file', { path: 'a.txt' }, { mode: 'read-only' }).action === 'deny', 'delete_file 被拦');
  log(decide('execute_command', { command: 'rm -rf /' }, { mode: 'read-only' }).action === 'deny', 'execute_command 被拦');
  log(decide('mcp__x__y', {}, { mode: 'read-only' }).action === 'deny', 'MCP 工具被拦');
  log(decide('whatever_new', {}, { mode: 'read-only' }).action === 'deny', '未分类工具被拦（宁严不松）');
  log(decide('browser_navigate', { url: 'https://a.com' }, { mode: 'read-only' }).action === 'allow', '浏览器只读动作放行');
  log(decide('browser_click', {}, { mode: 'read-only' }).action === 'deny', '浏览器点击被拦');
}

console.log('\n[4] 标准档（默认）：改文件放行，危险操作询问');
{
  log(decide('read_file').action === 'allow', 'read_file 放行');
  log(decide('write_to_file', { path: 'a.txt' }).action === 'allow', 'write_to_file 放行（可快照回滚）');
  log(decide('apply_diff').action === 'allow', 'apply_diff 放行');
  log(decide('web_fetch', { url: 'https://x.com' }).action === 'allow', 'web_fetch 放行');
  log(decide('delete_file', { path: 'a.txt' }).action === 'ask', 'delete_file 询问');
  log(decide('rename_file').action === 'ask', 'rename_file 询问');
  log(decide('execute_command', { command: 'npm i' }).action === 'ask', 'execute_command 询问');
  log(decide('git_commit').action === 'ask', 'git_commit 询问');
  log(decide('mcp__a__b').action === 'ask', 'MCP 询问');
  log(decide('browser_navigate', { url: 'https://a.com' }).action === 'ask', 'browser_navigate 询问');
  log(decide('weird_tool').action === 'ask', '未知工具询问');
}

console.log('\n[5] 完全访问档');
{
  log(decide('write_to_file', {}, { mode: 'full-access' }).action === 'allow', '写文件放行');
  log(decide('execute_command', { command: 'rm -rf /' }, { mode: 'full-access' }).action === 'allow', '命令放行');
  log(decide('mcp__a__b', {}, { mode: 'full-access' }).action === 'allow', 'MCP 放行');
  const d = decide('execute_command', { command: 'ls' }, { mode: 'full-access', userAction: 'deny', userReason: '规则：禁止执行' });
  log(d.action === 'deny', '用户 deny 规则仍生效');
  log(d.matchedBy === 'user-rule', 'matchedBy=user-rule');
}

console.log('\n[6] 与用户信任规则的优先级');
{
  const allowRule = { userAction: 'allow', userReason: '规则：允许删除临时文件' };
  log(decide('delete_file', { path: 'tmp/x' }, { mode: 'standard', ...allowRule }).action === 'allow', '规则 allow 把「询问」升级为放行');
  log(
    decide('write_to_file', {}, { mode: 'read-only', ...allowRule }).action === 'deny',
    '只读档不能被规则 allow 绕过'
  );
  log(
    decide('read_file', {}, { mode: 'standard', userAction: 'deny', userReason: '规则：不许读 .env' }).action === 'deny',
    '规则 deny 拦掉只读工具'
  );
  const untouched = decide('read_file', {}, { mode: 'standard' });
  log(untouched.matchedBy === 'default', '无规则命中时 matchedBy=default');
}

console.log('\n[7] 关闭 zeroApprovalMode 后降级为询问');
{
  log(decide('read_file', {}, { mode: 'standard', zeroApprovalMode: false }).action === 'ask', 'read_file 变询问');
  log(decide('write_to_file', {}, { mode: 'standard', zeroApprovalMode: false }).action === 'ask', 'write 变询问');
  log(decide('read_file', {}, { mode: 'full-access', zeroApprovalMode: false }).action === 'allow', '完全访问不受影响');
  log(decide('write_to_file', {}, { mode: 'read-only', zeroApprovalMode: false }).action === 'deny', '只读档仍拦截');
}

console.log('\n[8] 命令白名单');
{
  const opts = { mode: 'read-only', commandAllowlist: ['git status', 'npm test', 'git *'] };
  log(decide('execute_command', { command: 'git status' }, opts).action === 'allow', '只读档 + 白名单：git status 放行');
  log(
    decide('execute_command', { command: 'git status' }, opts).matchedBy === 'command-allowlist',
    'matchedBy=command-allowlist'
  );
  log(decide('execute_command', { command: 'rm -rf /' }, opts).action === 'deny', '不在白名单的命令仍被拦');
  log(decide('execute_command', { command: 'npm test --coverage' }, opts).action === 'allow', '前缀匹配带参数命令');
  log(decide('execute_command', { command: 'git commit -m x' }, opts).action === 'allow', '通配 git * 命中');
  log(decide('execute_command', { command: 'gitk' }, opts).action === 'deny', 'gitk 不被 git * 误命中');
  log(matchCommand('npm test', 'npm test --coverage') === true, 'matchCommand 前缀');
  log(matchCommand('npm test', 'npm testing') === false, 'matchCommand 不误配 npm testing');
  log(matchCommand('npm test', 'npm test && npm run build') === true, 'matchCommand 串联命令');
  log(matchCommand('npm *', 'npm run build') === true, 'matchCommand 通配');
  log(matchCommand('ls ?', 'ls a') === true, 'matchCommand 单字符通配');
  log(matchCommand('', 'ls') === false, '空模式不匹配');
}

console.log('\n[9] 域名白名单');
{
  const opts = { mode: 'standard', domainAllowlist: ['github.com', 'api.example.com/v1', '*.trusted.dev'] };
  log(decide('web_fetch', { url: 'https://github.com/a/b' }, opts).action === 'allow', '白名单内域名放行');
  log(decide('web_fetch', { url: 'https://api.github.com/repos' }, opts).action === 'allow', '子域放行');

  const blocked = decide('web_fetch', { url: 'https://evil.com/x' }, opts);
  log(blocked.action === 'deny', '白名单外域名被拦');
  log(blocked.matchedBy === 'domain-allowlist', 'matchedBy=domain-allowlist');
  log(String(blocked.message).includes('evil.com'), '提示里带具体域名', blocked.message);

  log(decide('web_fetch', { url: 'https://api.example.com/v2/x' }, opts).action === 'deny', '路径前缀不匹配被拦');
  log(decide('web_fetch', { url: 'https://api.example.com/v1/x' }, opts).action === 'allow', '路径前缀匹配放行');
  // browser_navigate 在标准档位本身是「询问」，这里只断言没被白名单拦掉
  log(decide('browser_navigate', { url: 'https://a.trusted.dev' }, opts).action !== 'deny', '*.trusted.dev 子域不被拦');
  log(decide('browser_navigate', { url: 'https://trusted.dev' }, opts).action !== 'deny', '*.trusted.dev 同时覆盖裸域');

  log(decide('web_fetch', { url: 'https://any.com' }, { mode: 'standard' }).action === 'allow', '白名单为空时不限制');
  log(decide('web_fetch', { url: 'https://evil.com' }, { mode: 'read-only', domainAllowlist: ['ok.com'] }).action === 'deny', '只读档同样受域名白名单约束');
  log(decide('read_file', { path: 'a.txt' }, opts).action === 'allow', '非联网工具不受域名白名单影响');

  log(matchDomain('github.com', 'https://github.com/x') === true, 'matchDomain 精确');
  log(matchDomain('github.com', 'https://github.com.evil.com/x') === false, 'matchDomain 不误配后缀欺骗');
  log(matchDomain('*.dev', 'https://a.dev') === true, 'matchDomain 通配子域');
  log(matchDomain('dev', 'https://a.dev') === true, 'matchDomain 裸域名匹配子域');
  log(parseUrl('https://A.COM/x')?.host === 'a.com', 'parseUrl 归一化小写');
  log(parseUrl('not-a-url') === null, 'parseUrl 非法返回 null');
}

console.log('\n[10] 工具名未注册也能安全兜底');
{
  log(decide('delete_everything', {}, { mode: 'read-only' }).action === 'deny', '只读档拦未知工具');
  log(decide('delete_everything', {}, { mode: 'standard' }).action === 'ask', '标准档询问未知工具');
  log(decide('delete_everything', {}, { mode: 'full-access' }).action === 'allow', '完全访问放行未知工具');
}

console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail === 0 ? 0 : 1);
