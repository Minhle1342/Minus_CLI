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
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  desc: string;
  recommended?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: '1',
    name: 'gemini-3.1-flash-lite-preview',
    provider: 'Google AI Studio',
    desc: 'Miễn phí 1.500 req/ngày, phản hồi cực nhanh, gọi tool chuẩn',
    recommended: true,
  },
  {
    id: '2',
    name: 'gemini-3.5-flash',
    provider: 'Google AI Studio',
    desc: 'Cân bằng giữa tốc độ và khả năng lập trình toàn diện',
  },
  {
    id: '3',
    name: 'gemini-2.5-pro',
    provider: 'Google AI Studio',
    desc: 'Khả năng suy luận và xử lý logic code chuyên sâu nhất của Google',
  },
  {
    id: '4',
    name: 'deepseek-chat',
    provider: 'DeepSeek Direct V3',
    desc: 'Mô hình lập trình mạnh mẽ hàng đầu của DeepSeek (cần key)',
  },
  {
    id: '5',
    name: 'deepseek-reasoner',
    provider: 'DeepSeek Direct R1',
    desc: 'Mô hình lý luận sâu Chain of Thought (cần key)',
  },
  {
    id: '6',
    name: 'openrouter/free',
    provider: 'OpenRouter Free Router',
    desc: 'Tự động định tuyến sang các model miễn phí trên OpenRouter',
  },
  {
    id: '7',
    name: 'gemma2-9b-it',
    provider: 'Groq Cloud (Free)',
    desc: 'Gemma 2 9B chạy trên chip LPU siêu tốc > 500 tokens/s (cần GROQ_API_KEY)',
  },
  {
    id: '8',
    name: 'google/gemma-2-27b-it',
    provider: 'OpenRouter (Gemma 2 27B)',
    desc: 'Gemma 2 27B thông minh qua OpenRouter / OpenAI format',
  },
  {
    id: '9',
    name: 'google/gemma-2-9b-it:free',
    provider: 'OpenRouter Free',
    desc: 'Gemma 2 9B bản miễn phí qua OpenRouter',
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
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/model${c.reset}          ${c.gray}Danh sách và chọn mô hình LLM (Gemini, DeepSeek,...)    ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/workspace${c.reset}      ${c.gray}Xem hoặc đổi thư mục workspace làm việc (/cd <path>)    ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/tools${c.reset}          ${c.gray}Xem chi tiết 6 công cụ khảo sát & sửa code              ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/status${c.reset}         ${c.gray}Xem thống kê trạng thái phiên làm việc                  ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/clear${c.reset}          ${c.gray}Xoá màn hình terminal                                   ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/help${c.reset}           ${c.gray}Xem toàn bộ hướng dẫn & ví dụ tác vụ                    ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}/exit${c.reset}           ${c.gray}Thoát chương trình                                      ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các model có sẵn để người dùng chọn
   */
  static renderModelSelector(currentModel: string): void {
    console.log(`\n${c.magenta}${c.bold}╭── 🤖 DANH SÁCH MÔ HÌNH KHẢ DỤNG (SELECT MODEL) ───────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}                                                                            ${c.magenta}${c.bold}│${c.reset}`);
    
    for (const m of AVAILABLE_MODELS) {
      const isCurrent = m.name === currentModel;
      const marker = isCurrent ? `${c.brightGreen}${c.bold}* [ACTIVE]${c.reset}` : `          `;
      const recBadge = m.recommended ? `${c.brightYellow}(Recommended)${c.reset}` : '';
      
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}[${m.id}]${c.reset} ${c.bold}${m.name}${c.reset} ${recBadge}`);
      console.log(`${c.magenta}${c.bold}│${c.reset}      ${c.dim}Nhà cung cấp: ${m.provider} | ${m.desc}${c.reset}`);
      console.log(`${c.magenta}${c.bold}│${c.reset}      ${marker}`);
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
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/model${c.reset}              Hiển thị danh sách và chọn mô hình LLM              ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/model <name>${c.reset}       Chuyển đổi trực tiếp sang mô hình chỉ định          ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/workspace${c.reset}          Xem đường dẫn thư mục workspace hiện tại            ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/workspace <path>${c.reset}   Chuyển workspace sang thư mục mới (hoặc /cd <path>)  ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/tools${c.reset}              Liệt kê chi tiết 6 công cụ và thông số              ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}/status${c.reset}             Xem thông tin trạng thái phiên làm việc             ${c.cyan}${c.bold}│${c.reset}`);
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
   * Hiển thị trạng thái hiện tại
   */
  static renderStatus(opts: StatusOptions): void {
    console.log(`\n${c.magenta}${c.bold}╭── 📊 SESSION TELEMETRY & STATUS ───────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Model:${c.reset}         ${c.brightCyan}${opts.modelName}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Workspace:${c.reset}     ${c.dim}${opts.workspaceRoot}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Max Steps:${c.reset}     ${c.yellow}${opts.maxSteps} steps${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Session Turns:${c.reset} ${c.green}${opts.sessionTurns} completed${c.reset}`);
    console.log(`${c.magenta}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
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
   * Thông báo hành động model
   */
  static renderModelAction(action: 'tool_call' | 'final_answer' | 'max_steps', detail?: string): void {
    if (action === 'tool_call') {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.magenta}🧠 Thinking:${c.reset} ${c.italic}${detail || 'Requesting tool execution...'}${c.reset}`);
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
