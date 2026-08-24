import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import { GeminiLLM } from './llm/gemini.js';
import { DeepseekLLM } from './llm/deepseek.js';
import { FallbackRouterLLM, ProviderTier } from './llm/fallback-router.js';
import { ToolRegistry } from './tools/registry.js';
import { AgentLoop } from './agent/agent-loop.js';
import { Session } from './session/session.js';
import { SessionPersistence } from './session/session-persistence.js';
import { loadSession, saveSession, getSessionFilePath } from './session/persistent-session.js';
import { Workspace } from './workspace/workspace.js';
import {
  CLI,
  AVAILABLE_MODELS,
  RealtimeSlashCommandHints,
  colors as c,
  completeSlashCommand,
} from './ui/cli-ui.js';
import { AgentKernel } from './kernel/kernel.js';
import { WorkspacePlugin } from './kernel/plugins/workspace-plugin.js';
import { PlanningPlugin } from './kernel/plugins/planning-plugin.js';
import { MemoryPlugin } from './kernel/plugins/memory-plugin.js';
import { SandboxPlugin } from './kernel/plugins/sandbox-plugin.js';
import { TaskPlugin } from './kernel/plugins/task-plugin.js';
import { RepomixPlugin } from './kernel/plugins/repomix-plugin.js';
import { SearchPlugin } from './kernel/plugins/search-plugin.js';
import { SandboxManager } from './sandbox/sandbox-manager.js';
import { getCodexCredentials, isCodexAuthenticated } from './llm/codex-auth.js';
import {
  FileMentionEngine,
  PromptAttachmentProcessor,
} from './workspace/file-attachment.js';
import {
  TokenConfig,
  getModelTokenProfile,
  resolveTokenConfig,
  TokenPresetTier,
  TOKEN_TIER_DEFINITIONS,
  getPresetTokenConfig,
  resolveOutputTokensPreset,
  resolveInputTokensPreset,
  resolveThinkingTokensPreset,
  normalizePresetTier,
} from './llm/token-config.js';

// Load biến môi trường từ file .env
dotenv.config();

// Tự động bật Docker Sandbox mặc định để chạy lệnh không giới hạn (Zero-Restriction) khi chạy npm run dev
if (!process.env.SANDBOX_MODE) {
  process.env.SANDBOX_MODE = 'docker';
}

const apiKey = process.env.GEMINI_API_KEY || '';
const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const groqApiKey = process.env.GROQ_API_KEY || '';
const cerebrasApiKey = process.env.CEREBRAS_API_KEY || '';
const sambanovaApiKey = process.env.SAMBANOVA_API_KEY || '';
const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY || '';
const siliconflowApiKey = process.env.SILICONFLOW_API_KEY || '';
const mistralApiKey = process.env.MISTRAL_API_KEY || '';
const openrouterApiKey = process.env.OPENROUTER_API_KEY || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const maxSteps = process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS, 10) : 30;

let activeWorkspaceRef: Workspace | undefined;

// Hàm hoàn thành tự động khi người dùng nhấn Tab (Hỗ trợ Slash Commands và @ Mention File / Thư mục)
function completer(line: string): [string[], string] {
  if (line.includes('@') && activeWorkspaceRef) {
    const mentionCompletions = FileMentionEngine.completeMention(line, activeWorkspaceRef);
    if (mentionCompletions[0].length > 0) {
      return mentionCompletions;
    }
  }
  return completeSlashCommand(line);
}

// Phân tích tham số dòng lệnh CLI (--workspace, --model, --sandbox, positional workspace)
function parseCommandLineArgs(): { cliWorkspace?: string; cliModel?: string; cliSandbox?: string } {
  const args = process.argv.slice(2);
  let cliWorkspace: string | undefined;
  let cliModel: string | undefined;
  let cliSandbox: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      cliWorkspace = args[i + 1];
      i++;
    } else if (args[i].startsWith('--workspace=')) {
      cliWorkspace = args[i].split('=')[1];
    } else if (args[i] === '--model' && args[i + 1]) {
      cliModel = args[i + 1];
      i++;
    } else if (args[i].startsWith('--model=')) {
      cliModel = args[i].split('=')[1];
    } else if (args[i] === '--sandbox' && args[i + 1]) {
      cliSandbox = args[i + 1];
      i++;
    } else if (args[i].startsWith('--sandbox=')) {
      cliSandbox = args[i].split('=')[1];
    } else if (args[i] === '--docker') {
      cliSandbox = 'docker';
    } else if (args[i] === '--local') {
      cliSandbox = 'local';
    } else if (!args[i].startsWith('-') && !cliWorkspace) {
      cliWorkspace = args[i];
    }
  }

  return { cliWorkspace, cliModel, cliSandbox };
}

// Phân tích đường dẫn workspace khởi tạo theo thứ tự ưu tiên
function getInitialWorkspacePath(savedWorkspace?: string, cliWorkspace?: string): string {
  // 1. Kiểm tra tham số CLI (ưu tiên cao nhất)
  if (cliWorkspace) {
    const resolved = path.resolve(cliWorkspace);
    if (fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          return resolved;
        }
      } catch {}
    }
  }

  // 2. Kiểm tra cấu hình đã lưu từ phiên trước (.codingagent/session.json)
  if (savedWorkspace) {
    const resolved = path.resolve(savedWorkspace);
    if (fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          return resolved;
        }
      } catch {}
    }
  }

  // 3. Kiểm tra biến môi trường .env
  if (process.env.WORKSPACE_DIR) {
    const resolved = path.resolve(process.env.WORKSPACE_DIR);
    if (fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          return resolved;
        }
      } catch {}
    }
  }
  if (process.env.WORKSPACE_PATH) {
    const resolved = path.resolve(process.env.WORKSPACE_PATH);
    if (fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          return resolved;
        }
      } catch {}
    }
  }

  // 4. Mặc định là thư mục làm việc hiện tại
  return process.cwd();
}

// Xác định model khởi tạo theo thứ tự ưu tiên
function getInitialModelName(savedModel?: string, cliModel?: string): string {
  // 1. Tham số dòng lệnh CLI
  if (cliModel && cliModel.trim()) {
    const directMatch = AVAILABLE_MODELS.find((m) => m.id === cliModel?.trim());
    return directMatch ? directMatch.name : cliModel.trim();
  }

  // 2. Cấu hình đã lưu từ phiên trước (.codingagent/session.json)
  if (savedModel && savedModel.trim()) {
    return savedModel.trim();
  }

  // 3. Biến môi trường .env MODEL_NAME
  if (process.env.MODEL_NAME && process.env.MODEL_NAME.trim()) {
    return process.env.MODEL_NAME.trim();
  }

  // 4. Mặc định theo API Key có sẵn
  return apiKey ? 'gemini-3.7-flash' : 'groq/llama-3.3-70b-versatile';
}

async function createLLM(model: string, tokenConfig?: Partial<TokenConfig>) {
  // 0. Smart Multi-Provider 3-Tier Fallback Router (Chống Rate-Limit & Quá tải)
  if (model === 'auto-fallback' || model === 'smart-router') {
    const tiers: ProviderTier[] = [];

    // Tier 1: Primary Google Gemini (3.7 / 3.6 / 3.5 Flash)
    if (apiKey) {
      tiers.push({
        name: 'gemini-3.7-flash',
        provider: 'Google AI Studio',
        tier: 1,
        createClient: () => new GeminiLLM(apiKey, 'gemini-3.7-flash', undefined, tokenConfig),
      });
      tiers.push({
        name: 'gemini-3.6-flash',
        provider: 'Google AI Studio',
        tier: 1,
        createClient: () => new GeminiLLM(apiKey, 'gemini-3.6-flash', undefined, tokenConfig),
      });
    }

    // Tier 2: High-Speed LPUs (Groq, Cerebras, SambaNova)
    if (groqApiKey) {
      tiers.push({
        name: 'groq/llama-3.3-70b-versatile',
        provider: 'Groq Cloud',
        tier: 2,
        createClient: () => new DeepseekLLM(groqApiKey, 'llama-3.3-70b-versatile', undefined, 'https://api.groq.com/openai/v1', undefined, tokenConfig),
      });
    }
    if (cerebrasApiKey) {
      tiers.push({
        name: 'cerebras/llama-3.3-70b',
        provider: 'Cerebras Cloud',
        tier: 2,
        createClient: () => new DeepseekLLM(cerebrasApiKey, 'llama-3.3-70b', undefined, 'https://api.cerebras.ai/v1', undefined, tokenConfig),
      });
    }
    if (sambanovaApiKey) {
      tiers.push({
        name: 'sambanova/Meta-Llama-3.3-70B-Instruct',
        provider: 'SambaNova Cloud',
        tier: 2,
        createClient: () => new DeepseekLLM(sambanovaApiKey, 'Meta-Llama-3.3-70B-Instruct', undefined, 'https://api.sambanova.ai/v1', undefined, tokenConfig),
      });
    }

    // Tier 3: Backup Free Pool & Zero-Key
    if (mistralApiKey) {
      tiers.push({
        name: 'mistral/codestral-latest',
        provider: 'Mistral AI',
        tier: 3,
        createClient: () => new DeepseekLLM(mistralApiKey, 'codestral-latest', undefined, 'https://api.mistral.ai/v1', undefined, tokenConfig),
      });
    }
    if (openrouterApiKey) {
      tiers.push({
        name: 'openrouter/free',
        provider: 'OpenRouter Free',
        tier: 3,
        createClient: () => new DeepseekLLM(openrouterApiKey, 'free', undefined, 'https://openrouter.ai/api/v1', undefined, tokenConfig),
      });
    }
    // Always attach Pollinations Zero-Key as ultimate fail-safe
    tiers.push({
      name: 'pollinations/openai',
      provider: 'Pollinations Community (Zero-Key)',
      tier: 3,
      createClient: () => new DeepseekLLM('dummy_key', 'openai', undefined, 'https://text.pollinations.ai/openai', undefined, tokenConfig),
    });

    return new FallbackRouterLLM('auto-fallback', tiers, tokenConfig);
  }

  // 0.1. 9Router Local Gateway (Proxy tại localhost:20128/v1)
  if (model.startsWith('9router/')) {
    const rawModel = model.replace(/^9router\//, '');
    const baseUrl = process.env.NINE_ROUTER_BASE_URL || 'http://localhost:20128/v1';
    const key = process.env.NINE_ROUTER_API_KEY || '123456';
    return new DeepseekLLM(key, rawModel === 'auto' ? 'auto' : rawModel, undefined, baseUrl, undefined, tokenConfig);
  }

  // 1. Google Gemini chính thức (Google AI Studio Free Tier)
  if (
    model.startsWith('gemini') ||
    model.startsWith('google/gemini')
  ) {
    const rawModel = model.replace(/^google\//, '');
    if (!apiKey) {
      throw new Error(`Chưa cấu hình GEMINI_API_KEY trong .env! Vui lòng lấy key miễn phí tại: https://aistudio.google.com/`);
    }
    return new GeminiLLM(apiKey, rawModel, undefined, tokenConfig);
  }

  // 2. Groq Cloud (Free Tier - Siêu tốc LPU)
  if (
    model.startsWith('groq/') ||
    model === 'llama-3.3-70b-versatile' ||
    model === 'llama-3.1-8b-instant' ||
    model === 'deepseek-r1-distill-llama-70b' ||
    model === 'gemma2-9b-it'
  ) {
    const rawModel = model.replace(/^groq\//, '');
    const key = groqApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình GROQ_API_KEY trong .env! Vui lòng lấy key miễn phí tại https://console.groq.com/keys hoặc dùng /model 1 (Gemini).`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.groq.com/openai/v1', undefined, tokenConfig);
  }

  // 3. Cerebras Cloud (Free Tier - 1M tokens/ngày, 1500+ tok/s)
  if (model.startsWith('cerebras/') || model === 'llama-3.3-70b' || model === 'llama3.1-8b') {
    const rawModel = model.replace(/^cerebras\//, '');
    const key = cerebrasApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình CEREBRAS_API_KEY trong file .env!\n👉 Vui lòng lấy API key miễn phí tại: https://cloud.cerebras.ai/ và dán vào CEREBRAS_API_KEY trong .env, hoặc chuyển sang model đã có sẵn key như /model 1 (Gemini) hoặc /model 4 (Groq).`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.cerebras.ai/v1', undefined, tokenConfig);
  }

  // 4. SambaNova Cloud (Free Tier - Llama 405B)
  if (model.startsWith('sambanova/') || model.includes('405B') || model.startsWith('Meta-Llama')) {
    const rawModel = model.replace(/^sambanova\//, '');
    const key = sambanovaApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình SAMBANOVA_API_KEY trong file .env!\n👉 Vui lòng lấy key miễn phí tại: https://cloud.sambanova.ai/ và dán vào SAMBANOVA_API_KEY trong .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.sambanova.ai/v1', undefined, tokenConfig);
  }

  // 5. GitHub Models (Free Tier via GitHub Token)
  if (model.startsWith('github/')) {
    const rawModel = model.replace(/^github\//, '');
    const key = githubToken;
    if (!key) {
      throw new Error(`Chưa cấu hình GITHUB_TOKEN trong file .env!\n👉 Vui lòng tạo Personal Access Token tại https://github.com/settings/tokens và dán vào GITHUB_TOKEN trong .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://models.inference.ai.azure.com', undefined, tokenConfig);
  }

  // 6. SiliconFlow (Free Tier)
  if (model.startsWith('siliconflow/')) {
    const rawModel = model.replace(/^siliconflow\//, '');
    const key = siliconflowApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình SILICONFLOW_API_KEY trong file .env!\n👉 Vui lòng lấy key tại https://siliconflow.cn/ và dán vào .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.siliconflow.cn/v1', undefined, tokenConfig);
  }

  // 7. Mistral AI (Codestral Free Tier)
  if (model.startsWith('mistral/')) {
    const rawModel = model.replace(/^mistral\//, '');
    const key = mistralApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình MISTRAL_API_KEY trong file .env!\n👉 Vui lòng lấy key miễn phí tại https://console.mistral.ai/ và dán vào .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.mistral.ai/v1', undefined, tokenConfig);
  }

  // 8. Pollinations AI (Zero-Key Free Community - Không cần API Key)
  if (model.startsWith('pollinations/')) {
    const rawModel = model.replace(/^pollinations\//, '');
    return new DeepseekLLM('dummy_key', rawModel, undefined, 'https://text.pollinations.ai/openai', undefined, tokenConfig);
  }

  // 9. OpenAI Codex CLI (GPT-5.6 Sol / Terra / Luna, o4-mini, o3-mini qua OpenAI API hoặc ChatGPT Plus OAuth)
  if (
    model.startsWith('codex/') ||
    model.startsWith('gpt-5.6-') ||
    model === 'gpt-5.6-sol' ||
    model === 'gpt-5.6-terra' ||
    model === 'gpt-5.6-luna'
  ) {
    const rawModel = model.replace(/^codex\//, '');
    const codexCreds = getCodexCredentials();

    // 1. Nếu có OPENAI_API_KEY trong .env -> Luôn ưu tiên dùng endpoint chính thức (tránh Cloudflare bot challenge)
    if (openaiApiKey) {
      const baseUrl = process.env.CODEX_BASE_URL || 'https://api.openai.com/v1';
      return new DeepseekLLM(openaiApiKey, rawModel, undefined, baseUrl, undefined, tokenConfig);
    }

    // 2. Nếu có token OAuth từ Codex CLI (~/.codex/auth.json)
    if (codexCreds?.accessToken) {
      const codexBaseUrl = process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';
      return new DeepseekLLM(
        codexCreds.accessToken,
        rawModel,
        undefined,
        codexBaseUrl,
        codexCreds.accountId ? { 'chatgpt-account-id': codexCreds.accountId } : undefined,
        tokenConfig
      );
    }

    throw new Error(
      `Chưa tìm thấy OPENAI_API_KEY hoặc OAuth token của Codex CLI!\n` +
      `👉 Cách tốt nhất: Thêm OPENAI_API_KEY=sk-... vào file .env để kết nối trực tiếp không qua Cloudflare.\n` +
      `👉 Hoặc đăng nhập 'codex login' và cấu hình proxy.`
    );
  }

  // 10. OpenAI Direct (Chính thức qua API Key)
  if (model.startsWith('openai/')) {
    const rawModel = model.replace(/^openai\//, '');
    const key = openaiApiKey || getCodexCredentials()?.accessToken;
    if (!key) {
      throw new Error(`Chưa cấu hình OPENAI_API_KEY trong file .env! Vui lòng dán key vào .env.`);
    }
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    return new DeepseekLLM(key, rawModel, undefined, baseUrl, undefined, tokenConfig);
  }

  // 11. DeepSeek Direct (V3 / R1)
  if (model === 'deepseek-chat' || model === 'deepseek-reasoner') {
    const key = deepseekApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình DEEPSEEK_API_KEY trong file .env!\n👉 Vui lòng lấy key tại https://platform.deepseek.com/ và dán vào .env.`);
    }
    return new DeepseekLLM(key, model, undefined, 'https://api.deepseek.com', undefined, tokenConfig);
  }

  // 12. OpenRouter Free Models & Direct OpenRouter (Chỉ bắt các model có tiền tố openrouter/ hoặc :free)
  if (model.startsWith('openrouter/') || model.endsWith(':free')) {
    const rawModel = model.replace(/^openrouter\//, '');
    const key = openrouterApiKey || deepseekApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình OPENROUTER_API_KEY trong file .env!\n👉 Vui lòng lấy key tại https://openrouter.ai/keys và dán vào .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://openrouter.ai/api/v1', undefined, tokenConfig);
  }

  // Fallback mặc định
  if (apiKey) {
    return new GeminiLLM(apiKey, model, undefined, tokenConfig);
  }
  if (groqApiKey) {
    return new DeepseekLLM(groqApiKey, model, undefined, 'https://api.groq.com/openai/v1', undefined, tokenConfig);
  }
  return new DeepseekLLM(deepseekApiKey || 'dummy_key', model, undefined, undefined, undefined, tokenConfig);
}

async function main() {
  const hasCodexAuth = isCodexAuthenticated();
  const hasAnyKey =
    apiKey ||
    deepseekApiKey ||
    groqApiKey ||
    cerebrasApiKey ||
    sambanovaApiKey ||
    githubToken ||
    siliconflowApiKey ||
    mistralApiKey ||
    openrouterApiKey ||
    openaiApiKey ||
    hasCodexAuth;

  if (!hasAnyKey) {
    console.error(`\n${c.red}${c.bold}❌ LỖI KHỞI ĐỘNG:${c.reset} Chưa cấu hình API Key hoặc chưa đăng nhập Codex CLI!`);
    console.error(`${c.gray}Vui lòng thực hiện một trong các cách sau:${c.reset}`);
    console.error(`  ${c.brightYellow}1. Đăng nhập Codex CLI:${c.reset} Gõ lệnh ${c.cyan}codex login${c.reset} trong terminal (Dùng tài khoản ChatGPT Plus)`);
    console.error(`  ${c.brightYellow}2. Hoặc điền ít nhất một API key miễn phí vào file .env:${c.reset}`);
    console.error(`     ${c.cyan}GEMINI_API_KEY=AIzaSy...${c.reset} (Google AI Studio)`);
    console.error(`     ${c.cyan}GROQ_API_KEY=gsk_...${c.reset} (Groq Cloud)`);
    console.error(`     ${c.cyan}CEREBRAS_API_KEY=csk-...${c.reset} (Cerebras Cloud)`);
    console.error(`     ${c.cyan}SAMBANOVA_API_KEY=...${c.reset} (SambaNova Cloud)`);
    console.error(`     ${c.cyan}GITHUB_TOKEN=ghp_...${c.reset} (GitHub Models)`);
    console.error(`     ${c.cyan}OPENAI_API_KEY=sk-...${c.reset} (OpenAI API)\n`);
    process.exit(1);
  }

  // 1. Tải cấu hình phiên làm việc đã lưu từ trước (Model name & Workspace path)
  const { cliWorkspace, cliModel, cliSandbox } = parseCommandLineArgs();
  if (cliSandbox) {
    process.env.SANDBOX_MODE = cliSandbox;
  }
  const savedSession = loadSession();

  const initialPath = getInitialWorkspacePath(savedSession.workspacePath, cliWorkspace);
  let modelName = getInitialModelName(savedSession.modelName, cliModel);

  let workspace = new Workspace(initialPath);
  let llm = await createLLM(modelName, savedSession.tokenConfig);
  let sessionPersistence = new SessionPersistence(workspace.rootDir);
  let activeSession = savedSession.activeSessionId
    ? await sessionPersistence.load(savedSession.activeSessionId)
    : undefined;
  if (!activeSession) {
    activeSession = new Session();
    await sessionPersistence.save(activeSession);
  }

  // Tự động lưu cấu hình phiên làm việc hiện tại
  saveSession({
    modelName,
    workspacePath: workspace.rootDir,
    activeSessionId: activeSession.id,
  });

  const kernel = new AgentKernel(workspace, llm);
  await kernel.use(WorkspacePlugin);
  await kernel.use(PlanningPlugin);
  await kernel.use(MemoryPlugin);
  await kernel.use(SandboxPlugin);
  await kernel.use(TaskPlugin);
  await kernel.use(RepomixPlugin);
  await kernel.use(SearchPlugin);

  try {
    await kernel.init();
  } catch (err: any) {
    if (err.message && (err.message.includes('Docker') || err.message.includes('SANDBOX_MODE=docker'))) {
      console.warn(`\n${c.yellow}⚠️  [Docker Sandbox]: ${err.message}${c.reset}`);
      console.warn(`${c.gray}👉 Đang tự động chuyển sang Local Process Sandbox (Host OS với bộ lọc Allowlist).${c.reset}`);
      console.warn(`${c.gray}💡 Để chạy lệnh không giới hạn (Zero-Restriction), vui lòng khởi động Docker Desktop trên máy tính.${c.reset}\n`);
      process.env.SANDBOX_MODE = 'local';
      const fallbackSandbox = new SandboxManager({ workspacePath: workspace.rootDir, mode: 'local' });
      await fallbackSandbox.init();
      (kernel.ctx as any).sandbox = fallbackSandbox;
      kernel.ctx.tools.attachSandboxManager(fallbackSandbox);
      await kernel.init();
    } else {
      throw err;
    }
  }

  // Lắng nghe sự kiện thay đổi workspace hoặc model từ Kernel để tự động đồng bộ xuống đĩa
  kernel.ctx.events.on('workspace:changed', (_oldPath: string, newPath: string) => {
    saveSession({ workspacePath: newPath });
  });
  kernel.ctx.events.on('model:changed', (newModel: string) => {
    saveSession({ modelName: newModel });
  });

  const getSandboxStatusLabel = (): string => {
    const sbStatus = kernel.ctx.sandbox.getStatus();
    return sbStatus.isIsolated
      ? `${c.brightGreen}${c.bold}✔ Docker Sandbox (Isolated - Không giới hạn lệnh)${c.reset} ${c.dim}[${sbStatus.containerId || ''}]${c.reset}`
      : `${c.yellow}⚠ Local Sandbox (Host OS - Giới hạn Allowlist)${c.reset}`;
  };

  const toolRegistry = kernel.ctx.tools;
  const agentLoop = new AgentLoop(kernel, undefined, { maxSteps, workspace, sessionPersistence });
  agentLoop.bindSession(activeSession);
  if (savedSession.tokenConfig) {
    agentLoop.setTokenConfig(savedSession.tokenConfig);
  }

  let sessionCount = 0;

  activeWorkspaceRef = workspace;

  const executeDurableGoal = async (objective?: string): Promise<void> => {
    if (!activeSession) {
      throw new Error('Không có active session để chạy goal.');
    }

    if (objective) {
      agentLoop.goalManager.create(objective);
      sessionCount++;
    } else {
      agentLoop.goalManager.arm();
    }

    const state = agentLoop.goalManager.beginRound();
    if (!state) {
      throw new Error('Không có durable goal để tiếp tục. Dùng /goal <mục tiêu> trước.');
    }

    CLI.renderGoalBanner(state.objective);
    if (objective) {
      const attachmentResult = await PromptAttachmentProcessor.resolveAndAttach(objective, workspace);
      if (attachmentResult.hasAttachments) {
        CLI.renderAttachmentSummary(attachmentResult.attachments);
      }
      await agentLoop.submit(activeSession, attachmentResult.expandedPrompt, 'human', { isGoalMode: true });
    } else {
      await agentLoop.run(activeSession, { isGoalMode: true });
    }
  };

  // Hiển thị Banner mở đầu
  CLI.renderBanner({
    modelName,
    workspaceRoot: workspace.rootDir,
    maxSteps,
    tools: toolRegistry.getAll().map((t) => t.name),
    sandboxStatus: getSandboxStatusLabel(),
  });

  const rl = readline.createInterface({ input, output, completer });
  const slashHints = new RealtimeSlashCommandHints(output, () => activeWorkspaceRef);
  let slashHintRefreshScheduled = false;
  const handleInputKeypress = (_sequence: string, key?: { name?: string; ctrl?: boolean }): void => {
    if (key?.name === 'return' || key?.name === 'enter' || (key?.ctrl && ['c', 'd'].includes(key.name || ''))) {
      slashHints.clear();
      return;
    }
    const removesOnlySlash = rl.line === '/'
      && ((key?.name === 'backspace' && rl.cursor === 1) || (key?.name === 'delete' && rl.cursor === 0));
    if (removesOnlySlash) {
      slashHints.clear();
      return;
    }
    if (slashHintRefreshScheduled) return;
    slashHintRefreshScheduled = true;
    setImmediate(() => {
      slashHintRefreshScheduled = false;
      slashHints.update(rl.line, rl.cursor + 2);
    });
  };
  // Clear transient rows before readline handles Enter and invokes the question callback.
  // Character updates are deferred, so prepending does not read stale rl.line state.
  input.prependListener('keypress', handleInputKeypress);

  // Đăng ký Permission Prompt Handler cho interactive CLI mode
  kernel.ctx.permissions.setPromptHandler(async (request) => {
    slashHints.clear();
    CLI.renderPermissionPrompt(request);
    const answer = (await rl.question(`  ${c.brightYellow}${c.bold}👉 Duyệt thực thi? [y: Đồng ý | n: Từ chối | a: Luôn duyệt trong phiên]:${c.reset} `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes' || answer === '') {
      return 'approve';
    }
    if (answer === 'a' || answer === 'all' || answer === 'always') {
      return 'approve_all_session';
    }
    return 'reject';
  });

  try {
    while (true) {
      const userPrompt = await rl.question(CLI.getPromptSymbol());
      const trimmed = userPrompt.trim();

      if (!trimmed) {
        continue;
      }

      // Khi người dùng chỉ nhập "/" hoặc "/?" -> Gợi ý danh sách lệnh nhanh
      if (trimmed === '/' || trimmed === '/?') {
        CLI.renderQuickCommands();
        continue;
      }

      // Xử lý các Slash Commands
      if (trimmed === '/help') {
        CLI.renderHelp();
        continue;
      }

      if (trimmed === '/tools') {
        CLI.renderTools(toolRegistry.getAll().map((t) => ({ name: t.name, description: t.description })));
        continue;
      }

      if (trimmed === '/sandbox') {
        CLI.renderSandbox(kernel.ctx.sandbox.getStatus());
        continue;
      }

      if (trimmed === '/tasks') {
        CLI.renderTasks(kernel.ctx.tasks.listTasks());
        continue;
      }

      if (trimmed === '/plan') {
        const tasks = agentLoop.planManager.getTasks();
        if (tasks.length === 0) {
          console.log(`\n${c.yellow}ℹ Hiện tại chưa có kế hoạch nào được khởi tạo trong phiên này.${c.reset}\n`);
        } else {
          CLI.renderPlan(tasks);
        }
        continue;
      }

      if (trimmed === '/memory') {
        CLI.renderMemory(agentLoop.memoryManager.getMemoryData());
        continue;
      }

      if (trimmed === '/session') {
        const persisted = loadSession();
        CLI.renderSessionInfo(persisted, getSessionFilePath());
        console.log(`${c.gray}  Event log: ${sessionPersistence.getSessionPath(activeSession.id)} (${activeSession.seq} events)${c.reset}\n`);
        continue;
      }

      if (trimmed === '/sessions' || trimmed.startsWith('/sessions ')) {
        const sessionArgs = trimmed.slice('/sessions'.length).trim().split(/\s+/).filter(Boolean);
        const action = sessionArgs[0]?.toLowerCase();
        const targetId = sessionArgs[1];
        try {
          if (action === 'inspect') {
            const inspected = targetId ? await kernel.ctx.sessions.load(targetId) : activeSession;
            if (!inspected) {
              console.log(`\n${c.yellow}Không tìm thấy session để inspect.${c.reset}\n`);
            } else {
              console.log(`\n${c.brightCyan}Session diagnostics:${c.reset}\n${JSON.stringify(inspected.getDiagnostics(), null, 2)}\n`);
            }
          } else if (action === 'open' && targetId) {
            const loaded = await kernel.ctx.sessions.load(targetId);
            if (!loaded) {
              console.log(`\n${c.yellow}Không tìm thấy session:${c.reset} ${targetId}\n`);
            } else {
              activeSession = loaded;
              agentLoop.bindSession(activeSession);
              saveSession({ activeSessionId: activeSession.id });
              console.log(`\n${c.green}✔ Đã mở session:${c.reset} ${activeSession.id} (${activeSession.seq} events)\n`);
            }
          } else if (action === 'new') {
            activeSession = await kernel.ctx.sessions.create(targetId);
            agentLoop.bindSession(activeSession);
            saveSession({ activeSessionId: activeSession.id });
            console.log(`\n${c.green}✔ Đã tạo session:${c.reset} ${activeSession.id}\n`);
          } else {
            const ids = await kernel.ctx.sessions.list();
            console.log(`\n${c.brightCyan}Persisted sessions:${c.reset}`);
            for (const id of ids) console.log(`  ${id === activeSession.id ? c.green + '▶' : ' '} ${id}${c.reset}`);
            console.log(`${c.gray}Dùng /sessions open <id>, /sessions new [id] hoặc /sessions inspect [id].${c.reset}\n`);
          }
        } catch (err: any) {
          console.error(`\n${c.red}✖ Session operation failed:${c.reset}`, err.message);
        }
        continue;
      }

      if (trimmed === '/new-session') {
        activeSession = await kernel.ctx.sessions.create();
        agentLoop.bindSession(activeSession);
        await sessionPersistence.save(activeSession);
        saveSession({ activeSessionId: activeSession.id });
        console.log(`\n${c.green}✔ Đã tạo session mới:${c.reset} ${activeSession.id}\n`);
        continue;
      }

      if (trimmed === '/fork-session' || trimmed.startsWith('/fork-session ')) {
        const boundaryText = trimmed.slice('/fork-session'.length).trim();
        const boundarySeq = boundaryText ? Number(boundaryText) : activeSession.seq;
        try {
          await sessionPersistence.save(activeSession);
          const parentId = activeSession.id;
          activeSession = await kernel.ctx.sessions.fork(activeSession, boundarySeq);
          agentLoop.bindSession(activeSession);
          saveSession({ activeSessionId: activeSession.id });
          console.log(`\n${c.green}✔ Đã fork session:${c.reset} ${parentId} @ seq ${boundarySeq} → ${activeSession.id}\n`);
        } catch (err: any) {
          console.error(`\n${c.red}✖ Không thể fork session:${c.reset}`, err.message);
        }
        continue;
      }

      if (trimmed === '/cache' || trimmed === '/prompt-cache') {
        CLI.renderPromptCacheDashboard({
          modelName,
          preservePrefixCache: agentLoop.contextCompactor.getConfig().preservePrefixCache,
          sessionId: activeSession.id,
        });
        continue;
      }

      if (trimmed === '/status') {
        CLI.renderStatus({
          modelName,
          workspaceRoot: workspace.rootDir,
          maxSteps,
          sessionTurns: sessionCount,
          sessionFile: getSessionFilePath(),
          isGoalMode: agentLoop.isGoalMode,
          sandboxStatus: getSandboxStatusLabel(),
        });
        continue;
      }

      if (trimmed === '/agents' || trimmed.startsWith('/agents ')) {
        const agentArg = trimmed.slice('/agents'.length).trim();
        const [action, agentId] = agentArg.split(/\s+/, 2);
        if (action === 'resume' && agentId) {
          const resumed = agentLoop.subagentManager.resume(agentId);
          if (resumed) {
            await sessionPersistence.save(activeSession);
            console.log(`\n${c.green}✔ Đã explicit resume subagent:${c.reset} ${agentId} (${resumed.sessionId})\n`);
          } else {
            console.log(`\n${c.yellow}Subagent không tồn tại hoặc chưa ở trạng thái stopped/failed:${c.reset} ${agentId}\n`);
          }
        } else if (action === 'stop' && agentId) {
          const stopped = agentLoop.subagentManager.stop(agentId);
          if (stopped) await sessionPersistence.save(activeSession);
          console.log(`\n${stopped ? c.green : c.yellow}${stopped ? '✔ Đã dừng' : 'Không thể dừng'} subagent:${c.reset} ${agentId}\n`);
        } else {
          console.log(`\n${c.brightCyan}Subagents:${c.reset} ${JSON.stringify(agentLoop.subagentManager.list(), null, 2)}\n`);
          console.log(`${c.gray}Dùng /agents resume <id> hoặc /agents stop <id> để điều khiển explicit.${c.reset}\n`);
        }
        continue;
      }

      // Xử lý lệnh /goal: Thực thi tự trị không giới hạn số bước (maxSteps = ∞) tới khi xong
      if (trimmed === '/goal' || trimmed.startsWith('/goal ')) {
        const goalArg = trimmed.slice(5).trim();

        if (goalArg.toLowerCase() === 'on') {
          agentLoop.setGoalMode(true);
          CLI.renderGoalStatus(true);
          continue;
        }

        if (goalArg.toLowerCase() === 'off') {
          agentLoop.setGoalMode(false);
          agentLoop.goalManager.disarm();
          CLI.renderGoalStatus(false);
          continue;
        }

        if (goalArg.toLowerCase() === 'status') {
          const state = agentLoop.goalManager.getState();
          console.log(`\n${c.brightMagenta}Goal lifecycle:${c.reset} ${state ? JSON.stringify(state, null, 2) : 'chưa có durable goal'}\n`);
          continue;
        }

        if (goalArg.toLowerCase() === 'pause') {
          const state = agentLoop.goalManager.pause();
          console.log(`\n${c.yellow}Goal paused:${c.reset} ${state?.objective || 'chưa có goal'}\n`);
          continue;
        }

        if (goalArg.toLowerCase() === 'complete') {
          const state = agentLoop.goalManager.complete();
          console.log(`\n${c.green}Goal completed:${c.reset} ${state?.objective || 'chưa có goal'}\n`);
          continue;
        }

        if (goalArg.toLowerCase().startsWith('block')) {
          const reason = goalArg.slice('block'.length).trim() || 'Blocked by operator.';
          const state = agentLoop.goalManager.block(reason);
          console.log(`\n${c.red}Goal blocked:${c.reset} ${state?.blocker || reason}\n`);
          continue;
        }

        if (goalArg.toLowerCase() === 'resume') {
          const state = agentLoop.goalManager.resume();
          if (!state) {
            console.log(`\n${c.yellow}Chưa có durable goal để resume.${c.reset}\n`);
            continue;
          }
          try {
            await executeDurableGoal();
          } catch (err: any) {
            agentLoop.goalManager.block(err.message || 'Goal execution failed.');
            console.error(`\n${c.red}${c.bold}❌ Lỗi tiếp tục Goal:${c.reset}`, err.message);
          }
          continue;
        }

        let taskPrompt = goalArg;
        if (!taskPrompt) {
          CLI.renderGoalStatus(agentLoop.isGoalMode);
          const inputGoal = (await rl.question(`${c.brightMagenta}Nhập mục tiêu cần thực thi (hoặc 'on'/'off' để đổi chế độ): ${c.reset}`)).trim();
          if (!inputGoal) {
            console.log(`${c.dim}Đã hủy lệnh /goal.${c.reset}\n`);
            continue;
          }
          if (inputGoal.toLowerCase() === 'on') {
            agentLoop.setGoalMode(true);
            CLI.renderGoalStatus(true);
            continue;
          }
          if (inputGoal.toLowerCase() === 'off') {
            agentLoop.setGoalMode(false);
            CLI.renderGoalStatus(false);
            continue;
          }
          taskPrompt = inputGoal;
        }

        try {
          await executeDurableGoal(taskPrompt);
        } catch (err: any) {
          agentLoop.goalManager.block(err.message || 'Goal execution failed.');
          console.error(`\n${c.red}${c.bold}❌ Lỗi thực thi Goal Mode:${c.reset}`, err.message);
          if (err.message && (err.message.includes('404') || err.message.includes('model_not_found'))) {
            console.log(`\n${c.yellow}💡 Gợi ý: Model này không tồn tại hoặc tài khoản/API key chưa được cấp quyền truy cập.`);
            console.log(`👉 Bạn có thể chuyển sang model khác: /model 1 (Gemini) hoặc /model 4 (Groq)${c.reset}\n`);
          }
        }
        continue;
      }

      if (trimmed === '/clear') {
        console.clear();
        CLI.renderBanner({
          modelName,
          workspaceRoot: workspace.rootDir,
          maxSteps,
          tools: toolRegistry.getAll().map((t) => t.name),
          sandboxStatus: getSandboxStatusLabel(),
        });
        continue;
      }

      // Lệnh hoàn tác (/undo hoặc /rollback)
      if (trimmed === '/undo' || trimmed === '/rollback') {
        try {
          const rollbackRes = await agentLoop.rollback(activeSession);
          if (rollbackRes.success) {
            console.log(`\n${c.green}✔ ${rollbackRes.message}${c.reset}\n`);
          } else {
            console.log(`\n${c.yellow}⚠️  ${rollbackRes.message}${c.reset}\n`);
          }
        } catch (err: any) {
          console.error(`\n${c.red}✖ Lỗi khi hoàn tác:${c.reset}`, err.message);
        }
        continue;
      }

      // Lệnh xem lịch sử Checkpoints
      if (trimmed === '/checkpoints') {
        CLI.renderCheckpoints(agentLoop.checkpointManager.getHistory());
        continue;
      }

      // Lệnh xem hoặc thay đổi Workspace (/workspace hoặc /cd)
      if (
        trimmed === '/workspace' ||
        trimmed === '/cd' ||
        trimmed.startsWith('/workspace ') ||
        trimmed.startsWith('/cd ')
      ) {
        const parts = trimmed.split(' ');
        const targetPath = parts.slice(1).join(' ').trim();

        // Nếu không truyền tham số -> Hiển thị workspace hiện tại
        if (!targetPath) {
          CLI.renderWorkspaceInfo(workspace.rootDir);
          continue;
        }

        // Xử lý đường dẫn tương đối hoặc tuyệt đối
        const resolvedPath = path.isAbsolute(targetPath)
          ? path.resolve(targetPath)
          : path.resolve(workspace.rootDir, targetPath);

        if (!fs.existsSync(resolvedPath)) {
          console.error(`\n${c.red}✖ Lỗi: Đường dẫn không tồn tại:${c.reset} ${resolvedPath}\n`);
          continue;
        }

        try {
          const stat = fs.statSync(resolvedPath);
          if (!stat.isDirectory()) {
            console.error(`\n${c.red}✖ Lỗi: Đường dẫn không phải là thư mục:${c.reset} ${resolvedPath}\n`);
            continue;
          }

          const oldPath = workspace.rootDir;
          await sessionPersistence.save(activeSession);
          workspace = new Workspace(resolvedPath);
          activeWorkspaceRef = workspace;
          agentLoop.setWorkspace(workspace);
          sessionPersistence = new SessionPersistence(workspace.rootDir);
          agentLoop.setSessionPersistence(sessionPersistence);
          activeSession = new Session();
          agentLoop.bindSession(activeSession);
          await sessionPersistence.save(activeSession);
          saveSession({ activeSessionId: activeSession.id });
          saveSession({ workspacePath: workspace.rootDir });
          CLI.renderWorkspaceChanged(oldPath, workspace.rootDir);
        } catch (err: any) {
          console.error(`\n${c.red}✖ Lỗi khi chuyển workspace:${c.reset}`, err.message);
        }
        continue;
      }

      // Xử lý lệnh chọn /model (hoặc /modal)
      if (trimmed === '/model' || trimmed === '/modal' || trimmed.startsWith('/model ') || trimmed.startsWith('/modal ')) {
        const parts = trimmed.split(' ');
        let targetModel = parts.slice(1).join(' ').trim();

        // Nếu truyền trực tiếp số thứ tự (ví dụ: /model 1)
        if (targetModel) {
          const directMatch = AVAILABLE_MODELS.find((m) => m.id === targetModel);
          if (directMatch) {
            targetModel = directMatch.name;
          }
        }

        // Nếu người dùng chỉ gõ /model hoặc /modal mà không truyền tên -> Mở menu chọn số thứ tự
        if (!targetModel) {
          CLI.renderModelSelector(modelName);
          const choice = (await rl.question(`${c.brightYellow}Chọn mô hình [1-${AVAILABLE_MODELS.length} hoặc tên model]: ${c.reset}`)).trim();
          
          if (!choice) {
            console.log(`${c.dim}Đã hủy chọn mô hình.${c.reset}\n`);
            continue;
          }

          const matchedOption = AVAILABLE_MODELS.find((m) => m.id === choice);
          targetModel = matchedOption ? matchedOption.name : choice;
        }

        try {
          const currentTokens = agentLoop.getTokenConfig();
          const newLLM = await createLLM(targetModel, currentTokens);
          agentLoop.setLLM(newLLM, targetModel);
          modelName = targetModel;
          saveSession({ modelName });
          console.log(`\n${c.green}✔ Đã kích hoạt mô hình:${c.reset} ${c.bold}${c.brightCyan}${modelName}${c.reset} ${c.gray}(Đã lưu cho các phiên sau)${c.reset}\n`);
        } catch (err: any) {
          console.error(`\n${c.red}✖ Lỗi khi đổi model:${c.reset}`, err.message);
        }
        continue;
      }

      // Xử lý lệnh điều chỉnh Token (/tokens)
      if (
        trimmed === '/tokens' ||
        trimmed === '/token' ||
        trimmed.startsWith('/tokens ') ||
        trimmed.startsWith('/token ')
      ) {
        const parts = trimmed.split(' ');
        const subCmd = parts[1]?.toLowerCase();
        const val = parts[2];

        const currentConfig = agentLoop.getTokenConfig() || resolveTokenConfig(modelName);
        const profile = getModelTokenProfile(modelName);

        if (!subCmd) {
          CLI.renderTokenConfig(modelName, currentConfig, profile);
          continue;
        }

        // 1. Chọn nhanh trọn gói cấu hình sẵn (Preset Tiers: low, medium, high, max, preset <tier>, profile <tier>)
        const directTier = normalizePresetTier(subCmd);
        const subTier = (subCmd === 'preset' || subCmd === 'profile' || subCmd === 'tier') && val ? normalizePresetTier(val) : null;
        const targetTier = directTier || subTier;

        if (targetTier) {
          const presetConfig = getPresetTokenConfig(targetTier, profile);
          const tierDef = TOKEN_TIER_DEFINITIONS[targetTier];

          agentLoop.setTokenConfig(presetConfig);
          saveSession({ tokenConfig: presetConfig });

          console.log(`\n${c.green}✔ Đã áp dụng Gói Cấu hình Token:${c.reset} ${c.bold}${tierDef.badge} - ${tierDef.label}${c.reset}`);
          console.log(`  ${c.gray}↳ ${tierDef.description}${c.reset}\n`);
          CLI.renderTokenConfig(modelName, presetConfig, profile);
          continue;
        }

        // 2. Cấu hình Output Tokens (chấp nhận: low | med | high | max | số nguyên)
        if (subCmd === 'output' || subCmd === 'max_output' || subCmd === 'max_tokens' || subCmd === 'completion') {
          if (!val) {
            console.log(`\n${c.red}✖ Vui lòng chọn gói sẵn hoặc nhập số token:${c.reset} ${c.bold}/tokens output <low|medium|high|max|số_token>${c.reset}\n`);
            continue;
          }
          const resolvedOutput = resolveOutputTokensPreset(val, profile);
          if (resolvedOutput === null || resolvedOutput <= 0) {
            console.log(`\n${c.red}✖ Mức output không hợp lệ. Khả dụng: low (2K), medium (8K), high (16K), max (${profile.maxSupportedOutputTokens.toLocaleString()}) hoặc nhập số nguyên.${c.reset}\n`);
            continue;
          }
          agentLoop.setTokenConfig({ maxOutputTokens: resolvedOutput });
          const updated = agentLoop.getTokenConfig();
          saveSession({ tokenConfig: updated });
          console.log(`\n${c.green}✔ Đã cập nhật Max Output Tokens:${c.reset} ${c.bold}${resolvedOutput.toLocaleString()}${c.reset} ${c.gray}(Đã lưu cho các phiên sau)${c.reset}\n`);
          continue;
        }

        // 3. Cấu hình Input Tokens / Context Window (chấp nhận: low | med | high | max | số nguyên)
        if (subCmd === 'input' || subCmd === 'max_input' || subCmd === 'context') {
          if (!val) {
            console.log(`\n${c.red}✖ Vui lòng chọn gói sẵn hoặc nhập số token:${c.reset} ${c.bold}/tokens input <low|medium|high|max|số_token>${c.reset}\n`);
            continue;
          }
          const resolvedInput = resolveInputTokensPreset(val, profile);
          if (resolvedInput === null || resolvedInput <= 0) {
            console.log(`\n${c.red}✖ Mức context window không hợp lệ. Khả dụng: low (16K), medium (64K), high (128K), max (${profile.maxSupportedInputTokens.toLocaleString()}) hoặc nhập số nguyên.${c.reset}\n`);
            continue;
          }
          agentLoop.setTokenConfig({ maxInputTokens: resolvedInput });
          const updated = agentLoop.getTokenConfig();
          saveSession({ tokenConfig: updated });
          console.log(`\n${c.green}✔ Đã cập nhật Max Input Tokens (Context Window):${c.reset} ${c.bold}${resolvedInput.toLocaleString()}${c.reset} ${c.gray}(Đã cập nhật ContextCompactor)${c.reset}\n`);
          continue;
        }

        // 4. Cấu hình Thinking Token Budget (chấp nhận: off | low | med | high | max | số nguyên)
        if (subCmd === 'thinking' || subCmd === 'budget') {
          if (!val) {
            console.log(`\n${c.red}✖ Vui lòng chọn gói sẵn hoặc nhập số token:${c.reset} ${c.bold}/tokens thinking <off|low|medium|high|max|số_token>${c.reset}\n`);
            continue;
          }
          const resolvedThinking = resolveThinkingTokensPreset(val, profile);
          if (resolvedThinking === null) {
            console.log(`\n${c.red}✖ Mức thinking budget không hợp lệ. Khả dụng: off (0), low (2K), medium (8K), high (24K), max (64K) hoặc nhập số nguyên.${c.reset}\n`);
            continue;
          }
          agentLoop.setTokenConfig({
            thinkingBudget: resolvedThinking.thinkingBudget,
            reasoningEffort: resolvedThinking.reasoningEffort,
          });
          const updated = agentLoop.getTokenConfig();
          saveSession({ tokenConfig: updated });
          const budgetLabel = resolvedThinking.thinkingBudget === 0
            ? 'TẮT (0 tokens)'
            : `${resolvedThinking.thinkingBudget?.toLocaleString()} tokens (effort: ${resolvedThinking.reasoningEffort})`;
          console.log(`\n${c.green}✔ Đã cập nhật Thinking Token Budget:${c.reset} ${c.bold}${budgetLabel}${c.reset}\n`);
          continue;
        }

        // 5. Cấu hình Reasoning Effort (chấp nhận: low | medium | high | max)
        if (subCmd === 'effort' || subCmd === 'reasoning') {
          const effortTier = normalizePresetTier(val);
          if (!effortTier) {
            console.log(`\n${c.red}✖ Reasoning effort hợp lệ: low | medium | high | max (ví dụ: /tokens effort high)${c.reset}\n`);
            continue;
          }
          agentLoop.setTokenConfig({ reasoningEffort: effortTier });
          const updated = agentLoop.getTokenConfig();
          saveSession({ tokenConfig: updated });
          console.log(`\n${c.green}✔ Đã cập nhật Reasoning Effort:${c.reset} ${c.bold}${effortTier}${c.reset}\n`);
          continue;
        }

        // 6. Khôi phục mặc định (Reset)
        if (subCmd === 'reset') {
          const defaultConfig = resolveTokenConfig(modelName);
          agentLoop.setTokenConfig(defaultConfig);
          saveSession({ tokenConfig: defaultConfig });
          console.log(`\n${c.green}✔ Đã khôi phục cấu hình token mặc định cho mô hình:${c.reset} ${c.bold}${modelName}${c.reset}\n`);
          CLI.renderTokenConfig(modelName, defaultConfig, profile);
          continue;
        }

        console.log(`\n${c.yellow}⚠️ Lệnh con không hợp lệ: "${subCmd}". Gõ /tokens để xem danh sách gói đóng gói sẵn và hướng dẫn.${c.reset}\n`);
        continue;
      }

      // Lệnh nạp và phân tích ảnh trực quan (Vision / Multimodal: /image, /vision, /img)
      if (
        trimmed === '/image' ||
        trimmed.startsWith('/image ') ||
        trimmed === '/vision' ||
        trimmed.startsWith('/vision ') ||
        trimmed === '/img' ||
        trimmed.startsWith('/img ')
      ) {
        const parts = trimmed.split(' ');
        const imgPath = parts[1];
        const userPrompt = parts.slice(2).join(' ').trim() || 'Hãy quan sát và phân tích chi tiết hình ảnh đính kèm này.';

        if (!imgPath) {
          console.log(`\n${c.red}✖ Cách dùng:${c.reset} ${c.bold}/image <đường_dẫn_ảnh> [câu hỏi / chỉ dẫn]${c.reset}`);
          console.log(`${c.gray}Ví dụ: /image screenshots/ui.png Kiểm tra lỗi hiển thị nút bấm${c.reset}\n`);
          continue;
        }

        try {
          const resolvedPath = path.isAbsolute(imgPath) ? imgPath : path.resolve(workspace.rootDir, imgPath);
          const stat = await fs.promises.stat(resolvedPath);
          if (!stat.isFile()) {
            console.log(`\n${c.red}✖ Đường dẫn "${imgPath}" không phải là tệp.${c.reset}\n`);
            continue;
          }

          const buf = await fs.promises.readFile(resolvedPath);
          const ext = path.extname(resolvedPath).toLowerCase();
          const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
          const base64 = buf.toString('base64');

          console.log(`\n${c.green}✔ Đã tải ảnh:${c.reset} ${c.bold}${path.basename(resolvedPath)}${c.reset} ${c.gray}(${(stat.size / 1024).toFixed(1)} KB, ${mime})${c.reset}`);
          console.log(`${c.cyan}👁️  Đang gửi ảnh cùng chỉ thị đến mô hình ${modelName}...${c.reset}\n`);

          // In hộp yêu cầu của User
          console.log(`\n${c.cyan}${c.bold}┌── 👁️ VISION / MULTIMODAL REQUEST ──────────────────────────────────────────┐${c.reset}`);
          console.log(`${c.bold}[Ảnh: ${path.relative(workspace.rootDir, resolvedPath)}] ${userPrompt}${c.reset}`);
          console.log(`${c.cyan}${c.bold}└────────────────────────────────────────────────────────────────────────────┘${c.reset}`);

          activeSession.addMultimodalUserMessage(
            userPrompt,
            [{ mimeType: mime, data: base64, filePath: path.relative(workspace.rootDir, resolvedPath) }],
            'human'
          );

          sessionCount++;
          await agentLoop.run(activeSession);
        } catch (err: any) {
          console.error(`\n${c.red}✖ Lỗi khi đọc ảnh:${c.reset}`, err.message);
        }
        continue;
      }

      // Lệnh xem và quản lý Superpowers Skills (/skills)
      if (trimmed === '/skills' || trimmed.startsWith('/skills ')) {
        const parts = trimmed.split(' ');
        const subCmd = parts[1];
        const targetId = parts[2];
        const skillsRegistry = (agentLoop.kernel?.ctx as any)?.skills;

        if (!skillsRegistry) {
          console.log(`\n${c.yellow}⚠️  Skill registry chưa được khởi tạo.${c.reset}\n`);
          continue;
        }

        if (subCmd === 'inspect' && targetId) {
          const skill = skillsRegistry.get(targetId);
          if (!skill) {
            console.log(`\n${c.red}✖ Không tìm thấy skill: ${targetId}${c.reset}\n`);
          } else {
            console.log(`\n${c.cyan}${c.bold}=== SKILL MANIFEST: ${skill.id} ===${c.reset}`);
            console.log(`Name: ${skill.name} (v${skill.version})`);
            console.log(`Source: ${skill.source} | Priority: ${skill.priority}`);
            console.log(`Path: ${skill.path}`);
            console.log(`Hash: ${skill.contentHash}`);
            console.log(`Description: ${skill.description}`);
            if (skill.requires) console.log(`Requires: ${skill.requires.join(', ')}`);
            if (skill.requiredCapabilities) console.log(`Required Capabilities: ${skill.requiredCapabilities.join(', ')}`);
            console.log('');
          }
        } else {
          CLI.renderSkills(skillsRegistry.list(), activeSession.getSkillDecisions());
        }
        continue;
      }

      // Lệnh xem Capability Catalog (/capabilities)
      if (trimmed === '/capabilities' || trimmed.startsWith('/capabilities ')) {
        const capabilitiesCatalog = (agentLoop.kernel?.ctx as any)?.capabilities;
        if (capabilitiesCatalog) {
          const parts = trimmed.split(/\s+/).filter(Boolean);
          const target = parts[1];
          const subTarget = parts[2];

          if (!target) {
            CLI.renderCapabilities(capabilitiesCatalog.list());
          } else if (target === 'inspect' && subTarget) {
            const cap = capabilitiesCatalog.get(subTarget);
            if (cap) {
              CLI.renderCapabilities([cap]);
            } else {
              console.log(`\n${c.red}✖ Không tìm thấy capability: ${subTarget}${c.reset}\n`);
            }
          } else if (target === 'categories') {
            const cats = capabilitiesCatalog.getCategories ? capabilitiesCatalog.getCategories() : [];
            console.log(`\n${c.cyan}${c.bold}Các Capability Categories khả dụng:${c.reset}`);
            for (const cat of cats) {
              const count = capabilitiesCatalog.getByCategory(cat).length;
              console.log(`  • ${c.yellow}${cat}${c.reset} (${count} capabilities)`);
            }
            console.log('');
          } else {
            const byName = capabilitiesCatalog.get(target);
            if (byName) {
              CLI.renderCapabilities([byName]);
            } else {
              const byCategory = capabilitiesCatalog.getByCategory(target as any);
              if (byCategory.length > 0) {
                CLI.renderCapabilities(byCategory);
              } else {
                const searchResults = capabilitiesCatalog.search ? capabilitiesCatalog.search(target) : [];
                if (searchResults.length > 0) {
                  CLI.renderCapabilities(searchResults);
                } else {
                  console.log(`\n${c.red}✖ Không tìm thấy capability hoặc category: ${target}${c.reset}`);
                  if (capabilitiesCatalog.getCategories) {
                    console.log(`${c.gray}Các category khả dụng: ${capabilitiesCatalog.getCategories().join(', ')}${c.reset}\n`);
                  }
                }
              }
            }
          }
        } else {
          console.log(`\n${c.yellow}⚠️  Capability catalog chưa được khởi tạo.${c.reset}\n`);
        }
        continue;
      }

      // Lệnh xem và xử lý Approvals (/approvals)
      if (trimmed === '/approvals' || trimmed.startsWith('/approvals ')) {
        const parts = trimmed.split(' ');
        const subCmd = parts[1];
        const targetId = parts[2];
        const approvalMgr = (agentLoop.kernel?.ctx as any)?.approvals;

        if (!approvalMgr) {
          console.log(`\n${c.yellow}⚠️  Approval manager chưa được khởi tạo.${c.reset}\n`);
          continue;
        }

        if (subCmd === 'approve' && targetId) {
          const success = approvalMgr.resolveApproval(targetId, true, 'Approved by operator via CLI');
          if (success) {
            console.log(`\n${c.green}✔ Đã phê duyệt yêu cầu: ${targetId}${c.reset}\n`);
          } else {
            console.log(`\n${c.red}✖ Không thể phê duyệt yêu cầu: ${targetId}${c.reset}\n`);
          }
        } else if (subCmd === 'reject' && targetId) {
          const success = approvalMgr.resolveApproval(targetId, false, 'Rejected by operator via CLI');
          if (success) {
            console.log(`\n${c.yellow}⚠️  Đã từ chối yêu cầu: ${targetId}${c.reset}\n`);
          } else {
            console.log(`\n${c.red}✖ Không thể từ chối yêu cầu: ${targetId}${c.reset}\n`);
          }
        } else {
          CLI.renderApprovals(approvalMgr.getPending());
        }
        continue;
      }

      // Lệnh quản lý phân quyền (/permissions)
      if (trimmed === '/permissions' || trimmed.startsWith('/permissions ') || trimmed === '/permission' || trimmed.startsWith('/permission ')) {
        const parts = trimmed.split(/\s+/).slice(1);
        const sub = parts[0]?.toLowerCase();
        if (sub === 'reset') {
          kernel.ctx.permissions.clearSessionApprovals();
          console.log(`\n${c.green}✔ Đã reset toàn bộ danh mục auto-approved trong phiên này.${c.reset}\n`);
        } else if (['always_ask', 'ask_sensitive', 'auto_approve', 'read_only'].includes(sub)) {
          kernel.ctx.permissions.setMode(sub as any);
          console.log(`\n${c.green}✔ Đã chuyển chế độ phân quyền sang: ${c.bold}${sub}${c.reset}\n`);
        } else {
          CLI.renderPermissionStatus(kernel.ctx.permissions.getMode(), (kernel.ctx.permissions as any).sessionApprovedCategories?.size || 0);
        }
        continue;
      }

      // Lệnh đính kèm file/thư mục (/add hoặc /attach)
      if (trimmed === '/add' || trimmed.startsWith('/add ') || trimmed === '/attach' || trimmed.startsWith('/attach ')) {
        const parts = trimmed.split(/\s+/).slice(1);
        const targetPath = parts.join(' ').trim();
        if (!targetPath) {
          console.log(`\n${c.red}✖ Cách dùng:${c.reset} ${c.bold}/add <đường_dẫn_file_hoặc_thư_mục>${c.reset}`);
          console.log(`${c.gray}💡 Mẹo: Bạn có thể gõ trực tiếp @đường_dẫn ngay trong câu prompt (ví dụ: "Tối ưu @src/agent/agent-loop.ts")${c.reset}\n`);
          continue;
        }

        const res = await PromptAttachmentProcessor.resolveAndAttach(`@${targetPath}`, workspace);
        if (res.hasAttachments) {
          CLI.renderAttachmentSummary(res.attachments);
          console.log(`\n${c.green}✔ Đã đính kèm thành công:${c.reset} ${c.bold}${targetPath}${c.reset}\n`);
        } else {
          console.log(`\n${c.red}✖ Không tìm thấy file hoặc thư mục hợp lệ trong workspace:${c.reset} ${targetPath}\n`);
        }
        continue;
      }

      if (trimmed.toLowerCase() === '/exit' || trimmed.toLowerCase() === '/quit' || trimmed.toLowerCase() === 'exit') {
        console.log(`\n${c.green}Tạm biệt! Chúc bạn lập trình vui vẻ! 👋${c.reset}\n`);
        break;
      }

      // In hộp yêu cầu của User
      console.log(`\n${c.cyan}${c.bold}┌── 💬 USER REQUEST ─────────────────────────────────────────────────────────┐${c.reset}`);
      console.log(`${c.bold}${trimmed}${c.reset}`);
      console.log(`${c.cyan}${c.bold}└────────────────────────────────────────────────────────────────────────────┘${c.reset}`);

      // Tự động kiểm tra và đính kèm các File / Thư mục được @mention vào ngữ cảnh
      const attachmentResult = await PromptAttachmentProcessor.resolveAndAttach(trimmed, workspace);
      if (attachmentResult.hasAttachments) {
        CLI.renderAttachmentSummary(attachmentResult.attachments);
      }

      // Các prompt tiếp tục cùng một session và được flush xuống JSONL.
      sessionCount++;

      try {
        await agentLoop.submit(activeSession, attachmentResult.expandedPrompt);
      } catch (err: any) {
        console.error(`\n${c.red}${c.bold}❌ Lỗi thực thi Agent Loop:${c.reset}`, err.message);
        if (err.message && (err.message.includes('404') || err.message.includes('model_not_found'))) {
          console.log(`\n${c.yellow}💡 Gợi ý: Model này không tồn tại hoặc tài khoản/API key chưa được cấp quyền truy cập.`);
          console.log(`👉 Bạn có thể chuyển ngay sang các model đang hoạt động tốt với key có sẵn:`);
          console.log(`   - ${c.brightCyan}/model 1${c.yellow} : Google Gemini Flash (Đang có sẵn key)`);
          console.log(`   - ${c.brightCyan}/model 4${c.yellow} : Groq Llama 3.3 70B (Đang có sẵn key)`);
          console.log(`   - ${c.brightCyan}/model 25${c.yellow}: Pollinations GPT-4o-mini (Không cần key)${c.reset}\n`);
        } else if (err.message && err.message.includes('402')) {
          console.log(`\n${c.yellow}💡 Gợi ý: Tài khoản hiện tại đã hết số dư ($0.00).`);
          console.log(`👉 Bạn chỉ cần gõ ${c.brightCyan}/model 1${c.yellow} để chuyển sang ${c.bold}Google Gemini Flash (Miễn phí 100%)${c.yellow} hoặc ${c.brightCyan}/model 4${c.yellow} (Groq Free)!${c.reset}\n`);
        } else if (err.message && err.message.includes('401')) {
          console.log(`\n${c.yellow}💡 Gợi ý: API Key của nhà cung cấp này không hợp lệ hoặc đã hết hạn.`);
          console.log(`👉 Vui lòng kiểm tra lại file .env hoặc gõ ${c.brightCyan}/model 1${c.yellow} để dùng Gemini.${c.reset}\n`);
        }
      }
    }
  } finally {
    input.removeListener('keypress', handleInputKeypress);
    slashHints.dispose();
    rl.close();
    try {
      await kernel.ctx.sandbox.dispose();
    } catch {}
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
});
