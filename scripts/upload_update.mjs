/**
 * 上传 CnkeIDE 更新包到发布服务器（SFTP）。
 *
 * 凭据从环境变量读取（历史上硬编码密码曾被提交进 git，已作废）：
 *   CNKE_SRV_HOST / CNKE_SRV_USER / CNKE_SRV_PASS
 *
 * 用法：node scripts/upload_update.mjs <version> [local_dir]
 */
import { Client } from 'ssh2';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.CNKE_SRV_HOST;
const USER = process.env.CNKE_SRV_USER;
const PASS = process.env.CNKE_SRV_PASS;
if (!HOST || !USER || !PASS) {
  console.error('缺少环境变量 CNKE_SRV_HOST / CNKE_SRV_USER / CNKE_SRV_PASS');
  process.exit(1);
}

const version = process.argv[2];
if (!version) {
  console.error('用法: node scripts/upload_update.mjs <version> [local_dir]');
  process.exit(1);
}
const localDir = path.resolve(process.argv[3] || 'release');
const REMOTE_DIR = '/www/wwwroot/ai.cnkes.cn/cnkeide/updates/';

const files = [
  `CnkeIDE Setup ${version}.exe`,
  `CnkeIDE Setup ${version}.exe.blockmap`,
  'latest.yml',
  // 更新说明由客户端 UpdateManager.fetchReleaseNotes() 直接拉取
  'releasenotes.txt',
];

for (const f of files) {
  if (!fs.existsSync(path.join(localDir, f))) {
    console.error(`缺少产物: ${path.join(localDir, f)}（先运行打包）`);
    process.exit(1);
  }
}

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP 失败:', err.message); process.exit(1); }

    const upload = (idx) => {
      if (idx >= files.length) {
        // 远端校验：文件就位 + latest.yml 版本正确
        conn.exec(
          `ls -la '${REMOTE_DIR}CnkeIDE Setup ${version}.exe' && head -3 '${REMOTE_DIR}latest.yml'`,
          (e, stream) => {
            if (e) { console.error('校验命令失败:', e.message); process.exit(1); }
            let out = '';
            stream.on('data', (d) => (out += d.toString()));
            stream.stderr.on('data', (d) => (out += d.toString()));
            stream.on('close', () => { console.log('--- 远端校验 ---\n' + out); conn.end(); });
          }
        );
        return;
      }
      const f = files[idx];
      const t0 = Date.now();
      sftp.fastPut(path.join(localDir, f), REMOTE_DIR + f, (e) => {
        if (e) { console.error(`上传失败 ${f}:`, e.message); process.exit(1); }
        console.log(`uploaded ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        upload(idx + 1);
      });
    };
    upload(0);
  });
})
  .on('error', (e) => { console.error('连接失败:', e.message); process.exit(1); })
  .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 25000 });
