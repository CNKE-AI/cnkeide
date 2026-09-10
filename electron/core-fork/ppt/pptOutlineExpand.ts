/**
 * PPT 大纲细化扩写
 *
 * 用户已有大纲后，可以针对单页或全文做"细化扩写"——让 LLM 把每页的 bullet
 * 从简短的一句话展开成更丰富、有细节、有数据的列表。
 *
 * 流程：
 * - expandSlide(slide, themeContext) → 单页扩写（流式返回）
 * - expandAll(outline, themeContext, onProgress) → 全文逐页扩写
 *
 * 不依赖主题，只依赖通用 system prompt（保持扩写结果与主题无关）。
 */

import { Outline, SlideDraft } from './pptRenderer';

export interface ExpandOptions {
  /** 扩写强度：light 轻度（每条 +1 描述）/ standard 标准（每条 +1-2 细节）/ deep 深度（增加数据 + 案例） */
  intensity?: 'light' | 'standard' | 'deep';
  /** 用户可选附加要求（如：增加数据、加入案例） */
  extraInstruction?: string;
  /** 单页主题语境（来自 PPT 总主题），让扩写更聚焦 */
  presentationTopic?: string;
  /** 进度回调（仅 expandAll） */
  onProgress?: (current: number, total: number, message: string) => void;
}

export interface ExpandResult {
  success: boolean;
  slide?: SlideDraft;
  outline?: Outline;
  error?: string;
}

const INTENSITY_INSTRUCTIONS: Record<NonNullable<ExpandOptions['intensity']>, string> = {
  light: '轻度扩写：每条 bullet 后追加 1 句简短描述/数据/背景，保持原意不偏离。',
  standard: '标准扩写：每条 bullet 展开为「核心要点 + 1 句具体细节/数据」两行。',
  deep: '深度扩写：每条 bullet 展开为「核心要点 + 数据/案例/对比/趋势」3 行，更专业可信。',
};

const EXPAND_SYSTEM_PROMPT = `你是演示文稿内容扩写专家，擅长把简短的要点展开成丰富、有说服力、适合 PPT 演说的内容。

【硬性要求】
1. 严格输出 JSON（不要 markdown 代码块、不要解释文字）
2. 输出结构：{"title":"原标题或微调","bullets":["要点1","要点2",...]}
3. **必须保留原 bullet 的核心意思**，不能改写或删除
4. bullets 数量可以追加但每页总数 ≤ 6
5. 每条扩写要具体、有细节、有说服力
6. 不引入与主题无关的内容`;

/**
 * 单页扩写
 */
export async function expandSlide(
  llmProvider: any,
  apiConfig: any,
  slide: SlideDraft,
  opts: ExpandOptions = {},
): Promise<ExpandResult> {
  const intensity = opts.intensity || 'standard';
  const userPrompt = [
    `# PPT 总主题`,
    opts.presentationTopic || '（未指定）',
    '',
    `# 本页标题`,
    slide.title,
    '',
    `# 当前要点（待扩写）`,
    JSON.stringify(slide.bullets, null, 2),
    '',
    `# 扩写要求`,
    INTENSITY_INSTRUCTIONS[intensity],
    opts.extraInstruction ? `\n附加：${opts.extraInstruction}` : '',
    '',
    `# 输出 JSON`,
    `{"title":"...","bullets":["...","..."]}`,
  ].join('\n');

  try {
    const resp = await llmProvider.chat({
      apiConfig,
      messages: [
        { role: 'system', content: EXPAND_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.6,
    });
    let text = (resp.content || '').trim();
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m) text = m[1].trim();
    const parsed = JSON.parse(text);
    return {
      success: true,
      slide: {
        title: parsed.title || slide.title,
        bullets: Array.isArray(parsed.bullets) ? parsed.bullets : slide.bullets,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * 全文扩写：逐页串行调用（避免并行打乱顺序），完成后组装新大纲
 */
export async function expandAll(
  llmProvider: any,
  apiConfig: any,
  outline: Outline,
  opts: ExpandOptions = {},
): Promise<ExpandResult> {
  const onProgress = opts.onProgress || (() => {});
  const total = outline.slides.length;
  const newSlides: SlideDraft[] = [];
  for (let i = 0; i < total; i++) {
    onProgress(i, total, `正在扩写第 ${i + 1}/${total} 页：${outline.slides[i].title}`);
    const r = await expandSlide(llmProvider, apiConfig, outline.slides[i], {
      ...opts,
      presentationTopic: opts.presentationTopic || outline.title,
    });
    if (!r.success || !r.slide) {
      return { success: false, error: `第 ${i + 1} 页扩写失败：${r.error || '未知错误'}` };
    }
    newSlides.push(r.slide);
  }
  onProgress(total, total, '扩写完成');
  return { success: true, outline: { title: outline.title, slides: newSlides } };
}
