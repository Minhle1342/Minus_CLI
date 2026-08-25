/**
 * TokenConfig - Hệ thống Quản lý và Điều chỉnh Ngân sách Token Đa Mô hình (Multi-Model Token Budgeting)
 * 
 * Hỗ trợ điều chỉnh toàn diện:
 * 1. Output Tokens (maxOutputTokens / max_tokens / max_completion_tokens).
 * 2. Input Tokens (maxInputTokens / Context Window Threshold / Compactor Trigger).
 * 3. Thinking & Reasoning Tokens (thinkingBudget / reasoning_effort / includeThoughts)
 *    cho Google Gemini, OpenAI Codex / o-series, DeepSeek R1, Anthropic Claude 3.7, Groq, Cerebras, SambaNova.
 */

export interface TokenConfig {
  /** Giới hạn số token đầu ra tối đa (max output tokens / completion tokens) */
  maxOutputTokens?: number;
  /** Giới hạn số token đầu vào của context window trước khi kích hoạt nén lịch sử */
  maxInputTokens?: number;
  /** Cấu hình Thinking Token Budget (cho Gemini 2.0/2.5/3, Claude 3.7, DeepSeek R1) */
  thinkingBudget?: number;
  /** Cấu hình mức độ suy luận ('low' | 'medium' | 'high' | 'max') cho OpenAI o1/o3/o4, GPT-5.6 Sol/Terra, DeepSeek */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  /** Có kích hoạt stream/thu thập thought tokens hay không */
  includeThoughts?: boolean;
}

export interface ModelTokenProfile {
  name: string;
  provider: 'gemini' | 'openai' | 'deepseek' | 'groq' | 'cerebras' | 'sambanova' | 'mistral' | 'anthropic' | 'other';
  defaultMaxOutputTokens: number;
  defaultMaxInputTokens: number;
  maxSupportedOutputTokens: number;
  maxSupportedInputTokens: number;
  supportsThinkingBudget: boolean;
  supportsReasoningEffort: boolean;
  isReasoningModel: boolean;
}

/**
 * Danh mục cấu hình Token mặc định theo từng dòng mô hình
 */
const MODEL_TOKEN_PROFILES: Record<string, Partial<ModelTokenProfile>> = {
  // Google Gemini Flagship
  'gemini-3.5-pro': {
    provider: 'gemini',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 2000000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: false,
    isReasoningModel: true,
  },
  'gemini-3.5-flash': {
    provider: 'gemini',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 500000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: false,
    isReasoningModel: true,
  },
  'gemini-2.5-pro': {
    provider: 'gemini',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 2000000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: false,
    isReasoningModel: true,
  },
  'gemini-2.5-flash': {
    provider: 'gemini',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 500000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: false,
    isReasoningModel: true,
  },
  'gemini-2.0-flash-thinking-exp': {
    provider: 'gemini',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 128000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: false,
    isReasoningModel: true,
  },
  'gemini-2.0-flash': {
    provider: 'gemini',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 500000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },

  // DeepSeek Direct
  'deepseek-chat': {
    provider: 'deepseek',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 8192,
    maxSupportedInputTokens: 64000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 16384,
    maxSupportedInputTokens: 64000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'deepseek-r1': {
    provider: 'deepseek',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 16384,
    maxSupportedInputTokens: 64000,
    supportsThinkingBudget: true,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },

  // OpenAI Codex & GPT-5.6 Series
  'gpt-5.6-sol': {
    provider: 'openai',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'gpt-5.6-terra': {
    provider: 'openai',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'gpt-5.6-luna': {
    provider: 'openai',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 32768,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'o1': {
    provider: 'openai',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 100000,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'o3-mini': {
    provider: 'openai',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'o4-mini': {
    provider: 'openai',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 65536,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    isReasoningModel: true,
  },
  'gpt-4o': {
    provider: 'openai',
    defaultMaxOutputTokens: 4096,
    defaultMaxInputTokens: 128000,
    maxSupportedOutputTokens: 16384,
    maxSupportedInputTokens: 128000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },

  // Groq LPU
  'llama-3.3-70b-versatile': {
    provider: 'groq',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 32768,
    maxSupportedInputTokens: 128000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'deepseek-r1-distill-llama-70b': {
    provider: 'groq',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 16384,
    maxSupportedInputTokens: 128000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: true,
  },

  // Cerebras
  'llama-3.3-70b': {
    provider: 'cerebras',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 8192,
    maxSupportedInputTokens: 128000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },

  // SambaNova
  'Meta-Llama-3.1-405B-Instruct': {
    provider: 'sambanova',
    defaultMaxOutputTokens: 4096,
    defaultMaxInputTokens: 32000,
    maxSupportedOutputTokens: 8192,
    maxSupportedInputTokens: 64000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },

  // Mistral
  'codestral-latest': {
    provider: 'mistral',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 64000,
    maxSupportedOutputTokens: 32768,
    maxSupportedInputTokens: 128000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },

  // Anthropic Claude API active models (model limits verified from Anthropic's
  // model overview and deprecation tables; dated IDs are pinned snapshots).
  'claude-fable-5': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 128000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-opus-5': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 128000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-opus-4-8': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 128000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-opus-4-7': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 128000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-opus-4-6': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 128000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-opus-4-5-20251101': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 200000,
    maxSupportedOutputTokens: 64000,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-sonnet-5': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 128000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 1000000,
    maxSupportedOutputTokens: 64000,
    maxSupportedInputTokens: 1000000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-sonnet-4-5-20250929': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 16384,
    defaultMaxInputTokens: 200000,
    maxSupportedOutputTokens: 64000,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    defaultMaxOutputTokens: 8192,
    defaultMaxInputTokens: 200000,
    maxSupportedOutputTokens: 64000,
    maxSupportedInputTokens: 200000,
    supportsThinkingBudget: false,
    supportsReasoningEffort: false,
    isReasoningModel: false,
  },
};

/**
 * Lấy Profile Token mặc định cho một mô hình bất kỳ
 */
export function getModelTokenProfile(modelName: string, baseURL?: string): ModelTokenProfile {
  const normalized = (modelName || '').toLowerCase().replace(/^(google|deepseek|groq|cerebras|sambanova|mistral|github|siliconflow|pollinations|codex|anthropic)\//, '');

  let matchedKey = Object.keys(MODEL_TOKEN_PROFILES).find((key) => key.toLowerCase() === normalized);
  if (!matchedKey) {
    matchedKey = Object.keys(MODEL_TOKEN_PROFILES).find((key) => normalized.includes(key.toLowerCase()));
  }

  const profile = matchedKey ? MODEL_TOKEN_PROFILES[matchedKey] : undefined;

  let provider: ModelTokenProfile['provider'] = 'other';
  if (normalized.startsWith('gemini')) provider = 'gemini';
  else if (normalized.includes('deepseek')) provider = 'deepseek';
  else if (normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) provider = 'openai';
  else if (normalized.includes('llama') && baseURL?.includes('groq')) provider = 'groq';
  else if (normalized.includes('llama') && baseURL?.includes('cerebras')) provider = 'cerebras';
  else if (normalized.includes('llama') && baseURL?.includes('sambanova')) provider = 'sambanova';
  else if (normalized.includes('codestral') || normalized.includes('mistral')) provider = 'mistral';
  else if (normalized.startsWith('claude-')) provider = 'anthropic';

  const isReasoning = Boolean(
    profile?.isReasoningModel ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4') ||
    normalized.includes('sol') ||
    normalized.includes('terra') ||
    normalized.includes('luna') ||
    normalized.includes('reasoner') ||
    normalized.includes('r1') ||
    normalized.includes('thinking')
  );

  return {
    name: modelName,
    provider: profile?.provider || provider,
    defaultMaxOutputTokens: profile?.defaultMaxOutputTokens ?? (isReasoning ? 16384 : 8192),
    defaultMaxInputTokens: profile?.defaultMaxInputTokens ?? (provider === 'gemini' ? 500000 : 64000),
    maxSupportedOutputTokens: profile?.maxSupportedOutputTokens ?? 65536,
    maxSupportedInputTokens: profile?.maxSupportedInputTokens ?? (provider === 'gemini' ? 1000000 : 128000),
    supportsThinkingBudget: profile?.supportsThinkingBudget ?? (provider === 'gemini' || isReasoning),
    supportsReasoningEffort: profile?.supportsReasoningEffort ?? (provider === 'openai' || isReasoning),
    isReasoningModel: isReasoning,
  };
}

/**
 * Trộn cấu hình Token người dùng mong muốn với các giá trị mặc định của Model
 */
export function resolveTokenConfig(modelName: string, userConfig?: Partial<TokenConfig>, baseURL?: string): TokenConfig {
  const profile = getModelTokenProfile(modelName, baseURL);

  let maxOutputTokens = userConfig?.maxOutputTokens ?? profile.defaultMaxOutputTokens;
  if (profile.maxSupportedOutputTokens && maxOutputTokens > profile.maxSupportedOutputTokens) {
    maxOutputTokens = profile.maxSupportedOutputTokens;
  }

  let maxInputTokens = userConfig?.maxInputTokens ?? profile.defaultMaxInputTokens;
  if (profile.maxSupportedInputTokens && maxInputTokens > profile.maxSupportedInputTokens) {
    maxInputTokens = profile.maxSupportedInputTokens;
  }

  let thinkingBudget = userConfig?.thinkingBudget;
  if (thinkingBudget === undefined && profile.supportsThinkingBudget) {
    thinkingBudget = profile.isReasoningModel ? 4096 : undefined;
  }

  const reasoningEffort = userConfig?.reasoningEffort ?? (profile.supportsReasoningEffort ? 'medium' : undefined);
  const includeThoughts = userConfig?.includeThoughts ?? true;

  return {
    maxOutputTokens,
    maxInputTokens,
    thinkingBudget,
    reasoningEffort,
    includeThoughts,
  };
}

/**
 * 4 Cấp độ Đóng gói Cấu hình Sẵn (Preset Tiers: Low, Medium, High, Max)
 */
export type TokenPresetTier = 'low' | 'medium' | 'high' | 'max';

export interface TokenTierDefinition {
  tier: TokenPresetTier;
  label: string;
  badge: string;
  description: string;
  outputTokens: number | 'max';
  inputTokens: number | 'max';
  thinkingTokens: number | 'max';
  reasoningEffort: 'low' | 'medium' | 'high' | 'max';
}

/**
 * Bảng thông số định mức của các Gói Cấu hình Token (Preset Tiers)
 */
export const TOKEN_TIER_DEFINITIONS: Record<TokenPresetTier, TokenTierDefinition> = {
  low: {
    tier: 'low',
    label: 'Tiết kiệm / Phản hồi nhanh (Low / Eco)',
    badge: '🟢 LOW',
    description: 'Output 2K, Context 16K, Thinking 2K (effort: low) - Tối ưu token & phản hồi tức thì',
    outputTokens: 2048,
    inputTokens: 16000,
    thinkingTokens: 2048,
    reasoningEffort: 'low',
  },
  medium: {
    tier: 'medium',
    label: 'Tiêu chuẩn / Cân bằng (Medium / Balanced)',
    badge: '🟡 MEDIUM',
    description: 'Output 8K, Context 64K, Thinking 8K (effort: medium) - Cân bằng cho công việc thường ngày',
    outputTokens: 8192,
    inputTokens: 64000,
    thinkingTokens: 8192,
    reasoningEffort: 'medium',
  },
  high: {
    tier: 'high',
    label: 'Nâng cao / Chuyên sâu (High / Deep Thinking)',
    badge: '🟠 HIGH',
    description: 'Output 16K, Context 128K, Thinking 24K (effort: high) - Dành cho refactor lớn và suy luận sâu',
    outputTokens: 16384,
    inputTokens: 128000,
    thinkingTokens: 24576,
    reasoningEffort: 'high',
  },
  max: {
    tier: 'max',
    label: 'Cực đại / Tối đa (Max / Unlimited)',
    badge: '🔴 MAX',
    description: 'Output Max, Context Max, Thinking 64K (effort: max) - Khai thác 100% giới hạn phần cứng model',
    outputTokens: 'max',
    inputTokens: 'max',
    thinkingTokens: 'max',
    reasoningEffort: 'max',
  },
};

/**
 * Chuẩn hóa tên tier từ input của người dùng (hỗ trợ alias như eco, balanced, deep, v.v.)
 */
export function normalizePresetTier(input: string): TokenPresetTier | null {
  const clean = (input || '').toLowerCase().trim();
  if (clean === 'low' || clean === 'min' || clean === 'eco' || clean === 'fast' || clean === '1') return 'low';
  if (clean === 'medium' || clean === 'med' || clean === 'mid' || clean === 'balanced' || clean === 'default' || clean === '2') return 'medium';
  if (clean === 'high' || clean === 'deep' || clean === 'heavy' || clean === 'pro' || clean === '3') return 'high';
  if (clean === 'max' || clean === 'maximum' || clean === 'full' || clean === 'unlimited' || clean === '4') return 'max';
  return null;
}

/**
 * Giải mã tham số Output Tokens từ preset tier hoặc số nguyên
 */
export function resolveOutputTokensPreset(val: string | number, profile: ModelTokenProfile): number | null {
  if (typeof val === 'number') {
    return Math.min(val, profile.maxSupportedOutputTokens);
  }
  const tier = normalizePresetTier(val);
  if (tier === 'low') return Math.min(2048, profile.maxSupportedOutputTokens);
  if (tier === 'medium') return Math.min(8192, profile.maxSupportedOutputTokens);
  if (tier === 'high') return Math.min(16384, profile.maxSupportedOutputTokens);
  if (tier === 'max') return profile.maxSupportedOutputTokens;

  const num = parseInt(val, 10);
  if (!isNaN(num) && num > 0) {
    return Math.min(num, profile.maxSupportedOutputTokens);
  }
  return null;
}

/**
 * Giải mã tham số Input Tokens (Context Window / Compactor) từ preset tier hoặc số nguyên
 */
export function resolveInputTokensPreset(val: string | number, profile: ModelTokenProfile): number | null {
  if (typeof val === 'number') {
    return Math.min(val, profile.maxSupportedInputTokens);
  }
  const tier = normalizePresetTier(val);
  if (tier === 'low') return Math.min(16000, profile.maxSupportedInputTokens);
  if (tier === 'medium') return Math.min(64000, profile.maxSupportedInputTokens);
  if (tier === 'high') return Math.min(128000, profile.maxSupportedInputTokens);
  if (tier === 'max') return profile.maxSupportedInputTokens;

  const num = parseInt(val, 10);
  if (!isNaN(num) && num > 0) {
    return Math.min(num, profile.maxSupportedInputTokens);
  }
  return null;
}

/**
 * Giải mã tham số Thinking Token Budget từ preset tier, số nguyên hoặc 'off'
 */
export function resolveThinkingTokensPreset(
  val: string | number,
  profile: ModelTokenProfile
): { thinkingBudget?: number; reasoningEffort?: 'low' | 'medium' | 'high' | 'max' } | null {
  if (typeof val === 'number') {
    return { thinkingBudget: val, reasoningEffort: val <= 2048 ? 'low' : val <= 8192 ? 'medium' : val <= 24576 ? 'high' : 'max' };
  }

  const clean = (val || '').toLowerCase().trim();
  if (clean === 'off' || clean === 'none' || clean === 'disable' || clean === '0') {
    return { thinkingBudget: 0, reasoningEffort: 'low' };
  }

  const tier = normalizePresetTier(val);
  if (tier === 'low') {
    return { thinkingBudget: 2048, reasoningEffort: 'low' };
  }
  if (tier === 'medium') {
    return { thinkingBudget: 8192, reasoningEffort: 'medium' };
  }
  if (tier === 'high') {
    return { thinkingBudget: 24576, reasoningEffort: 'high' };
  }
  if (tier === 'max') {
    return { thinkingBudget: 64000, reasoningEffort: 'max' };
  }

  const num = parseInt(val, 10);
  if (!isNaN(num) && num >= 0) {
    return { thinkingBudget: num, reasoningEffort: num <= 2048 ? 'low' : num <= 8192 ? 'medium' : num <= 24576 ? 'high' : 'max' };
  }

  return null;
}

/**
 * Tạo gói cấu hình TokenConfig hoàn chỉnh từ một Preset Tier
 */
export function getPresetTokenConfig(tier: TokenPresetTier, profile: ModelTokenProfile): TokenConfig {
  const def = TOKEN_TIER_DEFINITIONS[tier];

  const maxOutputTokens = def.outputTokens === 'max'
    ? profile.maxSupportedOutputTokens
    : Math.min(def.outputTokens, profile.maxSupportedOutputTokens);

  const maxInputTokens = def.inputTokens === 'max'
    ? profile.maxSupportedInputTokens
    : Math.min(def.inputTokens, profile.maxSupportedInputTokens);

  let thinkingBudget: number | undefined = undefined;
  if (profile.supportsThinkingBudget || profile.isReasoningModel) {
    thinkingBudget = def.thinkingTokens === 'max'
      ? 64000
      : def.thinkingTokens;
  }

  const reasoningEffort = profile.supportsReasoningEffort || profile.isReasoningModel
    ? def.reasoningEffort
    : undefined;

  return {
    maxOutputTokens,
    maxInputTokens,
    thinkingBudget,
    reasoningEffort,
    includeThoughts: true,
  };
}
