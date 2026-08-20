import path from 'node:path';

// ANSI escape codes for styling without external dependencies
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m',

  // Background colors
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgBlack: '\x1b[40m',
  bgDarkGray: '\x1b[100m',
};

const c = colors;

export interface BannerOptions {
  modelName: string;
  workspaceRoot: string;
  maxSteps: number;
  tools: string[];
}

export interface StatusOptions {
  modelName: string;
  workspaceRoot: string;
  maxSteps: number;
  sessionTurns: number;
  sessionFile?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  desc: string;
  recommended?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  // 1. Google AI Studio (Free Tier: 1.500 req/ngày, 1M context)
  {
    id: '1',
    name: 'gemini-3.1-flash-lite-preview',
    provider: 'Google AI Studio',
    desc: 'Free Tier 1.500 req/ngày, phản hồi cực nhanh, gọi tool chuẩn xác',
    recommended: true,
  },
  {
    id: '2',
    name: 'gemini-2.5-flash',
    provider: 'Google AI Studio',
    desc: 'Free Tier, cân bằng giữa tốc độ và khả năng lập trình toàn diện',
  },
  {
    id: '3',
    name: 'gemini-2.5-pro',
    provider: 'Google AI Studio',
    desc: 'Free Tier, khả năng suy luận sâu và context khổng lồ 1M tokens',
  },

  // 2. Groq Cloud (Free Tier: Siêu tốc độ LPU >500 tokens/s)
  {
    id: '4',
    name: 'groq/llama-3.3-70b-versatile',
    provider: 'Groq Cloud (Free)',
    desc: 'Llama 3.3 70B chạy trên chip LPU siêu tốc ~300 tok/s, rất thông minh',
    recommended: true,
  },
  {
    id: '5',
    name: 'groq/deepseek-r1-distill-llama-70b',
    provider: 'Groq Cloud (Free)',
    desc: 'DeepSeek R1 reasoning suy luận từng bước siêu tốc trên Groq',
  },
  {
    id: '6',
    name: 'groq/llama-3.1-8b-instant',
    provider: 'Groq Cloud (Free)',
    desc: 'Llama 3.1 8B phản hồi tức thì ~600 tokens/s, cực kỳ nhẹ',
  },
  {
    id: '7',
    name: 'groq/gemma2-9b-it',
    provider: 'Groq Cloud (Free)',
    desc: 'Google Gemma 2 9B chạy trên Groq LPU',
  },

  // 3. Cerebras Cloud (Free Tier: 1.000.000 tokens/ngày, 1.500+ tokens/s)
  {
    id: '8',
    name: 'cerebras/llama-3.3-70b',
    provider: 'Cerebras Cloud (Free)',
    desc: 'Llama 3.3 70B, tốc độ kỷ lục ~1.800 tok/s, hạn mức 1M tokens/ngày',
  },
  {
    id: '9',
    name: 'cerebras/llama3.1-8b',
    provider: 'Cerebras Cloud (Free)',
    desc: 'Llama 3.1 8B siêu tốc ~2.000 tok/s, 1M tokens/ngày',
  },

  // 4. SambaNova Cloud (Free Tier: Model Llama 405B Siêu Lớn)
  {
    id: '10',
    name: 'sambanova/Meta-Llama-3.1-405B-Instruct',
    provider: 'SambaNova Cloud (Free)',
    desc: 'Model Llama 405B khổng lồ chạy miễn phí cho Developer',
  },
  {
    id: '11',
    name: 'sambanova/Meta-Llama-3.3-70B-Instruct',
    provider: 'SambaNova Cloud (Free)',
    desc: 'Llama 3.3 70B trên kiến trúc chip SN40L cực mạnh',
  },
  {
    id: '12',
    name: 'sambanova/DeepSeek-R1-Distill-Llama-70B',
    provider: 'SambaNova Cloud (Free)',
    desc: 'DeepSeek R1 70B reasoning trên hạ tầng SambaNova',
  },

  // 5. GitHub Models (Free Tier: Dùng GitHub Token)
  {
    id: '13',
    name: 'github/gpt-4o',
    provider: 'GitHub Models (Free)',
    desc: 'GPT-4o chính thức miễn phí qua GitHub Token / Azure endpoint',
  },
  {
    id: '14',
    name: 'github/gpt-4o-mini',
    provider: 'GitHub Models (Free)',
    desc: 'GPT-4o Mini tốc độ cao qua GitHub Token',
  },
  {
    id: '15',
    name: 'github/Mistral-large-2407',
    provider: 'GitHub Models (Free)',
    desc: 'Mistral Large 128k context qua GitHub Models',
  },

  // 6. SiliconFlow / SiliconCloud (Free Tier)
  {
    id: '16',
    name: 'siliconflow/deepseek-ai/DeepSeek-V3',
    provider: 'SiliconFlow (Free)',
    desc: 'DeepSeek V3 671B qua hạ tầng SiliconFlow',
  },
  {
    id: '17',
    name: 'siliconflow/deepseek-ai/DeepSeek-R1',
    provider: 'SiliconFlow (Free)',
    desc: 'DeepSeek R1 suy luận chuyên sâu',
  },
  {
    id: '18',
    name: 'siliconflow/Qwen/Qwen2.5-Coder-32B-Instruct',
    provider: 'SiliconFlow (Free)',
    desc: 'Qwen 2.5 Coder 32B chuyên gia lập trình hàng đầu',
  },

  // 7. Mistral AI (Codestral Free Tier)
  {
    id: '19',
    name: 'mistral/codestral-latest',
    provider: 'Mistral AI (Free)',
    desc: 'Codestral chuyên gia lập trình của Mistral (Free dev key)',
  },
  {
    id: '20',
    name: 'mistral/mistral-large-latest',
    provider: 'Mistral AI (Free)',
    desc: 'Mistral Large mô hình mạnh nhất của Mistral',
  },

  // 8. OpenRouter (Free Router & Free Models)
  {
    id: '21',
    name: 'openrouter/free',
    provider: 'OpenRouter (Free)',
    desc: 'Tự động định tuyến sang model miễn phí tốt nhất trên OpenRouter',
  },
  {
    id: '22',
    name: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
    provider: 'OpenRouter (Free)',
    desc: 'Llama 3.3 70B miễn phí qua OpenRouter',
  },
  {
    id: '23',
    name: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'OpenRouter (Free)',
    desc: 'DeepSeek R1 miễn phí qua OpenRouter',
  },
  {
    id: '24',
    name: 'openrouter/google/gemini-2.0-flash-exp:free',
    provider: 'OpenRouter (Free)',
    desc: 'Gemini 2.0 Flash Experimental miễn phí qua OpenRouter',
  },

  // 9. Pollinations AI (Zero-Key Free: Không cần tạo API Key)
  {
    id: '25',
    name: 'pollinations/openai',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'GPT-4o-mini miễn phí 100%, không cần đăng ký tài khoản hay API key',
  },
  {
    id: '26',
    name: 'pollinations/mistral',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'Mistral miễn phí 100%, không cần đăng ký tài khoản hay API key',
  },

  // 10. DeepSeek Direct (Chính thức)
  {
    id: '27',
    name: 'deepseek-chat',
    provider: 'DeepSeek Direct',
    desc: 'DeepSeek V3 chính thức (cần key platform.deepseek.com)',
  },
  {
    id: '28',
    name: 'deepseek-reasoner',
    provider: 'DeepSeek Direct',
    desc: 'DeepSeek R1 reasoning chính thức (cần key platform.deepseek.com)',
  },
];

export class CLI {
  /**
   * Hiển thị Banner mở đầu phong cách chuyên nghiệp
   */
  static renderBanner(opts: BannerOptions): void {
    console.log(`\n${c.cyan}${c.bold}╭────────────────────────────────────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightYellow}⚡ AUTONOMOUS CODING AGENT${c.reset} ${c.gray}v2.0${c.reset}                                    ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.dim}Minimalist AI Pair Programmer (TypeScript + Node.js)${c.reset}                 ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}├────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.magenta}🤖 Model:${c.reset}     ${c.bold}${opts.modelName}${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.blue}📂 Workspace:${c.reset} ${c.dim}${opts.workspaceRoot}${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.yellow}🛡️  Max Steps:${c.reset} ${c.bold}${opts.maxSteps}${c.reset} steps per request`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.green}🛠️  Tools (${opts.tools.length}):${c.reset} ${c.dim}${opts.tools.join(', ')}${c.reset}`);
    console.log(`${c.cyan}${c.bold}├────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.gray}Nhập ${c.brightCyan}/${c.gray} hoặc ${c.brightCyan}/help${c.gray} để xem gợi ý lệnh nhanh, ${c.brightCyan}/model${c.gray} để đổi model.${c.reset}    ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thanh gợi ý lệnh nhanh khi người dùng nhập "/"
   */
  static renderQuickCommands(): void {
    console.log(`\n${c.cyan}${c.bold}╭── ⚡ GỢI Ý CÂU LỆNH NHANH (SLASH COMMANDS) ────────────────────────────────╮${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/model${c.reset}          ${c.gray}Danh sách và chọn mô hình LLM (Gemini, Groq, Cerebras,...) [Auto-saved]${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/workspace${c.reset}      ${c.gray}Xem hoặc đổi thư mục workspace (/cd <path>) [Auto-saved]         ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/session${c.reset}        ${c.gray}Xem thông tin cấu hình phiên làm việc đã lưu (.codingagent)      ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/sandbox${c.reset}        ${c.gray}Xem trạng thái môi trường cô lập Sandbox (Docker/Local)          ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/tasks${c.reset}          ${c.gray}Xem danh sách background tasks & subprocesses đang chạy          ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/plan${c.reset}           ${c.gray}Xem cây kế hoạch thực thi hiện tại (Plan Tree)                   ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/memory${c.reset}         ${c.gray}Xem bộ nhớ dài hạn của dự án (.codingagent/ memory)              ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/undo${c.reset}           ${c.gray}Hoàn tác (Rollback) các thay đổi file của bước gần nhất          ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/checkpoints${c.reset}    ${c.gray}Xem lịch sử các điểm snapshot đã lưu tự động                     ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/tools${c.reset}          ${c.gray}Xem chi tiết 13 công cụ khảo sát, sửa code, background & nhớ     ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/status${c.reset}         ${c.gray}Xem thống kê trạng thái phiên làm việc                           ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/clear${c.reset}          ${c.gray}Xoá màn hình terminal                                            ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/help${c.reset}           ${c.gray}Xem toàn bộ hướng dẫn & ví dụ tác vụ                             ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/exit${c.reset}           ${c.gray}Thoát chương trình                                               ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các model có sẵn để người dùng chọn
   */
  static renderModelSelector(currentModel: string): void {
    console.log(`\n${c.magenta}${c.bold}╭── 🤖 DANH SÁCH MÔ HÌNH KHẢ DỤNG (SELECT MODEL) ───────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}                                                                            ${c.magenta}${c.bold}│${c.reset}`);
    
    let lastProvider = '';
    for (const m of AVAILABLE_MODELS) {
      if (m.provider !== lastProvider) {
        lastProvider = m.provider;
        console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}❖ ${m.provider.toUpperCase()}${c.reset}`);
      }

      const isCurrent = m.name === currentModel;
      const marker = isCurrent ? ` ${c.brightGreen}${c.bold}* [ACTIVE]${c.reset}` : '';
      const recBadge = m.recommended ? ` ${c.brightYellow}(Recommended)${c.reset}` : '';
      
      console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightCyan}${c.bold}[${m.id.padStart(2, ' ')}]${c.reset} ${c.bold}${m.name}${c.reset}${recBadge}${marker}`);
      console.log(`${c.magenta}${c.bold}│${c.reset}         ${c.dim}${m.desc}${c.reset}`);
      console.log(`${c.magenta}${c.bold}│${c.reset}`);
    }

    console.log(`${c.magenta}${c.bold}├────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.gray}👉 Nhập số thứ tự ${c.brightCyan}[1-${AVAILABLE_MODELS.length}]${c.gray} hoặc ${c.brightCyan}tên model bất kỳ${c.gray} để đổi mô hình:${c.reset}         ${c.magenta}${c.bold}│${c.reset}`);
    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị bảng trợ giúp
   */
  static renderHelp(): void {
    console.log(`\n${c.cyan}${c.bold}╭── 📖 CODING AGENT COMMANDS & HELP ────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}                                                                            ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}SLASH COMMANDS:${c.reset}                                                           ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/help${c.reset}               Hiển thị bảng trợ giúp này                          ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/model${c.reset}              Hiển thị danh sách và chọn mô hình LLM (Tự động lưu) ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/model <name>${c.reset}       Chuyển đổi trực tiếp sang mô hình chỉ định          ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/workspace${c.reset}          Xem đường dẫn thư mục workspace hiện tại            ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/workspace <path>${c.reset}   Chuyển workspace sang thư mục mới (Tự động lưu)     ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/session${c.reset}            Xem thông tin model và workspace lưu từ phiên trước  ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/sandbox${c.reset}            Xem trạng thái môi trường cô lập Sandbox            ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/tasks${c.reset}              Xem danh sách background tasks & subprocesses       ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/plan${c.reset}               Xem cây kế hoạch thực thi hiện tại (Plan Tree)      ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/memory${c.reset}             Xem bộ nhớ dài hạn của dự án (.codingagent)         ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/undo${c.reset}               Hoàn tác (Rollback) về checkpoint trước khi sửa     ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/checkpoints${c.reset}        Xem danh sách các điểm khôi phục snapshot           ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/tools${c.reset}              Liệt kê chi tiết 13 công cụ và thông số             ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/status${c.reset}             Xem thông tin trạng thái phiên làm việc             ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/clear${c.reset}              Xoá màn hình terminal                               ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/exit${c.reset}, ${c.brightCyan}/quit${c.reset}        Thoát chương trình                                  ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}                                                                            ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}VÍ DỤ TÁC VỤ THỰC TẾ:${c.reset}                                                     ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Tìm trong src xem class AgentLoop ở file nào${c.reset}                         ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Đọc package.json và giải thích các scripts${c.reset}                           ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Kiểm tra xem có bug nào trong src/tools/read-file.ts không${c.reset}           ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Sửa file test và chạy npm test để kiểm chứng${c.reset}                           ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Liệt kê danh mục Tool
   */
  static renderTools(toolList: Array<{ name: string; description: string }>): void {
    console.log(`\n${c.green}${c.bold}╭── 🛠️  REGISTERED TOOL CATALOG (${toolList.length} Tools) ───────────────────────────────╮${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}                                                                            ${c.green}${c.bold}│${c.reset}`);
    for (const tool of toolList) {
      console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}◆ ${tool.name}${c.reset}`);
      console.log(`${c.green}${c.bold}│${c.reset}    ${c.dim}${tool.description}${c.reset}`);
      console.log(`${c.green}${c.bold}│${c.reset}`);
    }
    console.log(`${c.green}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông tin workspace hiện tại
   */
  static renderWorkspaceInfo(workspaceRoot: string): void {
    console.log(`\n${c.blue}${c.bold}╭── 📂 ACTIVE WORKSPACE ─────────────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.bold}Đường dẫn:${c.reset} ${c.brightCyan}${workspaceRoot}${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.gray}Để đổi thư mục, dùng: ${c.cyan}/workspace <đường_dẫn_mới>${c.gray} hoặc ${c.cyan}/cd <path>${c.reset}`);
    console.log(`${c.blue}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông báo khi thay đổi workspace thành công
   */
  static renderWorkspaceChanged(oldPath: string, newPath: string): void {
    console.log(`\n${c.green}${c.bold}╭── 📂 ĐỔI WORKSPACE THÀNH CÔNG ─────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.gray}Thư mục cũ:${c.reset} ${c.dim}${oldPath}${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightGreen}${c.bold}Thư mục mới:${c.reset} ${c.brightCyan}${c.bold}${newPath}${c.reset}`);
    console.log(`${c.green}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các Shadow Git Checkpoints đã lưu
   */
  static renderCheckpoints(checkpoints: Array<{ index: number; timestamp: string; description: string }>): void {
    console.log(`\n${c.yellow}${c.bold}╭── 🛡️  SHADOW GIT CHECKPOINTS HISTORY (${checkpoints.length} Snapshots) ────────────────╮${c.reset}`);
    console.log(`${c.yellow}${c.bold}│${c.reset}                                                                            ${c.yellow}${c.bold}│${c.reset}`);
    if (checkpoints.length === 0) {
      console.log(`${c.yellow}${c.bold}│${c.reset}  ${c.dim}Chưa có checkpoint nào được tạo trong phiên làm việc này.${c.reset}`);
    } else {
      for (const cp of checkpoints) {
        console.log(`${c.yellow}${c.bold}│${c.reset}  ${c.brightCyan}#${cp.index}${c.reset} [${c.gray}${cp.timestamp}${c.reset}] ${c.bold}${cp.description}${c.reset}`);
      }
    }
    console.log(`${c.yellow}${c.bold}│${c.reset}                                                                            ${c.yellow}${c.bold}│${c.reset}`);
    console.log(`${c.yellow}${c.bold}│${c.reset}  ${c.gray}Dùng lệnh ${c.brightCyan}/undo${c.gray} để hoàn tác về checkpoint gần nhất.${c.reset}                   ${c.yellow}${c.bold}│${c.reset}`);
    console.log(`${c.yellow}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị Cây kế hoạch động (Dynamic Plan Tree)
   */
  static renderPlan(tasks: Array<{ id: number; title: string; status: string; notes?: string }>): void {
    console.log(`\n${c.brightCyan}${c.bold}╭── 📋 DYNAMIC EXECUTION PLAN (${tasks.length} Steps) ──────────────────────────────╮${c.reset}`);
    console.log(`${c.brightCyan}${c.bold}│${c.reset}                                                                            ${c.brightCyan}${c.bold}│${c.reset}`);
    
    for (const t of tasks) {
      let icon = `${c.dim}[ ]${c.reset}`;
      let titleStyle = c.dim;

      if (t.status === 'COMPLETED') {
        icon = `${c.brightGreen}[✔]${c.reset}`;
        titleStyle = `${c.green}${c.bold}`;
      } else if (t.status === 'IN_PROGRESS') {
        icon = `${c.brightYellow}[⚡]${c.reset}`;
        titleStyle = `${c.brightYellow}${c.bold}`;
      } else if (t.status === 'FAILED') {
        icon = `${c.red}[✖]${c.reset}`;
        titleStyle = `${c.red}${c.bold}`;
      } else if (t.status === 'SKIPPED') {
        icon = `${c.gray}[⊘]${c.reset}`;
        titleStyle = c.gray;
      }

      console.log(`${c.brightCyan}${c.bold}│${c.reset}  ${icon} ${c.bold}${t.id}.${c.reset} ${titleStyle}${t.title}${c.reset}`);
      if (t.notes) {
        console.log(`${c.brightCyan}${c.bold}│${c.reset}      ${c.dim}↳ ${t.notes}${c.reset}`);
      }
    }

    console.log(`${c.brightCyan}${c.bold}│${c.reset}                                                                            ${c.brightCyan}${c.bold}│${c.reset}`);
    console.log(`${c.brightCyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị cảnh báo Self-Reflection & Debugging Protocol
   */
  static renderReflectionAlert(failures: number, advice?: string): void {
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.brightYellow}⚠️  [SELF-REFLECTION TRIGGERED]${c.reset} ${c.yellow}Phát hiện lỗi (Thất bại liên tiếp: ${failures})${c.reset}`);
    if (advice) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}↳ Hướng dẫn: ${advice}${c.reset}`);
    }
  }

  /**
   * Hiển thị Bộ nhớ dài hạn của dự án (Project Knowledge Base)
   */
  static renderMemory(data: any): void {
    console.log(`\n${c.magenta}${c.bold}╭── 🧠 PROJECT KNOWLEDGE BASE (.codingagent/project-memory.json) ───────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Dự án:${c.reset}       ${c.brightCyan}${data.projectName}${c.reset} (${c.dim}${data.projectType}${c.reset})`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Package Mgr:${c.reset} ${c.yellow}${data.packageManager}${c.reset}`);
    
    const scriptKeys = Object.keys(data.scripts || {});
    if (scriptKeys.length > 0) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Scripts:${c.reset}     ${c.dim}${scriptKeys.map((k: string) => `${k} (npm run ${k})`).slice(0, 4).join(', ')}${c.reset}`);
    }

    const insights = data.learnedInsights || [];
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Kinh nghiệm:${c.reset} ${c.brightGreen}${insights.length} quy ước đã ghi nhớ${c.reset}`);
    if (insights.length > 0) {
      for (const item of insights.slice(-4)) {
        console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightYellow}◆ [${item.key}]${c.reset} ${c.dim}${item.insight}${c.reset}`);
      }
    }

    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị trạng thái môi trường Sandbox
   */
  static renderSandbox(status: any): void {
    console.log(`\n${c.green}${c.bold}╭── 🛡️  EXECUTION SANDBOX STATUS ───────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Provider:${c.reset}        ${c.brightCyan}${status.activeProvider}${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Chế độ:${c.reset}          ${c.yellow}${status.mode.toUpperCase()}${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Cách ly (Isolated):${c.reset} ${status.isIsolated ? `${c.brightGreen}✔ CÔ LẬP HOÀN TOÀN (Docker)` : `${c.yellow}⚠ HOST OS (Có bộ lọc Allowlist)`}${c.reset}`);
    if (status.containerId) {
      console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Container ID:${c.reset}    ${c.dim}${status.containerId}${c.reset}`);
      console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Docker Image:${c.reset}    ${c.dim}${status.image}${c.reset}`);
    }
    console.log(`${c.green}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các Background Tasks đang chạy
   */
  static renderTasks(tasks: Array<{ id: string; command: string; status: string; startedAt: string; pid?: number }>): void {
    console.log(`\n${c.cyan}${c.bold}╭── ⚙️  BACKGROUND PROCESSES & TASKS (${tasks.length}) ────────────────────────╮${c.reset}`);
    if (tasks.length === 0) {
      console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.dim}Không có background task nào đang chạy.${c.reset}`);
    } else {
      for (const t of tasks) {
        const statusBadge = t.status === 'running'
          ? `${c.brightGreen}RUNNING (PID: ${t.pid || 'N/A'})${c.reset}`
          : `${c.gray}STOPPED${c.reset}`;
        console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.bold}[${t.id}]${c.reset} ${c.brightCyan}${t.command}${c.reset} ── ${statusBadge} ${c.dim}(Khởi chạy lúc: ${t.startedAt})${c.reset}`);
      }
    }
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị trạng thái hiện tại
   */
  static renderStatus(opts: StatusOptions): void {
    console.log(`\n${c.magenta}${c.bold}╭── 📊 SESSION TELEMETRY & STATUS ───────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Model:${c.reset}         ${c.brightCyan}${opts.modelName}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Workspace:${c.reset}     ${c.dim}${opts.workspaceRoot}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Max Steps:${c.reset}     ${c.yellow}${opts.maxSteps} steps${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Session Turns:${c.reset} ${c.green}${opts.sessionTurns} completed${c.reset}`);
    if (opts.sessionFile) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Persisted in:${c.reset}  ${c.dim}${opts.sessionFile}${c.reset}`);
    }
    console.log(`${c.magenta}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông tin cấu hình phiên làm việc đã lưu trữ (.codingagent/session.json)
   */
  static renderSessionInfo(data: { modelName?: string; workspacePath?: string; lastUpdated?: string }, sessionFile: string): void {
    console.log(`\n${c.magenta}${c.bold}╭── 💾 PERSISTED SESSION CONFIG (.codingagent/session.json) ────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Model đã lưu:${c.reset}     ${c.brightCyan}${data.modelName || 'Chưa đặt'}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Workspace đã lưu:${c.reset} ${c.dim}${data.workspacePath || 'Chưa đặt'}${c.reset}`);
    if (data.lastUpdated) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Cập nhật lúc:${c.reset}     ${c.gray}${data.lastUpdated}${c.reset}`);
    }
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Tệp lưu trữ:${c.reset}      ${c.dim}${sessionFile}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.gray}💡 Tự động nạp lại khi khởi động 'npm run dev' tiếp theo.${c.reset}`);
    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Đầu mỗi Step trong AgentLoop
   */
  static renderStepHeader(step: number, maxSteps: number): void {
    const progress = `${step}/${maxSteps}`;
    const bar = '─'.repeat(Math.max(10, 58 - progress.length));
    console.log(`\n${c.blue}${c.bold}╭── ⚡ STEP ${progress} ${bar}${c.reset}`);
  }

  /**
   * Hiển thị luồng suy luận nội tâm sâu (System 2 Deep Reasoning / CoT)
   */
  static renderReasoning(thoughtText: string): void {
    if (!thoughtText || !thoughtText.trim()) return;
    const lines = thoughtText.trim().split('\n');
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.magenta}${c.bold}💭 INTERNAL MONOLOGUE (System 2 Deep Reasoning):${c.reset}`);
    for (const line of lines.slice(0, 10)) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}${c.italic}${line}${c.reset}`);
    }
    if (lines.length > 10) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.gray}... (+${lines.length - 10} dòng suy luận CoT)${c.reset}`);
    }
  }

  /**
   * Thông báo hành động model
   */
  static renderModelAction(action: 'tool_call' | 'final_answer' | 'max_steps', detail?: string): void {
    if (action === 'tool_call') {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.brightCyan}⚙️  Action (System 1):${c.reset} ${c.italic}${detail || 'Requesting tool execution...'}${c.reset}`);
    } else if (action === 'final_answer') {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.green}✨ Completed:${c.reset} Ready to provide final response.`);
    } else {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.red}⚠️ Circuit Breaker:${c.reset} Max steps reached.`);
    }
  }

  /**
   * Hiển thị Tool Call
   */
  static renderToolCall(name: string, args: Record<string, any>): void {
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.brightYellow}🔧 Calling Tool:${c.reset} ${c.bold}${name}${c.reset}`);

    const entries = Object.entries(args);
    entries.forEach(([k, v], idx) => {
      const isLast = idx === entries.length - 1;
      const prefix = isLast ? '└─' : '├─';
      const valStr = typeof v === 'string' && v.length > 80 ? `${v.slice(0, 77)}...` : JSON.stringify(v);
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.gray}${prefix}${c.reset} ${c.cyan}${k}:${c.reset} ${c.dim}${valStr}${c.reset}`);
    });
  }

  /**
   * Hiển thị Tool Result
   */
  static renderToolResult(name: string, durationMs: number, result: Record<string, any>): void {
    const isError = Boolean(result.error || result.errorCode);
    const badge = isError ? `${c.red}✖ ERROR` : `${c.green}✔ OK`;

    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.gray}📥 Result for ${c.bold}${name}${c.reset} [${badge}${c.reset}${c.gray} in ${durationMs}ms]:${c.reset}`);

    // Định dạng nội dung tóm tắt
    if (result.error) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.red}${result.error}${c.reset}`);
    } else if (result.content !== undefined) {
      const lines = String(result.content).split('\n');
      const preview = lines.slice(0, 4).map(l => `     ${c.dim}${l}${c.reset}`).join('\n');
      const more = lines.length > 4 ? `\n     ${c.gray}... (+${lines.length - 4} dòng)${c.reset}` : '';
      console.log(preview + more);
    } else if (result.matches !== undefined) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.green}Tìm thấy ${result.totalMatches || result.matches.length} kết quả khớp.${c.reset}`);
    } else if (result.stdout !== undefined || result.stderr !== undefined) {
      const codeStr = result.exitCode === 0 ? `${c.green}exit: 0` : `${c.red}exit: ${result.exitCode}`;
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.bold}[${codeStr}${c.reset}${c.bold}]${c.reset}`);
      if (result.stdout) {
        const outLines = result.stdout.trim().split('\n').slice(0, 3);
        outLines.forEach((l: string) => console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}${l}${c.reset}`));
      }
      if (result.stderr) {
        const errLines = result.stderr.trim().split('\n').slice(0, 3);
        errLines.forEach((l: string) => console.log(`${c.blue}${c.bold}│${c.reset}     ${c.red}${l}${c.reset}`));
      }
    } else if (result.message) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.brightGreen}${result.message}${c.reset}`);
    } else {
      const resStr = JSON.stringify(result);
      const preview = resStr.length > 100 ? `${resStr.slice(0, 97)}...` : resStr;
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}${preview}${c.reset}`);
    }
  }

  /**
   * Cuối mỗi Step trong AgentLoop
   */
  static renderStepFooter(): void {
    console.log(`${c.blue}${c.bold}╰────────────────────────────────────────────────────────────────────────────${c.reset}`);
  }

  /**
   * Hiển thị Final Answer
   */
  static renderFinalAnswer(answer: string): void {
    console.log(`\n${c.green}${c.bold}╭── ✨ FINAL ANSWER ─────────────────────────────────────────────────────────╮${c.reset}\n`);
    console.log(answer.trim());
    console.log(`\n${c.green}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Dấu nhắc lệnh người dùng
   */
  static getPromptSymbol(): string {
    return `${c.brightCyan}${c.bold}❯${c.reset} `;
  }
}
