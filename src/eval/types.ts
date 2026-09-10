/**
 * Kiểu dữ liệu chuẩn cho Evaluation & Benchmarking Pipeline của Coding Agent
 */

export type TaskDifficulty = 'easy' | 'medium' | 'hard' | 'extreme';

export type BenchmarkTaskCategory =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'resilience'
  | 'security'
  | 'hallucination'
  | 'context';

export interface BenchmarkTaskFile {
  path: string;
  content: string;
}

export interface VerificationContext {
  workspaceDir: string;
  filesModified: string[];
  durationMs: number;
}

export interface BenchmarkTask {
  /** Mã định danh duy nhất của task (vd: 'task-bugfix-math-edge') */
  id: string;
  /** Tiêu đề ngắn gọn */
  title: string;
  /** Mô tả chi tiết mục tiêu của bài toán */
  description: string;
  /** Phân loại bài toán */
  category: BenchmarkTaskCategory;
  /** Độ khó */
  difficulty: TaskDifficulty;
  /** Yêu cầu prompt gửi cho Agent */
  prompt: string;
  /** Danh sách các file khởi tạo trong workspace ảo */
  initialFiles: BenchmarkTaskFile[];
  /** Lệnh kiểm chứng độc lập (vd: 'npm test' hoặc 'node verify.js') */
  verifyCommand?: string;
  /** Hàm kiểm chứng tùy biến độc lập bằng JavaScript/TypeScript */
  verifyFn?: (ctx: VerificationContext) => Promise<{ success: boolean; message?: string }>;
  /** Số step tối đa cho phép cho bài toán này (mặc định: 15) */
  maxSteps?: number;
  /** Thời gian timeout cho phép tính bằng ms (mặc định: 120,000ms = 2 phút) */
  timeoutMs?: number;
  /** Skip the mutation-oriented plan bootstrap for analysis/status tasks. */
  readOnly?: boolean;
}

export interface TaskTokenMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
}

export interface TaskExecutionMetrics {
  durationMs: number;
  /** Wall time from immediately before AgentLoop.run() until its final answer settles. */
  timeToFinalAnswerMs: number;
  /** Sum of provider request durations recorded by the agent loop. */
  totalModelRequestTimeMs: number;
  ttftP50Ms: number;
  ttftP95Ms: number;
  stepsTaken: number;
  toolCallsCount: number;
  toolCallBreakdown: Record<string, number>;
  guardianInterventionsCount: number;
  tokens: TaskTokenMetrics;
  estimatedCostUsd?: number;
  promptGating?: {
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    conservativeFallbacks: number;
  };
}

export type EvaluationStatus = 'PASSED' | 'FAILED' | 'TIMED_OUT' | 'ERROR';

export interface TaskEvaluationResult {
  taskId: string;
  taskTitle: string;
  category: BenchmarkTaskCategory;
  difficulty: TaskDifficulty;
  status: EvaluationStatus;
  metrics: TaskExecutionMetrics;
  verificationMessage?: string;
  errorDetails?: string;
  finalAnswer?: string;
}

export interface BenchmarkSuiteReport {
  timestamp: string;
  modelName: string;
  sandboxMode: string;
  totalTasks: number;
  passedTasks: number;
  failedTasks: number;
  timedOutTasks: number;
  errorTasks: number;
  passRatePercent: number;
  averageSteps: number;
  averageDurationMs: number;
  averageTimeToFinalAnswerMs: number;
  totalModelRequestTimeMs: number;
  ttftP50Ms: number;
  ttftP95Ms: number;
  totalTokens: number;
  totalCostUsd?: number;
  guardianViolationRate: number;
  taskResults: TaskEvaluationResult[];
}

export interface BenchmarkRunnerOptions {
  /** Lọc các task theo ID hoặc category */
  taskFilter?: string;
  /** Model LLM để chạy (mặc định theo biến môi trường hoặc mock) */
  modelName?: string;
  /** Sử dụng Mock LLM thay vì live API (Zero API cost) */
  mockMode?: boolean;
  /** Fail instead of silently substituting MockLLM when live credentials are unavailable. */
  requireLiveModel?: boolean;
  /** Per-step prompt rollout mode used by AgentLoop. */
  stepPromptGatingMode?: 'off' | 'shadow' | 'enforce';
  /** Chế độ sandbox: 'local' | 'docker' */
  sandboxMode?: 'local' | 'docker';
  /** Giữ lại thư mục workspace sau khi chạy (để debug) */
  keepWorkspaces?: boolean;
  /** Thư mục gốc chứa sandbox tạm */
  sandboxBaseDir?: string;
  /** Xuất báo cáo ra file (JSON hoặc Markdown) */
  outputPath?: string;
  /** Callback cập nhật tiến độ cho UI */
  onProgress?: (event: {
    type: 'task_start' | 'task_step' | 'task_finish' | 'suite_finish';
    taskId?: string;
    step?: number;
    result?: TaskEvaluationResult;
    report?: BenchmarkSuiteReport;
  }) => void;
}
