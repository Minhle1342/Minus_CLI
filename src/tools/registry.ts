import type { FunctionDeclaration } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { readFileTool } from './read-file.js';
import { listFilesTool } from './list-files.js';
import { searchTextTool } from './search-text.js';
import { replaceTextTool } from './replace-text.js';
import { writeFileTool } from './write-file.js';
import { runCommandTool, createRunCommandTool } from './run-command.js';
import { PlanManager } from '../agent/plan-manager.js';
import { createPlanTool, createUpdatePlanTaskTool } from './plan-tools.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { createSaveMemoryTool, createReadMemoryTool } from './memory-tools.js';
import { createReadCompressedCodeTool, createPackCodebaseTool } from './repomix-tool.js';
import { createSearchCodebaseFastTool } from './search-code-tool.js';

/**
 * ToolRegistry quản lý danh bạ các Tool có sẵn trong hệ thống Coding Agent.
 * 
 * Giúp tách biệt hoàn toàn giữa:
 * - Agent Loop (điều phối vòng lặp)
 * - LLM (chọn tool)
 * - Tool Runner (kiểm tra an toàn và thực thi)
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(planManager?: PlanManager, memoryManager?: ProjectMemoryManager) {
    // 1. Đăng ký các công cụ khảo sát và thao tác file
    this.register(readFileTool);
    this.register(listFilesTool);
    this.register(searchTextTool);
    this.register(replaceTextTool);
    this.register(writeFileTool);
    this.register(runCommandTool);

    // 2. Đăng ký công cụ tối ưu hóa Token: Repomix (Tree-sitter compression) & MiniSearch (BM25)
    this.register(createReadCompressedCodeTool());
    this.register(createPackCodebaseTool());
    this.register(createSearchCodebaseFastTool());

    // 3. Đăng ký các planning tools nếu có PlanManager
    if (planManager) {
      this.attachPlanManager(planManager);
    }

    // 4. Đăng ký các memory tools nếu có ProjectMemoryManager
    if (memoryManager) {
      this.attachMemoryManager(memoryManager);
    }
  }

  attachPlanManager(planManager: PlanManager): void {
    this.register(createPlanTool(planManager));
    this.register(createUpdatePlanTaskTool(planManager));
  }

  attachMemoryManager(memoryManager: ProjectMemoryManager): void {
    this.register(createSaveMemoryTool(memoryManager));
    this.register(createReadMemoryTool(memoryManager));
  }

  attachSandboxManager(sandboxManager: any): void {
    this.register(createRunCommandTool(sandboxManager));
  }

  /**
   * Đăng ký một tool mới vào Registry
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Lấy tool theo tên
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Lấy toàn bộ danh sách Tool
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Xuất danh sách schema FunctionDeclaration để truyền cho Gemini & OpenAI-compatible API.
   * Áp dụng KV-Cache Prefix Alignment: Sắp xếp cố định theo tên để chuỗi token schema luôn đồng nhất 100%.
   */
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  /**
   * Thực thi trực tiếp tool với workspace context (fallback method)
   */
  async execute(name: string, args: Record<string, any>, workspace: Workspace = new Workspace()): Promise<Record<string, any>> {
    const tool = this.get(name);
    if (!tool) {
      return {
        error: `Tool "${name}" không tồn tại trong ToolRegistry. Các tool hiện có: ${Array.from(this.tools.keys()).join(', ')}`,
        errorCode: 'UNKNOWN_TOOL',
      };
    }

    try {
      return await tool.execute(args, workspace);
    } catch (err: any) {
      return {
        error: `Lỗi khi thực thi tool "${name}": ${err.message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  }
}
