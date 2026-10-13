// 清理 release 目录中的历史安装包，只保留非 exe/blockmap 文件（如 releasenotes.txt）
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.cwd(), 'release');
if (!fs.existsSync(dir)) {
  console.log('release 目录不存在，跳过');
  process.exit(0);
}

const keep = new Set(['releasenotes.txt']);
let removed = 0;
for (const name of fs.readdirSync(dir)) {
  if (keep.has(name)) continue;
  if (!/\.(exe|blockmap|yml|yaml)$/i.test(name)) continue;
  fs.rmSync(path.join(dir, name), { force: true });
  console.log('removed:', name);
  removed++;
}
console.log(`共清理 ${removed} 个历史产物`);
