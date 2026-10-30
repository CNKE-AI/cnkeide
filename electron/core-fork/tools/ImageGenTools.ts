/**
 * ImageGenTools - 图片生成接口（W12）
 *
 * 设计：
 * - 不强制引入图片生成库（避免 100MB+ 依赖）
 * - 通过 ImageGenAdapter 接口暴露能力
 * - 支持的可选实现：
 *   - OpenAI DALL-E 3
 *   - 通义万相（Qwen Wanxiang）
 *   - Stability AI
 *   - 本地 Stable Diffusion（未来）
 *
 * 默认实现：未配置时返回错误提示
 */

export interface ImageGenRequest {
  prompt: string;
  /** GPT Image 尺寸 */
  size?: '1024x1024' | '1536x1024' | '1024x1536';
  /** 张数，默认 1 */
  n?: number;
  /** 保存路径（绝对路径）；缺省时只返回 base64 */
  savePath?: string;
}

export interface ImageGenResult {
  success: boolean;
  /** 本地路径（所有成功结果都必须保存） */
  path?: string;
  /** base64 编码 */
  base64?: string;
  /** 可直接在聊天窗口展示的 data URL */
  dataUrl?: string;
  mimeType?: string;
  /** API 原始临时 URL（仅用于下载，不作为最终展示来源） */
  url?: string;
  /** 实际使用的 provider */
  provider: string;
  error?: string;
}

export interface ImageGenAdapter {
  readonly available: boolean;
  readonly provider: string;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** 默认实现：未配置 */
export class MockImageGenAdapter implements ImageGenAdapter {
  readonly available = false;
  readonly provider = 'mock';

  generate(_req: ImageGenRequest): Promise<ImageGenResult> {
    return Promise.resolve({
      success: false,
      provider: this.provider,
      error: '图片生成未配置。请在设置中添加支持图片生成的 API（如 OpenAI DALL-E / 通义万相）',
    });
  }
}

/**
 * 生图接口错误脱敏（只读安全约束）：
 * 对外错误只保留通用分类文案，严禁透传上游响应体、内部端点、模型名、
 * 堆栈、IP/域名等系统细节。状态码到文案的映射即全部对外信息。
 */
function sanitizeImageError(err: unknown, status?: number): string {
  if (status !== undefined) {
    if (status === 401 || status === 403) return '生图服务鉴权失败，请检查 API 配置是否有效';
    if (status === 404) return '生图服务暂不支持当前模型，请在设置中调整后重试';
    if (status === 429) return '生图服务繁忙（触发限流），请稍后重试';
    if (status >= 500) return '生图服务暂不可用，请稍后重试';
    if (status >= 400) return `生图请求被服务端拒绝（${status}），请检查描述内容是否合规`;
    return '生图请求失败，请稍后重试';
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/timeout|aborted|ETIMEDOUT/i.test(msg)) return '生图请求超时，请稍后重试';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(msg)) return '网络异常，无法连接生图服务，请检查网络后重试';
  return '生图请求失败，请稍后重试';
}

/** prompt 输入校验：只允许常规可见字符，限长防滥用 */
const MAX_PROMPT_CHARS = 2000;

export function validateImagePrompt(prompt: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof prompt !== 'string') return { ok: false, error: '图片描述必须是文本' };
  // 去除控制字符（防注入/防不可见字符干扰），保留常规 Unicode 可见内容
  const cleaned = prompt.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!cleaned) return { ok: false, error: '图片描述不能为空' };
  if (cleaned.length > MAX_PROMPT_CHARS) return { ok: false, error: `图片描述过长（最多 ${MAX_PROMPT_CHARS} 字）` };
  return { ok: true, value: cleaned };
}

/** OpenAI-compatible GPT Image 实现 */
export class OpenAIImageGenAdapter implements ImageGenAdapter {
  readonly available = true;
  readonly provider = 'openai-gpt-image';

  constructor(
    private apiKey: string,
    private baseUrl: string = 'https://api.openai.com/v1',
    private model: string = 'gpt-image-2',
  ) {}

  private endpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/images/generations`;
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    let status: number | undefined;
    try {
      if (!req.savePath) return { success: false, provider: this.provider, error: '生图系统内部路径未就绪，请稍后重试' };
      const resp = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt: req.prompt,
          size: req.size || '1024x1024',
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(180_000),
      });
      status = resp.status;
      if (!resp.ok) {
        // 读取并丢弃上游响应体：其中可能含内部端点/账号信息，绝不出现在对外错误里
        await resp.text().catch(() => '');
        return { success: false, provider: this.provider, error: sanitizeImageError(null, status) };
      }
      const data: any = await resp.json();
      const item = data?.data?.[0] || {};
      let bytes: Buffer;
      let mimeType = 'image/png';
      if (item.b64_json) {
        bytes = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        const imageResp = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
        if (!imageResp.ok) return { success: false, provider: this.provider, error: '生成结果下载失败，请重试' };
        mimeType = imageResp.headers.get('content-type')?.split(';')[0] || mimeType;
        bytes = Buffer.from(await imageResp.arrayBuffer());
      } else {
        return { success: false, provider: this.provider, error: '生图服务返回内容异常，请稍后重试' };
      }
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(req.savePath), { recursive: true });
      await fs.writeFile(req.savePath, bytes);
      const base64 = bytes.toString('base64');
      return {
        success: true, provider: this.provider, path: req.savePath, base64, mimeType,
        dataUrl: `data:${mimeType};base64,${base64}`,
      };
    } catch (err: unknown) {
      // 不透传 err.message（可能含 URL/IP/堆栈），统一走脱敏映射
      return { success: false, provider: this.provider, error: sanitizeImageError(err, status) };
    }
  }
}
