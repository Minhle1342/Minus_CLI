import { isReadOnlyRequest, normalizeRequestIntentText, MUTATION_INTENT } from './request-intent.js';

export type SemanticRouteName = 'read_only' | 'mutation' | 'planning';

export interface SemanticRouteResult {
  route: SemanticRouteName;
  score: number;
  confidence: number;
  matchedExemplar?: string;
  source: 'fast_path' | 'embedding' | 'fallback_heuristic';
}

export interface SemanticRouterOptions {
  similarityThreshold?: number;
  modelName?: string;
  enableFastPath?: boolean;
}

export interface RouteExemplarItem {
  text: string;
  vector: number[];
}

const DEFAULT_EXEMPLARS: Record<SemanticRouteName, string[]> = {
  read_only: [
    // English
    'Explain how this component works',
    'Explain the parser logic',
    'Describe the execution flow of the system',
    'Review the architecture and code structure',
    'Inspect logs to investigate the root cause',
    'Show me how this function behaves',
    'Why does this error occur in production',
    'What does this module do',
    'Analyze performance bottlenecks in the codebase',
    'Check git status and explain the diff',
    'Find references to this interface',
    'Suggest possible approaches to optimize memory',
    'Review this function, do not edit code',
    'Read-only inspection of the repository',
    // Vietnamese
    'Giải thích cách hoạt động của parser',
    'Mô tả kiến trúc và luồng xử lý của hệ thống',
    'Kiểm tra nguyên nhân để báo cáo kết quả',
    'Khảo sát hiện trạng hệ thống',
    'Đề xuất các điểm cải tiến',
    'Kiểm tra các điểm cần cải tiến',
    'Xem xét và phân tích lỗi này',
    'Khảo sát để tìm hiểu nguyên nhân sự cố',
    'Cho biết thông tin và ý nghĩa của file cấu hình',
    'Chỉ đọc và giải thích cách chạy test',
    'Đánh giá hiệu năng và bảo mật của code',
    'Tìm hiểu cách hệ thống vận hành',
  ],
  mutation: [
    // English
    'Fix the null pointer bug in parser',
    'Fix syntax error in auth.ts',
    'Implement the proposed authentication feature',
    'Refactor this function to improve performance',
    'Add unit tests for error handling',
    'Update database connection configuration',
    'Delete deprecated test files and folders',
    'Patch memory leak in socket connection',
    'Create a new component for user profile',
    'Modify the request handler logic',
    'Inspect in order to fix the bug',
    'Review so as to improve performance',
    'Inspect and edit this file',
    // Vietnamese
    'Sửa lỗi deadlock trong worker',
    'Sửa lỗi cú pháp trong file auth.ts',
    'Cải tiến hàm xử lý dữ liệu',
    'Thực thi kế hoạch refactor',
    'Viết code cho trang đăng nhập',
    'Cập nhật tài liệu và sửa mã nguồn',
    'Khắc phục sự cố ngắt kết nối database',
    'Tối ưu hóa hiệu năng thuật toán tìm kiếm',
    'Nâng cấp thư viện và chỉnh sửa file cấu hình',
    'Kiểm tra để cải tiến Tool guidance',
    'Khảo sát nhằm cải tiến hàm này',
    'Kiểm tra, cải tiến code',
    'Kiểm tra; sửa lỗi deadlock',
    'Kiểm tra đồng thời tối ưu hóa performance',
    'Kiểm tra cũng như cập nhật tài liệu',
  ],
  planning: [
    // English
    '/plan',
    'Create an implementation plan',
    'Make a step-by-step migration plan',
    'Break down this feature into distinct tasks',
    'Plan the architecture refactoring roadmap',
    // Vietnamese
    'Lập kế hoạch thực hiện tính năng',
    'Lên kế hoạch cải tiến hệ thống',
    'Phân chia công việc thành các task nhỏ',
    'Lập lộ trình nâng cấp kiến trúc',
  ],
};

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Local Semantic Router for fast, offline intent classification using vector embeddings.
 * Backed by FastEmbed (ONNX) with deterministic fast-path and graceful heuristic fallback.
 */
export class SemanticRouter {
  private static instance: SemanticRouter | null = null;
  private embeddingModel: any = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private routeEmbeddings: Map<SemanticRouteName, RouteExemplarItem[]> = new Map();
  private routeCentroids: Map<SemanticRouteName, number[]> = new Map();
  private cache: Map<string, SemanticRouteResult> = new Map();
  private readonly threshold: number;
  private readonly enableFastPath: boolean;

  constructor(options?: SemanticRouterOptions) {
    this.threshold = options?.similarityThreshold ?? 0.65;
    this.enableFastPath = options?.enableFastPath ?? true;
  }

  public static getInstance(options?: SemanticRouterOptions): SemanticRouter {
    if (!SemanticRouter.instance) {
      SemanticRouter.instance = new SemanticRouter(options);
    }
    return SemanticRouter.instance;
  }

  public isReady(): boolean {
    return this.isInitialized && this.embeddingModel !== null;
  }

  /**
   * Initializes the embedding model and pre-computes route exemplar embeddings and centroids.
   */
  public async init(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const fastembed = await import('fastembed');
        const { FlagEmbedding, EmbeddingModel } = fastembed;
        this.embeddingModel = await FlagEmbedding.init({
          model: EmbeddingModel.BGESmallENV15,
        });

        for (const [routeName, exemplars] of Object.entries(DEFAULT_EXEMPLARS) as [SemanticRouteName, string[]][]) {
          const iterator = await this.embeddingModel.embed(exemplars);
          const vectors: number[][] = [];
          for await (const batch of iterator) {
            vectors.push(...batch);
          }

          const items: RouteExemplarItem[] = exemplars.map((text, idx) => ({
            text,
            vector: vectors[idx],
          }));
          this.routeEmbeddings.set(routeName, items);

          // Compute normalized centroid
          if (vectors.length > 0) {
            const dim = vectors[0].length;
            const centroid = new Array(dim).fill(0);
            for (const vec of vectors) {
              for (let i = 0; i < dim; i++) {
                centroid[i] += vec[i] / vectors.length;
              }
            }
            this.routeCentroids.set(routeName, centroid);
          }
        }

        this.isInitialized = true;
      } catch {
        // Gracefully set as uninitialized so calls fall back to fast-path / heuristic
        this.isInitialized = false;
        this.embeddingModel = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Fast-path deterministic evaluation for explicit slash commands, flags, or explicit overrides.
   */
  public fastPath(query: string): SemanticRouteResult | null {
    if (!this.enableFastPath || !query) return null;
    const normalized = normalizeRequestIntentText(query);

    // 1. Explicit planning markers
    if (/(?:^|\s)\/plan(?:\s|$)|\[planning mode request\]|lap\s+ke\s*hoach|phan\s+ra\s+(?:task|tac\s+vu)/i.test(normalized)) {
      return { route: 'planning', score: 1.0, confidence: 1.0, source: 'fast_path' };
    }

    // 2. Explicit read-only markers
    if (/\b(?:read[ -]only|chi doc|khong (?:sua|chinh sua|thay doi) (?:code|ma|file)|do not (?:edit|modify|change)|don['’]t (?:edit|modify|change))\b/.test(normalized)) {
      return { route: 'read_only', score: 1.0, confidence: 1.0, source: 'fast_path' };
    }

    // 3. Explicit review/inspection tools prefix
    if (/^\s*(?:\/(?:bug-hunter|open-code-review|code-reviewer)\b)/i.test(query)) {
      if (isReadOnlyRequest(query)) {
        return { route: 'read_only', score: 0.95, confidence: 0.95, source: 'fast_path' };
      }
    }

    return null;
  }

  /**
   * Fallback heuristic rule routing when embeddings are unavailable.
   */
  public fallbackRoute(query: string): SemanticRouteResult {
    const fast = this.fastPath(query);
    if (fast) return fast;

    const normalized = normalizeRequestIntentText(query);
    if (isReadOnlyRequest(query)) {
      return { route: 'read_only', score: 0.85, confidence: 0.85, source: 'fallback_heuristic' };
    }

    if (MUTATION_INTENT.test(normalized)) {
      return { route: 'mutation', score: 0.85, confidence: 0.85, source: 'fallback_heuristic' };
    }

    return { route: 'read_only', score: 0.5, confidence: 0.5, source: 'fallback_heuristic' };
  }

  /**
   * Route user request asynchronously using FastEmbed vector similarity.
   */
  public async routeAsync(query: string): Promise<SemanticRouteResult> {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return { route: 'read_only', score: 1.0, confidence: 1.0, source: 'fast_path' };
    }

    const trimmed = query.trim();
    if (this.cache.has(trimmed)) {
      return this.cache.get(trimmed)!;
    }

    const fast = this.fastPath(trimmed);
    if (fast) {
      this.cache.set(trimmed, fast);
      return fast;
    }

    if (!this.isReady()) {
      await this.init();
    }

    if (!this.isReady()) {
      const fallback = this.fallbackRoute(trimmed);
      this.cache.set(trimmed, fallback);
      return fallback;
    }

    try {
      const iterator = await this.embeddingModel.embed([trimmed]);
      let queryVector: number[] | null = null;
      for await (const batch of iterator) {
        if (batch.length > 0) {
          queryVector = batch[0];
          break;
        }
      }

      if (!queryVector) {
        const fallback = this.fallbackRoute(trimmed);
        this.cache.set(trimmed, fallback);
        return fallback;
      }

      let bestRoute: SemanticRouteName = 'read_only';
      let maxScore = -1;
      let matchedExemplar: string | undefined;

      // Evaluate 1-NN similarity against all exemplars
      for (const [routeName, items] of this.routeEmbeddings.entries()) {
        for (const item of items) {
          const sim = cosineSimilarity(queryVector, item.vector);
          if (sim > maxScore) {
            maxScore = sim;
            bestRoute = routeName;
            matchedExemplar = item.text;
          }
        }
      }

      // If highest similarity is below threshold, fall back to heuristic
      if (maxScore < this.threshold) {
        const fallback = this.fallbackRoute(trimmed);
        this.cache.set(trimmed, fallback);
        return fallback;
      }

      const result: SemanticRouteResult = {
        route: bestRoute,
        score: maxScore,
        confidence: Math.min(1.0, maxScore),
        matchedExemplar,
        source: 'embedding',
      };

      this.cache.set(trimmed, result);
      return result;
    } catch {
      const fallback = this.fallbackRoute(trimmed);
      this.cache.set(trimmed, fallback);
      return fallback;
    }
  }

  /**
   * Synchronous routing using cached embeddings, fast-path, or heuristic fallback.
   */
  public routeSync(query: string): SemanticRouteResult {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return { route: 'read_only', score: 1.0, confidence: 1.0, source: 'fast_path' };
    }
    const trimmed = query.trim();
    if (this.cache.has(trimmed)) {
      return this.cache.get(trimmed)!;
    }

    const fast = this.fastPath(trimmed);
    if (fast) {
      this.cache.set(trimmed, fast);
      return fast;
    }

    const fallback = this.fallbackRoute(trimmed);
    this.cache.set(trimmed, fallback);
    return fallback;
  }

  /**
   * Evaluates whether a query is read-only using the semantic router.
   */
  public async isReadOnly(query: string): Promise<boolean> {
    const decision = await this.routeAsync(query);
    return decision.route === 'read_only';
  }

  /**
   * Synchronous check for read-only intent.
   */
  public isReadOnlySync(query: string): boolean {
    const decision = this.routeSync(query);
    return decision.route === 'read_only';
  }
}
