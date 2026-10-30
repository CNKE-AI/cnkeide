/**
 * 生图前缀门禁（唯一判定来源）
 *
 * 生图是**收费**能力，必须严格限定触发面：
 * 只有用户本轮输入以「生成图片」开头，才允许调用任何生图接口。
 *
 * 该模块是纯函数、无依赖，主进程（AgentManager 装配工具表 / ToolManager 执行兜底）
 * 与渲染层提示文案共用同一套规则，避免"两处各判一次、结论不一致"。
 *
 * 判定规则（按顺序）：
 *   1. 归一化：去掉 BOM、零宽字符、首尾空白（含全角空格 \u3000）；
 *   2. 规范化前缀：英文大小写不敏感（Generate Image 等价），
 *      前缀中间允许 0~1 个空白或连接符（生成 图片 / 生成-图片 / 生成_图片）；
 *   3. 前缀后必须紧跟「有效描述内容」：
 *      - 允许紧跟空白、冒号类标点（：: ，, 、 - —）作为分隔，不视为描述；
 *      - 去掉分隔后至少保留 2 个非标点字符，才算有效描述。
 *
 * 任何一步不满足 → 《不触发》。此时不投递生图工具、ToolManager 也拒绝执行，
 * 收费接口调用次数保持为 0。
 */

/** 触发前缀（规范化后比较） */
export const IMAGE_TRIGGER_KEYWORD = '生成图片';

/** 前缀后允许出现的分隔符（不构成描述内容） */
const SEPARATORS = /^[\s\u3000:：,，、;；\-—–_|/\\>＞.。)）\]】"'“”‘’]+/;

/** 有效描述最少含有的字符数（emoji / 汉字 / 字母各计 1） */
const MIN_DESCRIPTION_CHARS = 1;

/**
 * 仅含标点/纯符号/空白视为"没有描述"。
 * 注意：emoji 属于 \p{S}，必须先排除扩展象形符号区，否则「生成图片 🐱」会被误判为空描述。
 */
const EMOJI = /\p{Extended_Pictographic}/u;
const NON_MEANINGFUL_ONLY = /^[\s\u3000\p{P}\p{S}]*$/u;

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * 归一化：清掉不可见字符 + 首尾空白。
 * 保留内部空白与大小写，仅用于后续按规则处理。
 */
function normalize(input: string): string {
  return String(input ?? '')
    .replace(INVISIBLE, '')
    .trim();
}

/**
 * 判断规范化后的文本是否以生图前缀开头，并返回剩余部分。
 * 前缀本身允许中间有一个空白/连接符，且英文大小写不敏感。
 */
function matchPrefix(text: string): { matched: boolean; rest: string } {
  // 前缀字符之间允许任意数量的空白/连接符：用户手打时多空格很常见，不应因此判定失败
  const escaped = IMAGE_TRIGGER_KEYWORD.split('')
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\u3000\\-_]*');
  // 英文大小写不敏感；中文无大小写概念，i 标志不影响
  const re = new RegExp(`^${escaped}`, 'i');
  const m = re.exec(text);
  if (!m) return { matched: false, rest: '' };
  return { matched: true, rest: text.slice(m[0].length) };
}

/** 去掉描述前导分隔符 */
function trimSeparators(rest: string): string {
  return rest.replace(SEPARATORS, '');
}

/**
 * 是否含有有效描述。
 *
 * 用 Unicode 属性类判断，而不是枚举标点：既覆盖中英文标点，也不会把 emoji
 * 误当成"无意义内容"，同时避免代理对（🐱 占 2 个 UTF-16 单元）导致长度误判。
 */
export function hasMeaningfulDescription(text: string): boolean {
  const value = normalize(text);
  if (!value) return false;
  // 含 emoji 即视为有描述（\p{S} 会把 emoji 吞掉，需单独放行）
  if (EMOJI.test(value)) return true;
  if (NON_MEANINGFUL_ONLY.test(value)) return false;
  // 按码点计数：1 个汉字、1 个字母都算 1 个实义字符
  const codePoints = Array.from(value.replace(/[\s\u3000]/g, '')).filter(
    (ch) => !/[\p{P}\p{S}]/u.test(ch),
  );
  return codePoints.length >= MIN_DESCRIPTION_CHARS;
}

export interface ImageTriggerResult {
  /** 是否允许触发收费生图 */
  allowed: boolean;
  /** 命中前缀后去掉分隔符的图片描述（allowed=false 时为空串） */
  description: string;
  /** 拒绝原因分类，便于上抛给用户与测试断言 */
  reason: 'ok' | 'no-prefix' | 'empty-description';
}

/**
 * 判定用户输入是否能触发收费生图。
 *
 * @param userInput 用户本轮原始输入（历史注入内容不算，见 AgentManager 传参说明）
 */
export function resolveImageTrigger(userInput: string): ImageTriggerResult {
  const text = normalize(userInput);
  const { matched, rest } = matchPrefix(text);
  if (!matched) return { allowed: false, description: '', reason: 'no-prefix' };
  const description = trimSeparators(rest).trim();
  if (!hasMeaningfulDescription(description)) {
    return { allowed: false, description: '', reason: 'empty-description' };
  }
  return { allowed: true, description, reason: 'ok' };
}

/** 是否以生图前缀开头（仅前缀，不校验描述） */
export function startsWithImageTrigger(userInput: string): boolean {
  return matchPrefix(normalize(userInput)).matched;
}

/** 用户输入不以「生成图片」开头时的固定提示（不发任何生图请求） */
export const IMAGE_TRIGGER_HINT =
  '未调用生图功能（生图接口为收费服务）。如需生成图片，请让输入以「生成图片」开头，并在其后写明画面描述，例如：生成图片 一只在雪地里奔跑的柴犬，胶片质感。';

/** 命中了前缀但缺少有效描述时的固定提示（同样不发请求） */
export const IMAGE_TRIGGER_EMPTY_HINT =
  '已识别「生成图片」前缀，但后面没有可用的画面描述，本次未调用收费生图接口。请补充描述，例如：生成图片 一只在雪地里奔跑的柴犬，胶片质感。';
