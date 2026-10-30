/**
 * 子进程输出解码。
 *
 * Windows 下 PowerShell / cmd / pip 默认按系统代码页（简体中文为 GBK/936）输出，
 * 直接按 UTF-8 解码会得到满屏乱码。策略：
 *   1. 若字节流是合法 UTF-8（严格校验），直接按 UTF-8 解码；
 *   2. 否则按 GBK（gb18030 超集）解码；
 *   3. 都没有 TextDecoder 时退回宽松 UTF-8。
 *
 * 之所以单独成模块：终端命令与 Python 解释器/pip 两条链路都要用同一套判定，
 * 复制两份必然有一份先腐化（例如只修了终端、pip 仍乱码）。
 */
export function decodeOutput(buf: Buffer): string {
  // 严格 UTF-8 校验：任一非法序列即判定为非 UTF-8
  let i = 0;
  const len = buf.length;
  let validUtf8 = true;
  while (i < len) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 >= len || (buf[i + 1] & 0xc0) !== 0x80) { validUtf8 = false; break; }
      i += 2; continue;
    }
    if (b >= 0xe0 && b <= 0xef) {
      if (i + 2 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) { validUtf8 = false; break; }
      // 排除过长编码 (overlong) 与代理区
      if (b === 0xe0 && buf[i + 1] < 0xa0) { validUtf8 = false; break; }
      if (b === 0xed && buf[i + 1] >= 0xa0) { validUtf8 = false; break; }
      i += 3; continue;
    }
    if (b >= 0xf0 && b <= 0xf4) {
      if (i + 3 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) { validUtf8 = false; break; }
      if (b === 0xf0 && buf[i + 1] < 0x90) { validUtf8 = false; break; }
      if (b === 0xf4 && buf[i + 1] >= 0x90) { validUtf8 = false; break; }
      i += 4; continue;
    }
    // 0x80-0xC1、0xF5-0xFF 均为非法起始字节
    validUtf8 = false;
    break;
  }

  if (validUtf8) return buf.toString('utf-8');

  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}
