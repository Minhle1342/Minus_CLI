import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import { GeminiLLM } from './llm/gemini.js';
import { DeepseekLLM } from './llm/deepseek.js';
import { ToolRegistry } from './tools/registry.js';
import { AgentLoop } from './agent/agent-loop.js';
import { Session } from './session/session.js';
import { loadSession, saveSession, getSessionFilePath } from './session/persistent-session.js';
import { Workspace } from './workspace/workspace.js';
import { CLI, AVAILABLE_MODELS, colors as c } from './ui/cli-ui.js';
import { AgentKernel } from './kernel/kernel.js';
import { WorkspacePlugin } from './kernel/plugins/workspace-plugin.js';
import { PlanningPlugin } from './kernel/plugins/planning-plugin.js';
import { MemoryPlugin } from './kernel/plugins/memory-plugin.js';
import { SandboxPlugin } from './kernel/plugins/sandbox-plugin.js';
import { TaskPlugin } from './kernel/plugins/task-plugin.js';

// Load biến môi trường từ file .env
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const groqApiKey = process.env.GROQ_API_KEY || '';
const cerebrasApiKey = process.env.CEREBRAS_API_KEY || '';
const sambanovaApiKey = process.env.SAMBANOVA_API_KEY || '';
const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_API_KEY || '';
const siliconflowApiKey = process.env.SILICONFLOW_API_KEY || '';
const mistralApiKey = process.env.MISTRAL_API_KEY || '';
const openrouterApiKey = process.env.OPENROUTER_API_KEY || '';
const maxSteps = process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS, 10) : 30;

// Hàm hoàn thành tự động khi người dùng nhấn Tab
function completer(line: string): [string[], string] {
  const completions = ['/model', '/modal', '/workspace', '/cd', '/session', '/tools', '/status', '/clear', '/help', '/exit', '/quit'];
  const hits = completions.filter((c) => c.startsWith(line.toLowerCase()));
  return [hits.length ? hits : completions, line];
}

// Phân tích tham số dòng lệnh CLI (--workspace, --model, positional workspace)
function parseCommandLineArgs(): { cliWorkspace?: string; cliModel?: string } {
  const args = process.argv.slice(2);
  let cliWorkspace: string | undefined;
  let cliModel: string | undefined;

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
    } else if (!args[i].startsWith('-') && !cliWorkspace) {
      cliWorkspace = args[i];
    }
  }

  return { cliWorkspace, cliModel };
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
  return apiKey ? 'gemini-3.1-flash-lite-preview' : 'groq/llama-3.3-70b-versatile';
}

async function createLLM(model: string) {
  // 1. Google Gemini chính thức (Google AI Studio Free Tier)
  if (
    model.startsWith('gemini') ||
    model === 'gemini-3.1-flash-lite-preview' ||
    model === 'gemini-3.5-flash' ||
    model === 'gemini-2.5-pro' ||
    model === 'gemini-2.5-flash'
  ) {
    if (!apiKey) {
      throw new Error(`Chưa cấu hình GEMINI_API_KEY trong .env! Vui lòng lấy key miễn phí tại: https://aistudio.google.com/`);
    }
    return new GeminiLLM(apiKey, model);
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
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.groq.com/openai/v1');
  }

  // 3. Cerebras Cloud (Free Tier - 1M tokens/ngày, 1500+ tok/s)
  if (model.startsWith('cerebras/') || model === 'llama-3.3-70b' || model === 'llama3.1-8b') {
    const rawModel = model.replace(/^cerebras\//, '');
    const key = cerebrasApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình CEREBRAS_API_KEY trong file .env!\n👉 Vui lòng lấy API key miễn phí tại: https://cloud.cerebras.ai/ và dán vào CEREBRAS_API_KEY trong .env, hoặc chuyển sang model đã có sẵn key như /model 1 (Gemini) hoặc /model 4 (Groq).`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.cerebras.ai/v1');
  }

  // 4. SambaNova Cloud (Free Tier - Llama 405B)
  if (model.startsWith('sambanova/') || model.includes('405B') || model.startsWith('Meta-Llama')) {
    const rawModel = model.replace(/^sambanova\//, '');
    const key = sambanovaApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình SAMBANOVA_API_KEY trong file .env!\n👉 Vui lòng lấy key miễn phí tại: https://cloud.sambanova.ai/ và dán vào SAMBANOVA_API_KEY trong .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.sambanova.ai/v1');
  }

  // 5. GitHub Models (Free Tier via GitHub Token)
  if (model.startsWith('github/')) {
    const rawModel = model.replace(/^github\//, '');
    const key = githubToken;
    if (!key) {
      throw new Error(`Chưa cấu hình GITHUB_TOKEN trong file .env!\n👉 Vui lòng tạo Personal Access Token tại https://github.com/settings/tokens và dán vào GITHUB_TOKEN trong .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://models.inference.ai.azure.com');
  }

  // 6. SiliconFlow (Free Tier)
  if (model.startsWith('siliconflow/')) {
    const rawModel = model.replace(/^siliconflow\//, '');
    const key = siliconflowApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình SILICONFLOW_API_KEY trong file .env!\n👉 Vui lòng lấy key tại https://siliconflow.cn/ và dán vào .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.siliconflow.cn/v1');
  }

  // 7. Mistral AI (Codestral Free Tier)
  if (model.startsWith('mistral/')) {
    const rawModel = model.replace(/^mistral\//, '');
    const key = mistralApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình MISTRAL_API_KEY trong file .env!\n👉 Vui lòng lấy key miễn phí tại https://console.mistral.ai/ và dán vào .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://api.mistral.ai/v1');
  }

  // 8. Pollinations AI (Zero-Key Free Community - Không cần API Key)
  if (model.startsWith('pollinations/')) {
    const rawModel = model.replace(/^pollinations\//, '');
    return new DeepseekLLM('dummy_key', rawModel, undefined, 'https://text.pollinations.ai/openai');
  }

  // 9. OpenRouter Free Models & Direct OpenRouter
  if (model.startsWith('openrouter/') || model.endsWith(':free') || model.includes('/')) {
    const rawModel = model.replace(/^openrouter\//, '');
    const key = openrouterApiKey || deepseekApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình OPENROUTER_API_KEY trong file .env!\n👉 Vui lòng lấy key tại https://openrouter.ai/keys và dán vào .env.`);
    }
    return new DeepseekLLM(key, rawModel, undefined, 'https://openrouter.ai/api/v1');
  }

  // 10. DeepSeek Direct (V3 / R1)
  if (model === 'deepseek-chat' || model === 'deepseek-reasoner') {
    const key = deepseekApiKey;
    if (!key) {
      throw new Error(`Chưa cấu hình DEEPSEEK_API_KEY trong file .env!\n👉 Vui lòng lấy key tại https://platform.deepseek.com/ và dán vào .env.`);
    }
    return new DeepseekLLM(key, model, undefined, 'https://api.deepseek.com');
  }

  // Fallback mặc định
  if (apiKey) {
    return new GeminiLLM(apiKey, model);
  }
  if (groqApiKey) {
    return new DeepseekLLM(groqApiKey, model, undefined, 'https://api.groq.com/openai/v1');
  }
  return new DeepseekLLM(deepseekApiKey || 'dummy_key', model);
}

async function main() {
  const hasAnyKey = apiKey || deepseekApiKey || groqApiKey || cerebrasApiKey || sambanovaApiKey || githubToken || siliconflowApiKey || mistralApiKey || openrouterApiKey;
  if (!hasAnyKey) {
    console.error(`\n${c.red}${c.bold}❌ LỖI KHỞI ĐỘNG:${c.reset} Chưa cấu hình API Key trong file .env!`);
    console.error(`${c.gray}Vui lòng mở file .env và điền ít nhất một trong các API key miễn phí:${c.reset}`);
    console.error(`  ${c.cyan}GEMINI_API_KEY=AIzaSy...${c.reset} (Google AI Studio)`);
    console.error(`  ${c.cyan}GROQ_API_KEY=gsk_...${c.reset} (Groq Cloud)`);
    console.error(`  ${c.cyan}CEREBRAS_API_KEY=csk-...${c.reset} (Cerebras Cloud)`);
    console.error(`  ${c.cyan}SAMBANOVA_API_KEY=...${c.reset} (SambaNova Cloud)`);
    console.error(`  ${c.cyan}GITHUB_TOKEN=ghp_...${c.reset} (GitHub Models)`);
    console.error(`  ${c.cyan}SILICONFLOW_API_KEY=sk-...${c.reset} (SiliconFlow)`);
    console.error(`  ${c.cyan}MISTRAL_API_KEY=...${c.reset} (Mistral AI)`);
    console.error(`  ${c.cyan}OPENROUTER_API_KEY=sk-or-v1-...${c.reset} (OpenRouter)\n`);
    process.exit(1);
  }

  // 1. Tải cấu hình phiên làm việc đã lưu từ trước (Model name & Workspace path)
  const { cliWorkspace, cliModel } = parseCommandLineArgs();
  const savedSession = loadSession();

  const initialPath = getInitialWorkspacePath(savedSession.workspacePath, cliWorkspace);
  let modelName = getInitialModelName(savedSession.modelName, cliModel);

  let workspace = new Workspace(initialPath);
  let llm = await createLLM(modelName);

  // Tự động lưu cấu hình phiên làm việc hiện tại
  saveSession({
    modelName,
    workspacePath: workspace.rootDir,
  });

  const kernel = new AgentKernel(workspace, llm);
  await kernel.use(WorkspacePlugin);
  await kernel.use(PlanningPlugin);
  await kernel.use(MemoryPlugin);
  await kernel.use(SandboxPlugin);
  await kernel.use(TaskPlugin);
  await kernel.init();

  // Lắng nghe sự kiện thay đổi workspace hoặc model từ Kernel để tự động đồng bộ xuống đĩa
  kernel.ctx.events.on('workspace:changed', (_oldPath: string, newPath: string) => {
    saveSession({ workspacePath: newPath });
  });
  kernel.ctx.events.on('model:changed', (newModel: string) => {
    saveSession({ modelName: newModel });
  });

  const toolRegistry = kernel.ctx.tools;
  const agentLoop = new AgentLoop(kernel, undefined, { maxSteps, workspace });

  let sessionCount = 0;

  // Hiển thị Banner mở đầu
  CLI.renderBanner({
    modelName,
    workspaceRoot: workspace.rootDir,
    maxSteps,
    tools: toolRegistry.getAll().map((t) => t.name),
  });

  const rl = readline.createInterface({ input, output, completer });

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
        continue;
      }

      if (trimmed === '/status') {
        CLI.renderStatus({
          modelName,
          workspaceRoot: workspace.rootDir,
          maxSteps,
          sessionTurns: sessionCount,
          sessionFile: getSessionFilePath(),
        });
        continue;
      }

      if (trimmed === '/clear') {
        console.clear();
        CLI.renderBanner({
          modelName,
          workspaceRoot: workspace.rootDir,
          maxSteps,
          tools: toolRegistry.getAll().map((t) => t.name),
        });
        continue;
      }

      // Lệnh hoàn tác (/undo hoặc /rollback)
      if (trimmed === '/undo' || trimmed === '/rollback') {
        try {
          const rollbackRes = await agentLoop.rollback();
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
          workspace = new Workspace(resolvedPath);
          agentLoop.setWorkspace(workspace);
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
          const newLLM = await createLLM(targetModel);
          agentLoop.setLLM(newLLM, targetModel);
          modelName = targetModel;
          saveSession({ modelName });
          console.log(`\n${c.green}✔ Đã kích hoạt mô hình:${c.reset} ${c.bold}${c.brightCyan}${modelName}${c.reset} ${c.gray}(Đã lưu cho các phiên sau)${c.reset}\n`);
        } catch (err: any) {
          console.error(`\n${c.red}✖ Lỗi khi đổi model:${c.reset}`, err.message);
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

      // Mỗi tác vụ tạo một Session mới độc lập
      const session = new Session();
      session.addUserMessage(trimmed);
      sessionCount++;

      try {
        await agentLoop.run(session);
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
    rl.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
});
