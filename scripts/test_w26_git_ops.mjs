/**
 * W26 Git 写操作闭环测试
 * 覆盖：分支 list/create/delete/rename、checkout（含 create）、fetch、pull(ff-only 与分叉)、
 *       push（受保护分支拦截 / setUpstream / 无远程）、ref 名校验、ToolManager 注册、
 *       并发策略、权限档位分类
 *
 * 全部在临时目录里建真实 git 仓库 + 本地 bare 远程，不联网。
 * 用法：npx tsx scripts/test_w26_git_ops.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  isValidRefName,
  gitBranch,
  gitCheckout,
  gitFetch,
  gitPull,
  gitPush,
  gitCommit,
  gitLog,
  gitCurrentBranch,
  gitRemotes,
  gitStatus,
  isGitRepo,
  PROTECTED_BRANCHES,
} from '../electron/core-fork/tools/GitTools.js';
import { ToolManager } from '../electron/core-fork/tools/ToolManager.js';
import { DEFAULT_TOOL_POLICIES } from '../electron/core-fork/tools/ParallelToolScheduler.js';
import { classifyTool } from '../electron/core-fork/checkpoint/PermissionTier.js';

const execFileAsync = promisify(execFile);
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

/** 测试自己的 git 调用（带 -c 用户信息，不受机器全局配置影响） */
async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'user.email=w26@test.local', '-c', 'user.name=W26 Test', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

async function writeFile(dir, name, content) {
  await fs.writeFile(path.join(dir, name), content, 'utf8');
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w26-git-'));
  const repo = path.join(root, 'repo');
  const bare = path.join(root, 'remote.git');
  const clone2 = path.join(root, 'w2');
  const lonely = path.join(root, 'lonely');

  try {
    // ---------- 准备：仓库 + 首次提交 + bare 远程 ----------
    await fs.mkdir(repo);
    await runGit(repo, ['init', '-q']);
    await runGit(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await writeFile(repo, 'a.txt', 'hello\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'init']);

    await fs.mkdir(bare);
    await runGit(bare, ['init', '-q', '--bare']);

    console.log('\n[1] ref 名校验（防命令行注入）');
    {
      log(isValidRefName('main') === true, 'main 合法');
      log(isValidRefName('feat/a-1.0') === true, 'feat/a-1.0 合法');
      log(isValidRefName('-x') === false, '以 - 开头非法（可避免被当作选项）');
      log(isValidRefName('a b') === false, '含空格非法');
      log(isValidRefName('a..b') === false, '含 .. 非法');
      log(isValidRefName('a~1') === false, '含 ~ 非法');
      log(isValidRefName('a.lock') === false, '.lock 结尾非法');
      log(isValidRefName('') === false, '空串非法');
      log(PROTECTED_BRANCHES.includes('main') && PROTECTED_BRANCHES.includes('master'), '受保护分支含 main/master');
    }

    console.log('\n[2] 分支列表 / 创建 / 切换');
    {
      const list0 = await gitBranch(repo);
      log(list0.success === true, 'list 成功');
      log(list0.local?.some((b) => b.name === 'main' && b.current), 'main 存在且为当前分支', JSON.stringify(list0.local));
      log(list0.current === 'main', 'current=main');

      const created = await gitBranch(repo, { action: 'create', name: 'feat/a' });
      log(created.success === true, '创建 feat/a 成功', created.error);
      log((await gitCurrentBranch(repo)) === 'main', 'create 不切换分支');

      const dup = await gitBranch(repo, { action: 'create', name: 'feat/a' });
      log(dup.success === false && /已存在/.test(dup.error || ''), '重复创建被拒', dup.error);

      const bad = await gitBranch(repo, { action: 'create', name: '-evil' });
      log(bad.success === false && /非法/.test(bad.error || ''), '非法分支名被拒', bad.error);

      const created2 = await gitBranch(repo, { action: 'create', name: 'feat/b', checkout: true });
      log(created2.success === true, 'create+checkout 成功', created2.error);
      log((await gitCurrentBranch(repo)) === 'feat/b', 'create+checkout 后当前分支为 feat/b');

      const co = await gitCheckout(repo, 'feat/a');
      log(co.success === true && co.branch === 'feat/a', 'checkout 切到 feat/a', co.error);

      const coBad = await gitCheckout(repo, '--upload-pack=evil');
      log(coBad.success === false, 'checkout 拒绝以 - 开头的目标', coBad.error);

      const coMissing = await gitCheckout(repo, 'no-such-branch');
      log(coMissing.success === false, 'checkout 不存在的分支失败并有 stderr', coMissing.error?.slice(0, 40));
    }

    console.log('\n[3] fetch / push（受保护分支拦截、setUpstream、无远程）');
    {
      await runGit(repo, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
      const remotes = await gitRemotes(repo);
      log(remotes.includes('origin'), 'remote 列表含 origin', remotes.join(','));

      const fetch1 = await gitFetch(repo);
      log(fetch1.success === true, 'fetch 成功', fetch1.error);

      await gitCheckout(repo, 'main');
      const pushMain = await gitPush(repo);
      log(pushMain.success === false && /受保护分支/.test(pushMain.error || ''), '直推 main 被拒', pushMain.error);
      log(/allowProtected/.test(pushMain.error || ''), '拒绝提示里给出 allowProtected 出口');

      const pushMainOk = await gitPush(repo, { allowProtected: true, setUpstream: true });
      log(pushMainOk.success === true, '显式 allowProtected 后可推 main', pushMainOk.error);
      const bareMain = await runGit(bare, ['rev-parse', '--verify', 'refs/heads/main']).catch(() => '');
      log(!!bareMain, '远程 main 已创建');

      const feature = await gitBranch(repo, { action: 'create', name: 'feat/push', checkout: true });
      log(feature.success === true, '创建 feat/push', feature.error);
      await writeFile(repo, 'b.txt', 'feature\n');
      const commit = await gitCommit(repo, 'feat: add b.txt', { addAll: true });
      log(commit.success === true, '在 feat/push 上提交', commit.error);

      const pushFeature = await gitPush(repo, { setUpstream: true });
      log(pushFeature.success === true, '推新分支（setUpstream）成功', pushFeature.error);
      log(pushFeature.branch === 'feat/push', '返回推送分支名');
      const bareFeature = await runGit(bare, ['rev-parse', '--verify', 'refs/heads/feat/push']).catch(() => '');
      log(!!bareFeature, '远程 feat/push 已创建');

      const pushAgain = await gitPush(repo);
      log(pushAgain.success === true, '再次推送（无新提交）也返回成功', pushAgain.error);
    }

    console.log('\n[4] 无远程仓库的 push/fetch 报错');
    {
      await fs.mkdir(lonely);
      await runGit(lonely, ['init', '-q']);
      await writeFile(lonely, 'x.txt', '1\n');
      await runGit(lonely, ['add', '-A']);
      await runGit(lonely, ['commit', '-q', '-m', 'lonely']);
      const p = await gitPush(lonely);
      log(p.success === false && /没有配置任何远程/.test(p.error || ''), '无远程 push 明确报错', p.error);
      const f = await gitFetch(lonely);
      log(f.success === false && /没有配置任何远程/.test(f.error || ''), '无远程 fetch 明确报错', f.error);
    }

    console.log('\n[5] pull：快进成功 / 分叉拒绝');
    {
      await runGit(root, ['clone', '-q', bare.replace(/\\/g, '/'), clone2]);
      await runGit(clone2, ['config', 'user.email', 'w26b@test.local']);
      await runGit(clone2, ['config', 'user.name', 'W26 B']);
      await gitCheckout(clone2, 'main');
      await writeFile(clone2, 'c.txt', 'from clone\n');
      await runGit(clone2, ['add', '-A']);
      await runGit(clone2, ['commit', '-q', '-m', 'clone commit']);
      const pushFromClone = await gitPush(clone2, { allowProtected: true });
      log(pushFromClone.success === true, '第二副本推 main', pushFromClone.error);

      await gitCheckout(repo, 'main');
      const pull1 = await gitPull(repo);
      log(pull1.success === true, '快进 pull 成功', pull1.error);
      const log1 = await gitLog(repo, { limit: 1 });
      log(/clone commit/.test(log1.entries?.[0]?.subject || ''), 'pull 后拿到新提交', JSON.stringify(log1.entries?.[0]));

      // 制造分叉：本地提交 + 远端提交（不 push 本地那个）
      await writeFile(repo, 'local.txt', 'local\n');
      await runGit(repo, ['add', '-A']);
      await runGit(repo, ['commit', '-q', '-m', 'local diverge']);

      await writeFile(clone2, 'remote.txt', 'remote\n');
      await runGit(clone2, ['add', '-A']);
      await runGit(clone2, ['commit', '-q', '-m', 'remote diverge']);
      await gitPush(clone2, { allowProtected: true });

      const pull2 = await gitPull(repo);
      log(pull2.success === false, '分叉时 pull 失败（不自动造 merge commit）', pull2.error);
      log(/分叉|rebase|merge/i.test(pull2.error || ''), '失败信息给出下一步提示', pull2.error);

      // 复原，避免影响后续用例
      await runGit(repo, ['fetch', '-q', 'origin']);
      await runGit(repo, ['reset', '-q', '--hard', 'origin/main']);
    }

    console.log('\n[6] 删除 / 重命名分支');
    {
      const delCurrent = await gitBranch(repo, { action: 'delete', name: 'main' });
      log(delCurrent.success === false && /当前所在分支/.test(delCurrent.error || ''), '不能删当前分支', delCurrent.error);

      const merged = await gitBranch(repo, { action: 'create', name: 'tmp-merged' });
      log(merged.success === true, '建临时分支', merged.error);
      const delMerged = await gitBranch(repo, { action: 'delete', name: 'tmp-merged' });
      log(delMerged.success === true, '删除已合并分支（-d）成功', delMerged.error);

      await gitCheckout(repo, 'feat/unmerged', { create: true });
      await writeFile(repo, 'u.txt', 'unmerged\n');
      await gitCommit(repo, 'unmerged work', { addAll: true });
      await gitCheckout(repo, 'main');
      const delUnmerged = await gitBranch(repo, { action: 'delete', name: 'feat/unmerged' });
      log(delUnmerged.success === false, '未合并分支 -d 被 git 拒绝', delUnmerged.error);
      const delForce = await gitBranch(repo, { action: 'delete', name: 'feat/unmerged', force: true });
      log(delForce.success === true, 'force 删除成功', delForce.error);

      await gitBranch(repo, { action: 'create', name: 'old-name' });
      const renamed = await gitBranch(repo, { action: 'rename', name: 'old-name', to: 'new-name' });
      log(renamed.success === true, '重命名成功', renamed.error);
      const listAfter = await gitBranch(repo);
      const names = (listAfter.local || []).map((b) => b.name);
      log(names.includes('new-name') && !names.includes('old-name'), '列表反映重命名结果', names.join(','));
    }

    console.log('\n[7] 非 git 仓库的兜底');
    {
      const notRepo = path.join(root, 'not-repo');
      await fs.mkdir(notRepo);
      log((await isGitRepo(notRepo)) === false, 'isGitRepo 对普通目录返回 false');
      const r = await gitBranch(notRepo);
      log(r.success === false && /不是 git 仓库/.test(r.error || ''), '非仓库里运行分支操作给出明确错误', r.error);
      const st = await gitStatus(notRepo);
      log(st.success === false, 'git_status 同样拒绝');
    }

    console.log('\n[8] ToolManager 注册 / 并发策略 / 权限档位分类');
    {
      const tm = Object.create(ToolManager.prototype);
      tm.fsAdapter = null;
      tm.terminalAdapter = null;
      tm.mcpHub = null;
      tm.checkpointManager = null;
      tm.codebaseIndexer = null;
      tm.sessionId = null;
      tm.workspaceId = null;
      tm.modifiedFiles = new Set();
      const tools = await tm.getAvailableTools('coder');
      const names = new Set(tools.map((t) => t.name));
      for (const n of ['git_branch', 'git_checkout', 'git_fetch', 'git_pull', 'git_push']) {
        log(names.has(n), `已注册: ${n}`);
      }
      for (const n of ['git_branch', 'git_checkout', 'git_fetch', 'git_pull', 'git_push']) {
        log(DEFAULT_TOOL_POLICIES[n] === 'global-serial', `${n} 全局串行`);
      }
      for (const n of ['git_branch', 'git_checkout', 'git_fetch', 'git_pull', 'git_push']) {
        log(classifyTool(n) === 'exec', `${n} 归类为 exec（只读档会被拦）`);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
