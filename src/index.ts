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
import { Workspace } from './workspace/workspace.js';
import { CLI, AVAILABLE_MODELS, colors as c } from './ui/cli-ui.js';
import { AgentKernel } from './kernel/kernel.js';
import { WorkspacePlugin } from './kernel/plugins/workspace-plugin.js';
import { PlanningPlugin } from './kernel/plugins/planning-plugin.js';
import { MemoryPlugin } from './kernel/plugins/memory-plugin.js';

// Load biến môi trường từ file .env
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
const groqApiKey = process.env.GROQ_API_KEY || '';
let modelName = process.env.MODEL_NAME || (apiKey ? 'gemini-3.1-flash-lite-preview' : 'deepseek-chat');
const maxSteps = process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS, 10) : 30;

// Hàm hoàn thành tự động khi người dùng nhấn Tab
function completer(line: string): [string[], string] {
  const completions = ['/model', '/modal', '/workspace', '/cd', '/tools', '/status', '/clear', '/help', '/exit', '/quit'];
  const hits = completions.filter((c) => c.startsWith(line.toLowerCase()));
  return [hits.length ? hits : completions, line];
}

// Phân tích tham số dòng lệnh để lấy workspace (nếu có)
function getInitialWorkspacePath(): string {
  // 1. Kiểm tra tham số CLI: ví dụ `npm run dev -- /path/to/project` hoặc `--workspace=/path`
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      return args[i + 1];
    }
    if (args[i].startsWith('--workspace=')) {
      return args[i].split('=')[1];
    }
    if (!args[i].startsWith('-')) {
      return args[i];
    }
  }

  // 2. Kiểm tra biến môi trường .env
  if (process.env.WORKSPACE_DIR) {
    return process.env.WORKSPACE_DIR;
  }
  if (process.env.WORKSPACE_PATH) {
    return process.env.WORKSPACE_PATH;
  }

  // 3. Mặc định là thư mục làm việc hiện tại
  return process.cwd();
}

async function createLLM(model: string) {
  // 1. Nhóm model chạy trên Groq Cloud (Gemma 2 9B siêu tốc)
  if (model === 'gemma2-9b-it' || model.startsWith('groq/')) {
    const key = groqApiKey || deepseekApiKey;
    if (!key) {
      console.log(`\n${c.yellow}⚠️  Cảnh báo: Chưa tìm thấy GROQ_API_KEY trong .env!${c.reset}`);
      console.log(`${c.gray}Lấy key miễn phí tại: https://console.groq.com/keys${c.reset}`);
    }
    return new DeepseekLLM(key, model.replace('groq/', ''), undefined, 'https://api.groq.com/openai/v1');
  }

  // 2. Nhóm model OpenRouter / DeepSeek / Gemma qua OpenAI-compatible endpoint
  if (
    model.startsWith('deepseek') ||
    model.includes('deepseek') ||
    model.startsWith('openrouter') ||
    model.startsWith('google/gemma') ||
    model.startsWith('gemma') ||
    model.includes('/')
  ) {
    const key = deepseekApiKey || groqApiKey;
    if (!key) {
      console.log(`\n${c.yellow}⚠️  Cảnh báo: Chưa tìm thấy DEEPSEEK_API_KEY / OPENROUTER key trong .env!${c.reset}`);
    }
    return new DeepseekLLM(key, model);
  }

  // 3. Nhóm model Google Gemini chính thức (gemini-3.1-flash-lite-preview, gemini-3.5-flash, gemini-2.5-pro, etc.)
  if (!apiKey) {
    console.log(`\n${c.yellow}⚠️  Cảnh báo: Chưa tìm thấy GEMINI_API_KEY trong .env!${c.reset}`);
  }
  return new GeminiLLM(apiKey, model);
}

async function main() {
  if (!apiKey && !deepseekApiKey && !groqApiKey) {
    console.error(`\n${c.red}${c.bold}❌ LỖI KHỞI ĐỘNG:${c.reset} Chưa cấu hình API Key trong file .env!`);
    console.error(`${c.gray}Vui lòng mở file .env và điền GEMINI_API_KEY, DEEPSEEK_API_KEY hoặc GROQ_API_KEY:${c.reset}`);
    console.error(`  ${c.cyan}GEMINI_API_KEY=AIzaSy...${c.reset}`);
    console.error(`  ${c.cyan}DEEPSEEK_API_KEY=sk-...${c.reset}`);
    console.error(`  ${c.cyan}GROQ_API_KEY=gsk_...${c.reset}\n`);
    process.exit(1);
  }

  // Khởi tạo Micro-Kernel với Workspace linh hoạt
  const initialPath = getInitialWorkspacePath();
  let workspace = new Workspace(initialPath);
  let llm = await createLLM(modelName);

  const kernel = new AgentKernel(workspace, llm);
  await kernel.use(WorkspacePlugin);
  await kernel.use(PlanningPlugin);
  await kernel.use(MemoryPlugin);
  await kernel.init();

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

      if (trimmed === '/status') {
        CLI.renderStatus({
          modelName,
          workspaceRoot: workspace.rootDir,
          maxSteps,
          sessionTurns: sessionCount,
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
          agentLoop.setLLM(newLLM);
          modelName = targetModel;
          console.log(`\n${c.green}✔ Đã kích hoạt mô hình:${c.reset} ${c.bold}${c.brightCyan}${modelName}${c.reset}\n`);
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
        if (err.message && err.message.includes('402')) {
          console.log(`\n${c.yellow}💡 Gợi ý: Tài khoản DeepSeek/OpenRouter hiện tại của bạn đã hết số dư ($0.00).`);
          console.log(`👉 Bạn chỉ cần gõ ${c.brightCyan}/model 1${c.yellow} để chuyển ngay sang ${c.bold}Google Gemini Flash (Miễn phí 100%)${c.yellow} và tiếp tục làm việc!${c.reset}\n`);
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
