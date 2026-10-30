/**
 * 版本号规范校验：格式为 主版本.次版本.修订号，修订号必须为单个数字 0-9。
 * 用法：node scripts/check_version.mjs [版本号]（缺省读 package.json）
 * 违规时 exit 1，可在发布流程前置调用。
 */
import fs from 'node:fs';

const version = process.argv[2] || JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const RE = /^\d+\.\d+\.\d$/; // 末位必须且只能是单个数字

console.log(`校验版本号: ${version}`);
if (!RE.test(version)) {
  console.error(`✗ 不合规："${version}" 不符合 主版本.次版本.修订号(0-9 单个数字) 规范`);
  console.error('  示例：1.4.0；修订号到 9 后进位（1.3.9 → 1.4.0，而非 1.3.10）');
  process.exit(1);
}
console.log('✓ 合规');
