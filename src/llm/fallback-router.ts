import { FunctionDeclaration, FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { GeminiLLM, LLMRequestOptions, LLMResponse, StreamCallbacks } from './gemini.js';
import { DeepseekLLM } from './deepseek.js';
import { colors as c } from '../ui/cli-ui.js';
import { TokenConfig, resolveTokenConfig } from './token-config.js';

export interface ProviderTier {
  name: string;
  provider: string;
  tier: 1 | 2 | 3;
  createClient: () => GeminiLLM | DeepseekLLM;
}

/**
 * FallbackRouterLLM - Smart 3-Tier Multi-Provider Load Balancer & Rate-Limit Fallback
 *
 * Tương thích với triết lý 3-Tier của 9Router:
 * - Tier 1: Flagship Primary (Google Gemini 3.7 / 3.6 / 3.5 Flash)
 * - Tier 2: Siêu tốc độ LPU / Cerebras (Groq Llama 3.3 70B, Cerebras 1.800 tok/s)
 * - Tier 3: High-capacity Backup & Zero-Key (SambaNova 405B, OpenRouter, Pollinations)
 *
 * Tự động chuyển vùng thông minh ngay giữa lúc LLM đang code (mid-coding) khi gặp Rate-Limit (429) hoặc 503/500.
 */
export class FallbackRouterLLM {
  readonly modelName: string;
  private tiers: ProviderTier[];
  private activeIndex: number = 0;
  private tokenConfig?: Partial<TokenConfig>;

  constructor(modelName: string = 'auto-fallback', tiers: ProviderTier[], tokenConfig?: Partial<TokenConfig>) {
    this.modelName = modelName;
    this.tokenConfig = tokenConfig;
    this.tiers = tiers.filter((t) => {
      try {
        t.createClient();
        return true;
      } catch {
        return false;
      }
    });

    if (this.tiers.length === 0) {
      throw new Error('Không có nhà cung cấp nào hợp lệ hoặc có API key khả dụng trong cấu hình Fallback Router.');
    }
  }

  getTokenConfig(): TokenConfig {
    return resolveTokenConfig(this.modelName, this.tokenConfig);
  }

  setTokenConfig(config: Partial<TokenConfig>): void {
    this.tokenConfig = {
      ...this.tokenConfig,
      ...config,
    };
  }

  getActiveProvider(): ProviderTier {
    return this.tiers[this.activeIndex] || this.tiers[0];
  }

  /**
   * Tạo phản hồi qua luồng Stream với cơ chế Auto-Fallback 3 tầng
   */
  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    let lastError: any = null;
    const initialIndex = this.activeIndex;
    const mergedRequest: LLMRequestOptions = {
      ...request,
      tokenConfig: {
        ...this.tokenConfig,
        ...request?.tokenConfig,
      },
    };

    for (let attempt = 0; attempt < this.tiers.length; attempt++) {
      const currentIndex = (initialIndex + attempt) % this.tiers.length;
      const currentTier = this.tiers[currentIndex];

      try {
        const client = currentTier.createClient();
        if (this.tokenConfig && typeof (client as any).setTokenConfig === 'function') {
          (client as any).setTokenConfig(this.tokenConfig);
        }

        if (attempt > 0) {
          console.log(`\n${c.yellow}${c.bold}⚡ [AUTO-FALLBACK ACTIVATED]${c.reset} ${c.brightYellow}Chuyển sang Tier ${currentTier.tier}: ${c.bold}${currentTier.name}${c.reset} (${currentTier.provider})...`);
        }

        const response = await client.generateStream(session, tools, callbacks, mergedRequest);

        // Thành công -> cập nhật activeIndex
        this.activeIndex = currentIndex;
        return response;
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || '');
        const isRateLimitOrOverload =
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('503') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('high demand') ||
          msg.includes('Rate limit') ||
          msg.includes('quota') ||
          msg.includes('fetch failed');

        if (isRateLimitOrOverload && attempt < this.tiers.length - 1) {
          const nextTier = this.tiers[(currentIndex + 1) % this.tiers.length];
          console.log(`\n${c.yellow}⚠️  Phát hiện Rate-Limit / Quá tải ở ${currentTier.name} (Tier ${currentTier.tier}). Đang tự động chuyển vùng sang ${nextTier.name} (Tier ${nextTier.tier})...${c.reset}`);
          continue;
        }

        // Lỗi khác hoặc đã hết danh sách fallback
        if (attempt === this.tiers.length - 1) {
          throw new Error(`Toàn bộ ${this.tiers.length} nhà cung cấp trong 3-Tier Fallback Pool đều gặp lỗi: ${msg}`);
        }
      }
    }

    throw lastError || new Error('Fallback Router không thể khởi tạo phản hồi.');
  }

  async generate(session: Session, tools: FunctionDeclaration[], request?: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateStream(session, tools, undefined, request);
  }
}
