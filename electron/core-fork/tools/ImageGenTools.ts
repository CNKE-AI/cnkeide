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
    try {
      if (!req.savePath) return { success: false, provider: this.provider, error: '未提供本地图片保存路径' };
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
      if (!resp.ok) {
        const text = await resp.text();
        return { success: false, provider: this.provider, error: `GPT Image ${resp.status}: ${text.slice(0, 300)}` };
      }
      const data: any = await resp.json();
      const item = data?.data?.[0] || {};
      let bytes: Buffer;
      let mimeType = 'image/png';
      if (item.b64_json) {
        bytes = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        const imageResp = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
        if (!imageResp.ok) throw new Error(`下载生成图片失败：HTTP ${imageResp.status}`);
        mimeType = imageResp.headers.get('content-type')?.split(';')[0] || mimeType;
        bytes = Buffer.from(await imageResp.arrayBuffer());
      } else {
        return { success: false, provider: this.provider, error: '生图接口未返回 b64_json 或 url' };
      }
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(req.savePath), { recursive: true });
      await fs.writeFile(req.savePath, bytes);
      const base64 = bytes.toString('base64');
      return {
        success: true, provider: this.provider, path: req.savePath, base64, mimeType,
        dataUrl: `data:${mimeType};base64,${base64}`, url: item.url,
      };
    } catch (err: any) {
      return { success: false, provider: this.provider, error: err.message || String(err) };
    }
  }
}
