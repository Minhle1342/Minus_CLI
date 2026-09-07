import { ExactTokenizer } from './exact-tokenizer.js';

export interface DynamicContextInputs {
  /** P1: Chỉ dẫn công cụ kế tiếp từ ToolSynergyAdvisor (CRITICAL - Bảo toàn 100%) */
  advicePrompt?: string;
  /** P1.1: Phản tư lỗi chuyên sâu và chi tiết test assertion từ ErrorDetective/ReflectionEngine (CRITICAL - Bảo toàn) */
  reflectionContext?: string;
  /** P1.2: Cognitive Scaffold (Negative Gates, Anti-Deception, Topology) từ CognitiveHarness (HIGH - Bảo toàn) */
  cognitiveScaffold?: string;
  /** P1.5: Chỉ dẫn hành vi chuyên biệt theo Phase (Explore 80% reasoning / Implement patch spec / Verify gate) (CRITICAL - Bảo toàn 100%) */
  phaseGuidance?: string;
  /** P2: Trạng thái DAG plan, acceptance criteria từ PlanManager (HIGH - Bảo toàn) */
  rawPlanContext?: string;
  /** P3: Turn cũ liên quan được re-inject từ TurnMemoryRetriever (MEDIUM-HIGH) */
  recalledTurnContext?: string;
  /** P4: Trí nhớ dự án đã xác thực từ ProjectMemoryManager (MEDIUM) */
  memoryPrompt?: string;
  /** P5: Trạng thái file đang tập trung từ ComposeController (MEDIUM-LOW) */
  composeContext?: string;
  /** P6: Trí nhớ mã nguồn kèm citation từ CitationValidatedRepositoryMemory (LOW) */
  repositoryMemoryContext?: string;
  /** P7: Bản đồ quan hệ mã nguồn từ GraphRankedRepositoryMap (LOWEST - Cắt tỉa đầu tiên) */
  repositoryContext?: string;
}

export interface DynamicContextArbiterOptions {
  /** Trần ngân sách tối đa cho toàn bộ dynamic context (mặc định: 2.000 tokens) */
  maxBudgetTokens?: number;
  /** Tên model để tính token chuẩn xác */
  modelName?: string;
  /** Khử trùng lặp chéo giữa các tầng trí nhớ (mặc định: true) */
  enableDeduplication?: boolean;
  /** Số lần thất bại liên tiếp của lượt chạy hiện tại để điều tiết ngân sách động */
  consecutiveFailures?: number;
}

export interface DynamicContextArbiterResult {
  renderedContext: string;
  totalTokens: number;
  budgetTokens: number;
  sourcesIncluded: string[];
  sourcesPruned: string[];
  sourcesTruncated: string[];
  stats: {
    beforeTokens: number;
    afterTokens: number;
    tokensSaved: number;
  };
}

interface RankedSource {
  key: keyof DynamicContextInputs;
  name: string;
  content: string;
  priority: number; // 1 (cao nhất) -> 7 (thấp nhất)
  allowTruncation: boolean;
  minPreserveLines?: number;
}

/**
 * Global Dynamic Budget Arbiter
 * 
 * Bộ trọng tài kiểm soát và điều tiết ngân sách token cho toàn bộ các nguồn ngữ cảnh tiêm vào LLM:
 * 1. Phân tầng ưu tiên nghiêm ngặt (Priority Tiers 1 -> 7) cho 7 nguồn ngữ cảnh động.
 * 2. Khử trùng lặp chéo (Cross-Source Deduplication) giữa các tầng trí nhớ độc lập.
 * 3. Đếm token chính xác đa mô hình qua ExactTokenizer.
 * 4. Cắt tỉa theo dòng (Clean Line-Boundary Truncation) và loại bỏ có thứ tự để không bao giờ vượt trần ngân sách (mặc định 2.000 tokens).
 */
export class DynamicContextArbiter {
  static readonly DEFAULT_MAX_BUDGET_TOKENS = 2_000;

  private defaultBudget: number;

  constructor(defaultBudgetTokens?: number) {
    const envBudget = parseInt(process.env.MINUS_DYNAMIC_CONTEXT_BUDGET || '', 10);
    this.defaultBudget = Number.isFinite(envBudget) && envBudget > 0
      ? envBudget
      : (defaultBudgetTokens ?? DynamicContextArbiter.DEFAULT_MAX_BUDGET_TOKENS);
  }

  arbitrate(
    inputs: DynamicContextInputs,
    options?: DynamicContextArbiterOptions | string,
  ): DynamicContextArbiterResult {
    const optObj = typeof options === 'string' ? { modelName: options } : options;
    const budgetTokens = optObj?.maxBudgetTokens ?? this.defaultBudget;
    const modelName = optObj?.modelName || 'gemini-2.5-flash';
    const enableDedup = optObj?.enableDeduplication ?? true;

    // 1. Chuẩn hóa và xếp hạng các nguồn theo thứ tự ưu tiên
    const rawSources: RankedSource[] = [
      {
        key: 'advicePrompt',
        name: 'Tool Advice (P1)',
        content: (inputs.advicePrompt || '').trim(),
        priority: 1,
        allowTruncation: false, // P1 không bao giờ bị cắt
      },
      {
        key: 'reflectionContext',
        name: 'Dynamic Reflection (P1.1)',
        content: (inputs.reflectionContext || '').trim(),
        priority: 1.1,
        allowTruncation: false, // P1.1 Phản tư lỗi không bao giờ bị cắt
      },
      {
        key: 'cognitiveScaffold',
        name: 'Cognitive Task Scaffold (P1.2)',
        content: (inputs.cognitiveScaffold || '').trim(),
        priority: 1.2,
        allowTruncation: false, // P1.2 Khung lập luận System 2 không bao giờ bị cắt
      },
      {
        key: 'phaseGuidance',
        name: 'Phase Guidance (P1.5)',
        content: (inputs.phaseGuidance || '').trim(),
        priority: 1.5,
        allowTruncation: false, // P1.5 chỉ dẫn pha không bao giờ bị cắt
      },
      {
        key: 'rawPlanContext',
        name: 'Active Plan DAG (P2)',
        content: (inputs.rawPlanContext || '').trim(),
        priority: 2,
        allowTruncation: false, // P2 chứa Acceptance Criteria quan trọng của task, không bị cắt tỉa
      },
      {
        key: 'recalledTurnContext',
        name: 'Selective Re-injection (P3)',
        content: (inputs.recalledTurnContext || '').trim(),
        priority: 3,
        allowTruncation: true,
        minPreserveLines: 4,
      },
      {
        key: 'memoryPrompt',
        name: 'Project Memory (P4)',
        content: (inputs.memoryPrompt || '').trim(),
        priority: 4,
        allowTruncation: true,
        minPreserveLines: 2,
      },
      {
        key: 'composeContext',
        name: 'Compose State (P5)',
        content: (inputs.composeContext || '').trim(),
        priority: 5,
        allowTruncation: true,
        minPreserveLines: 2,
      },
      {
        key: 'repositoryMemoryContext',
        name: 'Repository Memory (P6)',
        content: (inputs.repositoryMemoryContext || '').trim(),
        priority: 6,
        allowTruncation: true,
        minPreserveLines: 3,
      },
      {
        key: 'repositoryContext',
        name: 'Graph Repository Map (P7)',
        content: (inputs.repositoryContext || '').trim(),
        priority: 7,
        allowTruncation: true, // P7 luôn là đối tượng cắt tỉa đầu tiên
        minPreserveLines: 2,
      },
    ];

    // Phase 4 Adaptive Failure Budgeting: Khi có lỗi liên tiếp, dọn dẹp các nguồn nền để LLM tập trung vào lỗi
    const isUnderFailurePressure = Boolean(optObj?.consecutiveFailures && optObj.consecutiveFailures >= 2);
    if (isUnderFailurePressure) {
      for (const s of rawSources) {
        if (['composeContext', 'repositoryMemoryContext', 'repositoryContext'].includes(s.key)) {
          s.minPreserveLines = 0;
        }
      }
    }

    const rankedSources: RankedSource[] = rawSources.filter((s) => s.content.length > 0);

    // 2. Khử trùng lặp chéo giữa các tầng trí nhớ nếu bật
    if (enableDedup) {
      this.deduplicateSources(rankedSources);
    }

    // 3. Tính toán tổng token ban đầu
    let beforeTokens = 0;
    const sourceTokenCosts = new Map<keyof DynamicContextInputs, number>();
    for (const source of rankedSources) {
      const cost = ExactTokenizer.countTokens(source.content, modelName);
      sourceTokenCosts.set(source.key, cost);
      beforeTokens += cost;
    }

    // Nếu tổng token ban đầu đã nằm trong ngân sách cho phép
    if (beforeTokens <= budgetTokens) {
      const rendered = rankedSources.map((s) => s.content).join('\n\n');
      return {
        renderedContext: rendered,
        totalTokens: beforeTokens,
        budgetTokens,
        sourcesIncluded: rankedSources.map((s) => s.name),
        sourcesPruned: [],
        sourcesTruncated: [],
        stats: {
          beforeTokens,
          afterTokens: beforeTokens,
          tokensSaved: 0,
        },
      };
    }

    // 4. Cắt tỉa theo thứ tự ưu tiên ngược (từ P7 lên P1)
    const included = new Map<keyof DynamicContextInputs, string>();
    const sourcesPruned: string[] = [];
    const sourcesTruncated: string[] = [];

    // Khởi tạo tất cả nguồn vào danh sách dự kiến
    for (const source of rankedSources) {
      included.set(source.key, source.content);
    }

    let currentTotalTokens = beforeTokens;

    // Duyệt ngược từ P7 -> P2 (bảo vệ P1 và P1.5 tuyệt đối)
    for (let i = rankedSources.length - 1; i >= 0; i--) {
      if (currentTotalTokens <= budgetTokens) break;

      const source = rankedSources[i];
      if (source.priority <= 1.5) break; // P1 và P1.5 là bất khả xâm phạm

      const originalCost = sourceTokenCosts.get(source.key) || 0;
      const tokensNeededToSave = currentTotalTokens - budgetTokens;

      if (!source.allowTruncation || originalCost <= tokensNeededToSave) {
        // Loại bỏ hoàn toàn nguồn này
        included.delete(source.key);
        currentTotalTokens -= originalCost;
        sourcesPruned.push(source.name);
      } else {
        // Cắt tỉa từng phần theo ranh giới dòng
        const targetTokens = originalCost - tokensNeededToSave;
        const truncated = this.truncateToTokenBudget(
          source.content,
          Math.max(30, targetTokens),
          modelName,
          source.minPreserveLines ?? 2,
        );

        const newCost = ExactTokenizer.countTokens(truncated, modelName);
        included.set(source.key, truncated);
        currentTotalTokens -= (originalCost - newCost);
        sourcesTruncated.push(source.name);
        break; // Đã đạt được mức ngân sách cần thiết
      }
    }

    // 5. Kết xuất chuỗi context hoàn chỉnh theo thứ tự ưu tiên ban đầu
    const finalSources: string[] = [];
    for (const source of rankedSources) {
      const content = included.get(source.key);
      if (content && content.trim().length > 0) {
        finalSources.push(content);
      }
    }

    const renderedContext = finalSources.join('\n\n');
    const afterTokens = ExactTokenizer.countTokens(renderedContext, modelName);

    return {
      renderedContext,
      totalTokens: afterTokens,
      budgetTokens,
      sourcesIncluded: rankedSources
        .filter((s) => included.has(s.key))
        .map((s) => s.name),
      sourcesPruned,
      sourcesTruncated,
      stats: {
        beforeTokens,
        afterTokens,
        tokensSaved: Math.max(0, beforeTokens - afterTokens),
      },
    };
  }

  /**
   * Khử trùng lặp chéo giữa các tầng trí nhớ:
   * Nếu các insight trong Project Memory (P4) hoặc Re-injected Turns (P3) đã đề cập đến các statement
   * của Repository Memory (P6), ta lọc bớt các dòng trùng lặp trong P6 để tránh lãng phí context.
   */
  private deduplicateSources(sources: RankedSource[]): void {
    const higherPriorityTexts: string[] = [];
    for (const source of sources) {
      if (source.priority < 6) {
        higherPriorityTexts.push(source.content.toLowerCase());
      }
    }

    if (higherPriorityTexts.length === 0) return;

    const repoMemSource = sources.find((s) => s.key === 'repositoryMemoryContext');
    if (repoMemSource && repoMemSource.content) {
      const lines = repoMemSource.content.split('\n');
      const filteredLines = lines.filter((line) => {
        const trimmed = line.trim().toLowerCase();
        if (trimmed.length < 25) return true; // Giữ lại tiêu đề / định dạng
        // Kiểm tra xem nội dung chính có bị lặp lại trong các tầng trí nhớ trên không
        return !higherPriorityTexts.some((highText) => highText.includes(trimmed));
      });
      repoMemSource.content = filteredLines.join('\n').trim();
    }
  }

  /**
   * Cắt tỉa văn bản theo ranh giới dòng (Clean line-boundary truncation)
   */
  private truncateToTokenBudget(
    text: string,
    targetTokens: number,
    modelName: string,
    minPreserveLines: number,
  ): string {
    const lines = text.split('\n');
    if (lines.length <= minPreserveLines) return text;

    let low = minPreserveLines;
    let high = lines.length;
    let bestCut = minPreserveLines;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = lines.slice(0, mid).join('\n') + '\n[... truncated by Dynamic Context Arbiter ...]';
      const tokens = ExactTokenizer.countTokens(candidate, modelName);

      if (tokens <= targetTokens) {
        bestCut = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return lines.slice(0, bestCut).join('\n') + '\n[... truncated by Dynamic Context Arbiter ...]';
  }
}
