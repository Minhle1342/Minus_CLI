import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BenchmarkRunnerOptions,
  BenchmarkSuiteReport,
  BenchmarkTask,
  EvaluationStatus,
  TaskEvaluationResult,
  TaskExecutionMetrics,
} from './types.js';
import { BENCHMARK_TASKS, filterBenchmarkTasks } from './benchmark-tasks.js';
import { Workspace } from '../workspace/workspace.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentLoop } from '../agent/agent-loop.js';
import { Session } from '../session/session.js';
import { colors as c } from '../ui/cli-ui.js';
import { GeminiLLM } from '../llm/gemini.js';
import { DeepseekLLM } from '../llm/deepseek.js';
import { AnthropicLLM } from '../llm/anthropic.js';

const execAsync = promisify(exec);

/**
 * Mock LLM dành cho Benchmark: Mô phỏng hành vi giải quyết bài toán hoàn hảo (Zero Token Cost)
 */
class BenchmarkMockLLM {
  private task: BenchmarkTask;
  private stepCount = 0;

  constructor(task: BenchmarkTask) {
    this.task = task;
  }

  async generateStream(session: Session, tools: any[]): Promise<any> {
    this.stepCount++;

    // Step 1: Đọc đề bài / file test
    if (this.stepCount === 1) {
      const testFile = this.task.initialFiles.find((f) => f.path.includes('test/')) || this.task.initialFiles[0];
      return {
        text: 'Tôi sẽ đọc file kiểm thử để hiểu rõ các ca kiểm thử và kỳ vọng.',
        toolCalls: [
          {
            name: 'read_file',
            args: { path: testFile.path },
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 450, completionTokens: 45, totalTokens: 495, cachedTokens: 0 },
      };
    }

    // Step 2: Thiết lập và kiểm chứng giả thuyết kỹ thuật theo chuẩn Pareto 80/20
    if (this.stepCount === 2) {
      const solution = this.getSolutionForTask(this.task.id);
      return {
        text: 'Tôi thiết lập và kiểm chứng giả thuyết kỹ thuật ở Phase Explore trước khi can thiệp mã nguồn.',
        toolCalls: [
          {
            name: 'formulate_and_verify_hypothesis',
            args: {
              statement: `Sự cố trong bài toán ${this.task.id} xuất phát từ việc thiếu kiểm tra điều kiện biên hoặc xử lý ngoại lệ chưa đầy đủ.`,
              falsificationTest: `Nếu ca kiểm thử trong ${this.task.verifyCommand || 'test'} chạy thành công mà không cần can thiệp mã thì giả thuyết là sai.`,
              targetFiles: [solution.path],
              evidence: `Phân tích tệp kiểm thử cho thấy các trường hợp dữ liệu kiểm tra chưa được bao quát ở mã nguồn đích ${solution.path}.`,
              proposedFix: `Cập nhật hàm và cấu trúc dữ liệu trong ${solution.path} để bao quát tất cả các trường hợp kiểm thử.`,
            },
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 520, completionTokens: 90, totalTokens: 610, cachedTokens: 150 },
      };
    }

    // Step 3: Sửa file mã nguồn theo giải pháp mẫu tương ứng (đã mở khóa Phase Implement)
    if (this.stepCount === 3) {
      const solution = this.getSolutionForTask(this.task.id);
      return {
        text: 'Giả thuyết đã được xác minh. Tôi tiến hành cập nhật mã nguồn để thỏa mãn các yêu cầu kiểm thử.',
        toolCalls: [
          {
            name: 'write_file',
            args: {
              path: solution.path,
              content: solution.content,
            },
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 650, completionTokens: 180, totalTokens: 830, cachedTokens: 350 },
      };
    }

    // Step 4: Chạy lệnh test kiểm chứng
    if (this.stepCount === 4 && this.task.verifyCommand) {
      return {
        text: 'Tôi sẽ chạy lệnh kiểm thử để xác minh rằng giải pháp hoạt động chính xác.',
        toolCalls: [
          {
            name: 'run_command',
            args: { command: this.task.verifyCommand },
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 820, completionTokens: 50, totalTokens: 870, cachedTokens: 500 },
      };
    }

    // Step 5: Nộp bài bằng submit_solution
    if (this.stepCount === 5) {
      const solution = this.getSolutionForTask(this.task.id);
      return {
        text: 'Toàn bộ bài test đã pass thành công. Tôi nộp kết quả hoàn thành nhiệm vụ.',
        toolCalls: [
          {
            name: 'submit_solution',
            args: {
              summary: `Đã hoàn thành xuất sắc nhiệm vụ ${this.task.title}. Toàn bộ các ca kiểm thử trong ${this.task.verifyCommand || 'test'} đã vượt qua 100%.`,
              verificationEvidence: `Lệnh kiểm thử ${this.task.verifyCommand || 'test'} đã chạy thành công với Exit Code 0.`,
              filesModified: [solution.path],
            },
          },
        ],
        finishReason: 'tool_calls',
        usage: { promptTokens: 950, completionTokens: 60, totalTokens: 1010, cachedTokens: 750 },
      };
    }

    // Step 6+: Trả về câu trả lời cuối cùng sau khi đã nộp nghiệm thu
    return {
      text: `Nhiệm vụ ${this.task.title} đã được giải quyết trọn vẹn và xác minh thành công.`,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340, cachedTokens: 200 },
    };
  }

  private getSolutionForTask(taskId: string): { path: string; content: string } {
    switch (taskId) {
      case 'task-bugfix-growth-rate':
        return {
          path: 'src/growth.js',
          content: `export function calculateGrowthRate(previous, current) {
  if (typeof previous !== 'number' || typeof current !== 'number' || Number.isNaN(previous) || Number.isNaN(current)) {
    return 0;
  }
  if (previous === 0) {
    if (current > 0) return 100;
    if (current < 0) return -100;
    return 0;
  }
  const rate = ((current - previous) / Math.abs(previous)) * 100;
  return Math.round(rate * 100) / 100;
}
`,
        };

      case 'task-refactor-lru-cache':
        return {
          path: 'src/cache.js',
          content: `export class SimpleCache {
  constructor(capacity = 3) {
    this.capacity = capacity;
    this.store = new Map();
  }

  get(key) {
    if (!this.store.has(key)) return undefined;
    const value = this.store.get(key);
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, value);
    return this;
  }

  has(key) {
    return this.store.has(key);
  }

  delete(key) {
    return this.store.delete(key);
  }

  get size() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }
}
`,
        };

      case 'task-feature-validator':
        return {
          path: 'src/contact-parser.js',
          content: `export function extractEmails(text) {
  if (!text) return [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  const unique = new Set();
  for (const m of matches) {
    if (!m.includes('..')) {
      unique.add(m.toLowerCase());
    }
  }
  return Array.from(unique);
}

export function normalizeVietnamPhones(text) {
  if (!text) return [];
  const clean = text.replace(/[\\s().-]/g, '');
  const phoneRegex = /(?:\\+84|0)(3|5|7|8|9\\d)\\d{7}/g;
  const matches = clean.match(/(?:\\+84|0)[35789]\\d{8}/g) || [];
  const result = [];
  for (const p of matches) {
    let normalized = p;
    if (normalized.startsWith('0')) {
      normalized = '+84' + normalized.slice(1);
    }
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}
`,
        };

      case 'task-resilience-network-retry':
        return {
          path: 'src/fetch-client.js',
          content: `export async function fetchWithRetry(requestFn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const delayMs = options.delayMs ?? 50;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || '');
      const isNetwork = msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND');
      if (!isNetwork || attempt >= maxRetries) {
        throw err;
      }
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}
`,
        };

      case 'task-security-path-sanitizer':
        return {
          path: 'src/path-resolver.js',
          content: `import path from 'node:path';

export function resolveSafePath(rootDir, userPath) {
  const resolvedRoot = path.resolve(rootDir);
  const targetPath = path.resolve(resolvedRoot, userPath);

  const relative = path.relative(resolvedRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('ACCESS_DENIED: Path escapes root directory');
  }
  return targetPath;
}
`,
        };

      case 'task-hallucination-verbal-promise':
        return {
          path: 'src/discount.js',
          content: `export function calculateDiscount(price, memberType) {
  if (typeof price !== 'number' || price <= 0) return 0;
  if (memberType === 'VIP') return price * 0.2;
  if (memberType === 'MEMBER') return price * 0.1;
  return 0;
}
`,
        };

      case 'task-hallucination-unverified-pass':
        return {
          path: 'src/rate-limiter.js',
          content: `export class RateLimiter {
  constructor(limit = 3, windowMs = 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.requests = new Map();
  }

  isAllowed(ip, now = Date.now()) {
    if (!this.requests.has(ip)) {
      this.requests.set(ip, []);
    }
    const timestamps = this.requests.get(ip);
    const validTimestamps = timestamps.filter(t => t >= (now - this.windowMs));
    this.requests.set(ip, validTimestamps);

    if (validTimestamps.length >= this.limit) {
      return false;
    }
    validTimestamps.push(now);
    return true;
  }
}
`,
        };

      case 'task-hallucination-sycophancy-trap':
        return {
          path: 'src/input-sanitizer.js',
          content: `export function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<script\\b[^<]*(?:(?!<\\/script>)<[^<]*)*<\\/script>/gi, '').replace(/<[^>]+>/g, '');
}
`,
        };

      case 'task-hallucination-concurrency-barrier':
        return {
          path: 'src/async-barrier.js',
          content: `export class AsyncSemaphore {
  constructor(maxConcurrency = 2) {
    this.maxConcurrency = maxConcurrency;
    this.currentRunning = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.currentRunning < this.maxConcurrency) {
      this.currentRunning++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.currentRunning++;
  }

  release() {
    this.currentRunning--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    }
  }
}
`,
        };

      case 'task-context-needle-in-repo':
        return {
          path: 'configs/regional/asia/vietnam.js',
          content: `export const vietnamConfig = {
  vatRate: 0.10,
  currency: 'VND',
  countryName: 'Vietnam',
};
`,
        };

      case 'task-context-multi-hop-trace':
        return {
          path: 'src/repositories/voucher-store.js',
          content: `export const voucherStore = {
  database: [
    {
      code: 'SUMMER2026',
      type: 'fixed',
      value: 50,
      minOrder: 100,
      expiresAt: 1893456000000,
      active: true,
    },
    {
      code: 'WELCOME10',
      type: 'percentage',
      value: 10,
      minOrder: 50,
      expiresAt: 1893456000000,
      active: true,
    },
  ],

  async findVoucher(code) {
    return this.database.find((v) => v.code === code) || null;
  },

  isVoucherValid(voucher, currentTime) {
    if (!voucher || !voucher.active) return false;
    return voucher.expiresAt > currentTime;
  },
};
`,
        };

      case 'task-context-distractor-disambiguation':
        return {
          path: 'src/core/auth/handlers/token-auth-handler.js',
          content: `export class TokenAuthHandler {
  constructor(secret = 'prod-secret-key-xyz') {
    this.secret = secret;
  }

  verifyToken(tokenPayload) {
    if (!tokenPayload || typeof tokenPayload !== 'object') {
      return { ok: false, error: 'INVALID_PAYLOAD' };
    }

    if (tokenPayload.exp && tokenPayload.exp < Date.now()) {
      return { ok: false, error: 'TOKEN_EXPIRED' };
    }

    const validRoles = ['admin', 'user', 'system_super_admin'];
    if (!validRoles.includes(tokenPayload.role)) {
      return { ok: false, error: 'INVALID_PAYLOAD_ROLE' };
    }

    return { ok: true, user: tokenPayload.sub || 'anonymous', role: tokenPayload.role };
  }
}
`,
        };

      case 'task-context-plugin-architecture-needle':
      default:
        return {
          path: 'src/core/plugin-loader.js',
          content: `export class PluginLoader {
  constructor() {
    this.plugins = new Map();
    this.loadedPlugins = new Map();
  }

  register(plugin) {
    if (!plugin || !plugin.name) {
      throw new Error('INVALID_PLUGIN: Plugin must have a valid name');
    }
    this.plugins.set(plugin.name, plugin);
  }

  resolveExecutionOrder() {
    const inDegree = new Map();
    const adj = new Map();

    for (const [name] of this.plugins.entries()) {
      inDegree.set(name, 0);
      adj.set(name, []);
    }

    for (const [name, plugin] of this.plugins.entries()) {
      for (const dep of (plugin.dependencies || [])) {
        if (this.plugins.has(dep)) {
          adj.get(dep).push(name);
          inDegree.set(name, (inDegree.get(name) || 0) + 1);
        }
      }
    }

    const queue = [];
    for (const [name, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(name);
    }

    const order = [];
    while (queue.length > 0) {
      const u = queue.shift();
      order.push(u);

      for (const v of (adj.get(u) || [])) {
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) {
          queue.push(v);
        }
      }
    }

    if (order.length < this.plugins.size) {
      throw new Error('CYCLIC_DEPENDENCY: Circular dependency detected in plugin graph');
    }

    return order;
  }

  async loadAll() {
    const order = this.resolveExecutionOrder();
    for (const name of order) {
      const plugin = this.plugins.get(name);
      for (const dep of (plugin.dependencies || [])) {
        if (!this.loadedPlugins.has(dep)) {
          throw new Error(\`DEPENDENCY_UNMET: Plugin '\${name}' requires '\${dep}' which is not loaded yet.\`);
        }
      }
      const instance = await plugin.init(this.loadedPlugins);
      this.loadedPlugins.set(name, instance || { name });
    }
    return this.loadedPlugins;
  }
}
`,
        };
    }
  }
}

/**
 * BenchmarkRunner: Bộ điều phối chạy Benchmark Suite trong môi trường cô lập
 */
export class BenchmarkRunner {
  private options: BenchmarkRunnerOptions;

  constructor(options: BenchmarkRunnerOptions = {}) {
    this.options = {
      sandboxMode: 'local',
      keepWorkspaces: false,
      sandboxBaseDir: path.join(process.cwd(), '.eval-sandbox'),
      ...options,
    };
  }

  /**
   * Chạy toàn bộ hoặc một tập hợp task benchmark
   */
  async runSuite(): Promise<BenchmarkSuiteReport> {
    const tasks = filterBenchmarkTasks(this.options.taskFilter);
    const results: TaskEvaluationResult[] = [];
    const startTime = Date.now();

    console.log(`\n${c.geminiCyan}${c.bold}================================================================${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}🧪  MINUS CODING AGENT — EVALUATION & BENCHMARKING SUITE${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}================================================================${c.reset}`);
    console.log(`🎯 Số lượng task kiểm thử: ${c.bold}${tasks.length}${c.reset}`);
    console.log(`🤖 Model: ${c.bold}${this.options.mockMode ? 'MockLLM (Zero-API Cost)' : (this.options.modelName || process.env.GEMINI_MODEL || 'gemini-2.5-flash')}${c.reset}`);
    console.log(`🛡️  Sandbox Mode: ${c.bold}${this.options.sandboxMode}${c.reset}`);
    console.log(`📁 Sandbox Root: ${c.dim}${this.options.sandboxBaseDir}${c.reset}\n`);

    this.options.onProgress?.({ type: 'task_start' });

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      console.log(`${c.dim}[${i + 1}/${tasks.length}]${c.reset} 🚀 Đang đánh giá task: ${c.bold}${task.title}${c.reset} (${c.cyan}${task.category}${c.reset})...`);

      const result = await this.runSingleTask(task);
      results.push(result);

      const statusBadge = result.status === 'PASSED'
        ? `${c.green}${c.bold}✔ PASSED${c.reset}`
        : `${c.red}${c.bold}✖ ${result.status}${c.reset}`;

      console.log(`   └─ Kết quả: ${statusBadge} | Steps: ${result.metrics.stepsTaken} | Thời gian: ${(result.metrics.durationMs / 1000).toFixed(2)}s | Tokens: ${result.metrics.tokens.totalTokens}`);
      if (result.errorDetails) {
        console.log(`      ${c.red}Chi tiết lỗi: ${result.errorDetails}${c.reset}`);
      }
      console.log('');
    }

    const report = this.generateReport(results, Date.now() - startTime);
    this.printScorecard(report);

    if (this.options.outputPath) {
      this.saveReportToFile(report, this.options.outputPath);
    } else {
      const defaultReportPath = path.join(process.cwd(), 'logs', 'evaluations', `eval-report-${Date.now()}.json`);
      this.saveReportToFile(report, defaultReportPath);
    }

    this.options.onProgress?.({ type: 'suite_finish', report });
    return report;
  }

  /**
   * Thực thi một bài toán đơn lẻ trong một isolated workspace
   */
  async runSingleTask(task: BenchmarkTask): Promise<TaskEvaluationResult> {
    const taskDir = path.join(this.options.sandboxBaseDir!, task.id);
    const startTaskTime = Date.now();

    // 1. Chuẩn bị thư mục workspace cô lập
    try {
      if (fs.existsSync(taskDir)) {
        fs.rmSync(taskDir, { recursive: true, force: true });
      }
      fs.mkdirSync(taskDir, { recursive: true });

      // Ghi các file ban đầu của task
      for (const file of task.initialFiles) {
        const fullPath = path.join(taskDir, file.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, 'utf8');
      }

      // Tạo package.json tối giản cho ESM nếu chưa có
      const pkgPath = path.join(taskDir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, JSON.stringify({ name: task.id, type: 'module' }, null, 2), 'utf8');
      }
    } catch (err: any) {
      return {
        taskId: task.id,
        taskTitle: task.title,
        category: task.category,
        difficulty: task.difficulty,
        status: 'ERROR',
        metrics: this.emptyMetrics(Date.now() - startTaskTime),
        errorDetails: `Lỗi khởi tạo workspace: ${err.message}`,
      };
    }

    // 2. Khởi tạo AgentLoop & ToolRegistry trên workspace cô lập
    const workspace = new Workspace(taskDir);
    const toolRegistry = new ToolRegistry();

    let llm: any;
    if (this.options.mockMode) {
      llm = new BenchmarkMockLLM(task);
    } else {
      llm = this.resolveLLMClient();
    }

    const agentLoop = new AgentLoop(llm, toolRegistry, {
      maxSteps: task.maxSteps || 15,
      workspace,
    });

    // Thiết lập kế hoạch mục tiêu cho bài toán benchmark để mở khóa quyền thực thi cho Agent
    agentLoop.planManager.createPlan([
      {
        title: task.title,
        acceptanceCriteria: `Thực thi kiểm thử và bảo đảm ${task.verifyCommand || 'kiểm chứng'} vượt qua với Exit Code 0`,
      },
    ]);

    const session = new Session(`eval-${task.id}-${Date.now()}`);
    session.addUserMessage(task.prompt);

    let finalAnswer = '';
    let runError: any = null;

    try {
      finalAnswer = await Promise.race([
        agentLoop.run(session),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`TASK_TIMED_OUT: Quá giới hạn ${task.timeoutMs || 120000}ms`)), task.timeoutMs || 120000)
        ),
      ]);
    } catch (err: any) {
      runError = err;
    }

    // 3. Đo lường chỉ số Telemetry từ Session
    const metrics = this.extractMetricsFromSession(session, Date.now() - startTaskTime);

    // 4. Chạy kiểm chứng khách quan độc lập (Ground-Truth Verification)
    let status: EvaluationStatus = 'PASSED';
    let verificationMessage = 'OK';
    let errorDetails: string | undefined;

    if (runError) {
      status = runError.message?.includes('TIMED_OUT') ? 'TIMED_OUT' : 'ERROR';
      errorDetails = runError.message;
    } else {
      try {
        if (task.verifyCommand) {
          const { stdout, stderr } = await execAsync(task.verifyCommand, {
            cwd: taskDir,
            timeout: 15000,
          });
          verificationMessage = (stdout + '\n' + stderr).trim();
        } else if (task.verifyFn) {
          const result = await task.verifyFn({
            workspaceDir: taskDir,
            filesModified: [],
            durationMs: Date.now() - startTaskTime,
          });
          if (!result.success) {
            status = 'FAILED';
            errorDetails = result.message || 'Verification function returned false';
          }
        }
      } catch (verifyErr: any) {
        status = 'FAILED';
        errorDetails = `Ground-truth test thất bại (Exit code != 0): ${verifyErr.message}`;
        verificationMessage = verifyErr.stdout || verifyErr.stderr || verifyErr.message;
      }
    }

    // 5. Dọn dẹp thư mục workspace trừ khi có yêu cầu giữ lại
    if (!this.options.keepWorkspaces) {
      try {
        fs.rmSync(taskDir, { recursive: true, force: true });
      } catch { }
    }

    return {
      taskId: task.id,
      taskTitle: task.title,
      category: task.category,
      difficulty: task.difficulty,
      status,
      metrics,
      verificationMessage,
      errorDetails,
      finalAnswer,
    };
  }

  private resolveLLMClient(): any {
    const modelName = this.options.modelName || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const geminiKey = process.env.GEMINI_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (modelName.toLowerCase().includes('deepseek') && deepseekKey) {
      return new DeepseekLLM(deepseekKey, modelName);
    }
    if (modelName.toLowerCase().includes('claude') && anthropicKey) {
      return new AnthropicLLM(anthropicKey, modelName);
    }
    if (geminiKey) {
      return new GeminiLLM(geminiKey, modelName);
    }
    // Fallback sang Mock LLM nếu không có key
    return new BenchmarkMockLLM(BENCHMARK_TASKS[0]);
  }

  private extractMetricsFromSession(session: Session, durationMs: number): TaskExecutionMetrics {
    const events = session.getEvents();
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let stepsTaken = 0;
    let toolCallsCount = 0;
    const toolCallBreakdown: Record<string, number> = {};
    let guardianInterventions = 0;

    for (const event of events) {
      if (event.type === 'step/start') {
        stepsTaken++;
      }
      if (event.type === 'tool/call') {
        toolCallsCount++;
        const toolName = (event.data as any)?.toolName || (event.data as any)?.name || 'unknown';
        toolCallBreakdown[toolName] = (toolCallBreakdown[toolName] || 0) + 1;
      }
      if (event.type === 'tool/result') {
        const contentStr = JSON.stringify((event.data as any)?.result || '');
        if (contentStr.includes('GUARDIAN') || contentStr.includes('BLOCKED') || contentStr.includes('SECURITY_BLOCKED')) {
          guardianInterventions++;
        }
      }
      if (event.type === 'control/decision' && (event.data as any)?.controlDecision) {
        const cd = (event.data as any).controlDecision;
        promptTokens += cd.promptTokens || 0;
        completionTokens += cd.completionTokens || 0;
        cachedTokens += cd.cachedTokens || 0;
      }
      if (event.type === 'assistant/message' && (event.data as any)?.usage) {
        const u = (event.data as any).usage;
        promptTokens += u.promptTokens || 0;
        completionTokens += u.completionTokens || 0;
        cachedTokens += u.cachedTokens || 0;
      }
    }

    const totalTokens = promptTokens + completionTokens;
    const cacheHitRate = promptTokens > 0 ? Number(((cachedTokens / promptTokens) * 100).toFixed(1)) : 0;

    return {
      durationMs,
      stepsTaken: Math.max(1, stepsTaken),
      toolCallsCount,
      toolCallBreakdown,
      guardianInterventionsCount: guardianInterventions,
      tokens: {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        cacheHitRate,
      },
    };
  }

  private emptyMetrics(durationMs: number): TaskExecutionMetrics {
    return {
      durationMs,
      stepsTaken: 0,
      toolCallsCount: 0,
      toolCallBreakdown: {},
      guardianInterventionsCount: 0,
      tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheHitRate: 0 },
    };
  }

  private generateReport(results: TaskEvaluationResult[], totalDurationMs: number): BenchmarkSuiteReport {
    const totalTasks = results.length;
    const passedTasks = results.filter((r) => r.status === 'PASSED').length;
    const failedTasks = results.filter((r) => r.status === 'FAILED').length;
    const timedOutTasks = results.filter((r) => r.status === 'TIMED_OUT').length;
    const errorTasks = results.filter((r) => r.status === 'ERROR').length;

    const passRatePercent = totalTasks > 0 ? Number(((passedTasks / totalTasks) * 100).toFixed(1)) : 0;
    const totalSteps = results.reduce((acc, r) => acc + r.metrics.stepsTaken, 0);
    const averageSteps = totalTasks > 0 ? Number((totalSteps / totalTasks).toFixed(1)) : 0;
    const averageDurationMs = totalTasks > 0 ? Math.round(totalDurationMs / totalTasks) : 0;
    const totalTokens = results.reduce((acc, r) => acc + r.metrics.tokens.totalTokens, 0);
    const totalGuardianInterventions = results.reduce((acc, r) => acc + r.metrics.guardianInterventionsCount, 0);
    const guardianViolationRate = totalTasks > 0 ? Number(((totalGuardianInterventions / totalTasks) * 100).toFixed(1)) : 0;

    return {
      timestamp: new Date().toISOString(),
      modelName: this.options.mockMode ? 'MockLLM' : (this.options.modelName || 'gemini-2.5-flash'),
      sandboxMode: this.options.sandboxMode || 'local',
      totalTasks,
      passedTasks,
      failedTasks,
      timedOutTasks,
      errorTasks,
      passRatePercent,
      averageSteps,
      averageDurationMs,
      totalTokens,
      guardianViolationRate,
      taskResults: results,
    };
  }

  private printScorecard(report: BenchmarkSuiteReport): void {
    console.log(`\n${c.bold}================================================================${c.reset}`);
    console.log(`${c.bold}📊 BẢNG TỔNG KẾT ĐÁNH GIÁ (EVALUATION SCORECARD)${c.reset}`);
    console.log(`${c.bold}================================================================${c.reset}`);

    const passRateColor = report.passRatePercent >= 80 ? c.green : report.passRatePercent >= 50 ? c.yellow : c.red;
    console.log(`• Tỷ lệ hoàn thành (Pass@1): ${passRateColor}${c.bold}${report.passRatePercent}%${c.reset} (${report.passedTasks}/${report.totalTasks} tasks)`);
    console.log(`• Số step trung bình: ${c.bold}${report.averageSteps}${c.reset} steps/task`);
    console.log(`• Tổng token tiêu thụ: ${c.bold}${report.totalTokens.toLocaleString()}${c.reset} tokens`);
    console.log(`• Tần suất vi phạm Guardian: ${c.bold}${report.guardianViolationRate}%${c.reset}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`${'TASK ID'.padEnd(30)} ${'CATEGORY'.padEnd(12)} ${'STATUS'.padEnd(10)} ${'STEPS'.padEnd(6)} ${'TIME'.padEnd(8)}`);
    console.log(`----------------------------------------------------------------`);

    for (const res of report.taskResults) {
      const statusColor = res.status === 'PASSED' ? c.green : c.red;
      const statusStr = statusColor + res.status.padEnd(10) + c.reset;
      const timeStr = `${(res.metrics.durationMs / 1000).toFixed(1)}s`;
      console.log(`${res.taskId.padEnd(30)} ${res.category.padEnd(12)} ${statusStr} ${String(res.metrics.stepsTaken).padEnd(6)} ${timeStr.padEnd(8)}`);
    }
    console.log(`${c.bold}================================================================${c.reset}\n`);
  }

  private saveReportToFile(report: BenchmarkSuiteReport, outputPath: string): void {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`💾 Báo cáo chi tiết đã được lưu tại: ${c.cyan}${outputPath}${c.reset}`);
    } catch (err: any) {
      console.error(`⚠️  Không thể lưu báo cáo ra ${outputPath}: ${err.message}`);
    }
  }
}
