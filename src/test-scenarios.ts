import dotenv from 'dotenv';
import { GeminiLLM } from './llm/gemini.js';
import { ToolRegistry } from './tools/registry.js';
import { AgentLoop } from './agent/agent-loop.js';
import { Session } from './session/session.js';
import { Workspace } from './workspace/workspace.js';
import { createGitTools } from './tools/git-tools.js';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

async function runScenario(title: string, prompt: string, maxSteps: number = 30) {
  console.log(`\n========================================`);
  console.log(`🎯 SCENARIO: ${title}`);
  console.log(`========================================`);

  console.log(`\n====================================`);
  console.log(`[USER_PROMPT]`);
  console.log(`====================================\n`);
  console.log(prompt);

  const workspace = new Workspace(process.cwd());
  const llm = new GeminiLLM(apiKey!, modelName);
  const toolRegistry = new ToolRegistry();
  for (const tool of createGitTools(workspace)) toolRegistry.register(tool);
  const agentLoop = new AgentLoop(llm, toolRegistry, { maxSteps, workspace });

  const session = new Session();
  session.addUserMessage(prompt);

  try {
    const result = await agentLoop.run(session);
    console.log(`\n✅ Hoàn thành kịch bản: "${title}"`);
    return result;
  } catch (err: any) {
    console.error(`\n❌ Lỗi kịch bản:`, err.message);
  }
}

async function main() {
  if (!apiKey) {
    console.log(`\n⚠️  GEMINI_API_KEY chưa được đặt trong .env.`);
    console.log(`Vui lòng tạo file .env với GEMINI_API_KEY để chạy thử nghiệm trực tiếp với Gemini API.`);
    console.log(`(Unit test đã có thể chạy trực tiếp qua 'npm test' hoặc 'npx tsx src/test-suite.ts')\n`);
    return;
  }

  console.log(`\n🚀 Bắt đầu kiểm thử các kịch bản Coding Agent với model: ${modelName}\n`);

  // Kịch bản 1: Khảo sát repository
  await runScenario(
    'Kịch bản 1: Khảo sát mã nguồn',
    'Tìm kiếm trong thư mục src xem class AgentLoop được định nghĩa ở đâu và đọc 15 dòng đầu tiên của file đó.'
  );

  // Kịch bản 2: Thực thi lệnh kiểm thử
  await runScenario(
    'Kịch bản 2: Kiểm tra trạng thái Git và Node version',
    'Dùng git_status để kiểm tra trạng thái Git và run_command để kiểm tra node version hiện tại của hệ thống.'
  );

  // Kịch bản 3: Tác vụ kiểm tra và sửa đổi code
  await runScenario(
    'Kịch bản 3: Phân tích dependencies',
    'Đọc file package.json, kiểm tra danh sách scripts và xác minh xem lệnh npm test chạy file nào.'
  );
}

main().catch(console.error);
