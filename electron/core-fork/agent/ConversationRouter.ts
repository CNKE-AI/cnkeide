export type InteractionMode = 'ask' | 'coder' | 'architect' | 'debugger';
export type ConversationLanguage = 'zh' | 'en' | 'ja' | 'ko' | 'ru' | 'ar' | 'es' | 'fr' | 'de';
export type ConversationTopic = 'general' | 'code' | 'writing' | 'data' | 'design';
export interface ConversationContext {
  language: ConversationLanguage;
  topic: ConversationTopic;
  environment: string;
  targetPlatform?: 'windows' | 'linux' | 'macos' | 'browser';
  mode: InteractionMode;
}
export interface ConversationDecision extends ConversationContext {
  changed: boolean;
  resetHistory: boolean;
  reason: string;
}
export interface ConversationMessage { role: string; content: string }

function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').slice(0, 12000);
}

export function detectLanguage(text: string, fallback: ConversationLanguage = 'zh'): ConversationLanguage {
  const p = prose(text);
  const requested: [ConversationLanguage, RegExp][] = [
    ['en', /(?:用|使用|请用)英语|(?:用|使用|请用)英文|(?:answer|reply|respond)\s+in\s+english/i],
    ['zh', /(?:用|使用|请用)中文|(?:answer|reply|respond)\s+in\s+chinese/i],
    ['ja', /(?:用|使用)日语|日本語で|(?:answer|reply|respond)\s+in\s+japanese/i],
    ['ko', /(?:用|使用)韩语|한국어로|(?:answer|reply|respond)\s+in\s+korean/i],
    ['fr', /(?:用|使用)法语|(?:answer|reply|respond)\s+in\s+french/i],
    ['es', /(?:用|使用)西班牙语|(?:answer|reply|respond)\s+in\s+spanish/i],
    ['de', /(?:用|使用)德语|(?:answer|reply|respond)\s+in\s+german/i],
  ];
  const explicit = requested.find(([, pattern]) => pattern.test(p));
  if (explicit) return explicit[0];
  if (/[\u3040-\u30ff]/.test(p)) return 'ja';
  if (/[\uac00-\ud7af]/.test(p)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(p)) return 'zh';
  if (/[\u0400-\u04ff]/.test(p)) return 'ru';
  if (/[\u0600-\u06ff]/.test(p)) return 'ar';
  if (/\b(hola|gracias|necesito|puedes|escribe|explica)\b/i.test(p)) return 'es';
  if (/\b(bonjour|merci|pouvez|écrire|expliquez)\b/i.test(p)) return 'fr';
  if (/\b(hallo|danke|bitte|erkläre|schreibe)\b/i.test(p)) return 'de';
  if (/[a-z]{2,}/i.test(p)) return 'en';
  return fallback;
}

export function detectTopic(text: string): ConversationTopic | null {
  const p = prose(text);
  if (/写作|文案|诗歌|文章|邮件|翻译|\b(poem|essay|email|translate|copywriting)\b/i.test(p)) return 'writing';
  if (/数据分析|统计|报表|表格|\b(dataset|spreadsheet|csv|statistics)\b/i.test(p)) return 'data';
  if (/代码|函数|程序|仓库|编程|接口|报错|架构|\b(code|function|class|bug|git|react|typescript|python|api|refactor)\b/i.test(p)) return 'code';
  if (/界面|配色|海报|设计稿|\b(ui|ux|layout|design|poster)\b/i.test(p)) return 'design';
  return null;
}

export function detectInteractionMode(text: string, fallback: InteractionMode = 'ask'): InteractionMode {
  const p = prose(text).trim();
  const explicit = /^\/(ask|craft|plan)\b/i.exec(p)?.[1]?.toLowerCase();
  if (explicit) return explicit === 'craft' ? 'coder' : explicit === 'plan' ? 'architect' : 'ask';
  if (/不要(?:修改|改动|执行|实现|写代码)|只(?:解释|回答|说明|分析)|(?:do not|don't)\s+(?:change|modify|execute|implement)/i.test(p)) {
    return /计划|方案|规划|\bplan\b/i.test(p) ? 'architect' : 'ask';
  }
  if (/先(?:给|做|列|制定)?.{0,8}(?:计划|方案)|只(?:做|给|需).{0,6}(?:计划|方案)|暂不实现|先不写代码|\b(?:plan first|plan only|do not implement yet)\b/i.test(p)) return 'architect';
  if (/^(?:请)?(?:解释|什么|为什么|怎么|如何)|\b(?:what|why|how)\b|(?:吗|呢)[？?]?$|[？?]$/i.test(p)) return 'ask';
  if (/实现|构建|修复|重构|创建|新增|添加|修改|删除|执行|编写|翻译|写(?:一个|一段|代码|篇|封|首)|\b(implement|build|fix|refactor|create|add|modify|delete|execute|write|translate)\b/i.test(p)) return 'coder';
  if (/计划|规划|方案|架构设计|\b(plan|roadmap|architecture)\b/i.test(p)) return 'architect';
  if (/^(?:继续|接着|好的|好|是的|可以|continue|go on|yes|ok)[。.!！\s]*$/i.test(p)) return fallback;
  return 'ask';
}

export function routeConversation(
  text: string, environment: string, previous?: ConversationContext, manualMode?: InteractionMode,
): ConversationDecision {
  const p = prose(text);
  const explicitSwitch = /换个话题|新话题|另一个话题|不谈.{0,12}了|\b(new topic|change (?:the )?topic|unrelated question|switch topic)\b/i.test(p);
  const requestedPlatform = /(?:切换到|改用|现在使用|目标环境|switch to|target(?: platform)?[:\s]+)\s*(windows|linux|macos|browser|浏览器)/i.exec(p)?.[1]?.toLowerCase();
  const targetPlatform = (requestedPlatform === '浏览器' ? 'browser' : requestedPlatform) as ConversationContext['targetPlatform'] || previous?.targetPlatform;
  const environmentChanged = !!previous && (previous.environment !== environment || (!!requestedPlatform && previous.targetPlatform !== targetPlatform));
  const detectedTopic = detectTopic(text);
  const topic = detectedTopic ?? (explicitSwitch || environmentChanged ? 'general' : previous?.topic ?? 'general');
  const topicChanged = !!previous && detectedTopic !== null && previous.topic !== 'general' && previous.topic !== topic;
  const resetHistory = explicitSwitch || environmentChanged || topicChanged;
  const language = detectLanguage(text, previous?.language);
  const mode = manualMode ?? detectInteractionMode(text, resetHistory ? 'ask' : previous?.mode);
  const changed = !previous || resetHistory || language !== previous.language || mode !== previous.mode;
  const reason = [environmentChanged ? '工作区环境已切换' : '', explicitSwitch || topicChanged ? '话题已切换，隔离旧上下文' : '', previous && language !== previous.language ? '回复语言已切换' : '', manualMode ? '手动模式' : '智能识别模式'].filter(Boolean).join(' · ');
  return { language, topic, environment, targetPlatform, mode, changed, resetHistory, reason };
}

export function resolveConversation(
  text: string, environment: string, history: ConversationMessage[], manualMode?: InteractionMode,
): { decision: ConversationDecision; history: ConversationMessage[] } {
  let previous: ConversationContext | undefined;
  let boundary = 0;
  history.forEach((message, index) => {
    if (message.role !== 'user') return;
    const next = routeConversation(message.content, environment, previous);
    if (next.resetHistory) boundary = index;
    previous = next;
  });
  const decision = routeConversation(text, environment, previous, manualMode);
  return { decision, history: decision.resetHistory ? [] : history.slice(boundary) };
}

export function conversationInstruction(context: ConversationContext): string {
  const names: Record<ConversationLanguage, string> = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', ru: 'Русский', ar: 'العربية', es: 'Español', fr: 'Français', de: 'Deutsch' };
  return `\n\n[当前对话环境]\n回复语言：${names[context.language]}。主题：${context.topic}。目标平台：${context.targetPlatform ?? '沿用实际工作区环境'}（这是讨论目标，不改变工具真实执行的操作系统，不能假定已连接其他主机）。交互模式：${context.mode === 'coder' ? 'craft' : context.mode === 'architect' ? 'plan' : context.mode}。\n按照当前用户要求回答，不延续已切换话题的任务。Ask 只回答和只读检索；Plan 只分析与规划，不执行代码或文件修改；Craft 可以实施，但仍必须遵守工具审批。语言识别仅决定解释语言，不更改代码、引用或翻译目标。` ;
}
