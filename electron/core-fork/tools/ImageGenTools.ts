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
  /** 图片尺寸：1024x1024, 1024x1792, 1792x1024, 512x512 */
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  /** 张数，默认 1 */
  n?: number;
  /** 保存路径（绝对路径）；缺省时只返回 base64 */
  savePath?: string;
}

export interface ImageGenResult {
  success: boolean;
  /** 本地路径（如有保存） */
  path?: string;
  /** base64 编码（PNG） */
  base64?: string;
  /** OpenAI 风格 URL（外部 URL 形式） */
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

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return {
      success: false,
      provider: this.provider,
      error: '图片生成未配置。请在设置中添加支持图片生成的 API（如 OpenAI DALL-E / 通义万相）',
    };
  }
}

/** OpenAI DALL-E 3 实现 */
export class OpenAIImageGenAdapter implements ImageGenAdapter {
  readonly available = true;
  readonly provider = 'openai-dall-e-3';
  constructor(private apiKey: string, private baseUrl: string = 'https://api.openai.com') {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: req.prompt,
          size: req.size || '1024x1024',
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        return { success: false, provider: this.provider, error: `DALL-E ${resp.status}: ${text.slice(0, 200)}` };
      }
      const data: any = await resp.json();
      const b64 = data?.data?.[0]?.b64_json;
      const url = data?.data?.[0]?.url;
      const out: ImageGenResult = { success: true, provider: this.provider, base64: b64, url };
      if (b64 && req.savePath) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(req.savePath, Buffer.from(b64, 'base64'));
        out.path = req.savePath;
      }
      return out;
    } catch (err: any) {
      return { success: false, provider: this.provider, error: err.message || String(err) };
    }
  }
}
