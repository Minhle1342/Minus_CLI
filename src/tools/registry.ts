import type { FunctionDeclaration } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { readFileTool } from './read-file.js';
import { listFilesTool } from './list-files.js';
import { searchTextTool } from './search-text.js';
import { replaceTextTool } from './replace-text.js';
import { applyPatchTool } from './apply-patch.js';
import { writeFileTool } from './write-file.js';
import { createFileTool } from './create-file.js';
import { deleteFileTool } from './delete-file.js';
import { moveFileTool } from './move-file.js';
import { inspectSymbolTool } from './inspect-symbol.js';
import { findReferencesTool } from './find-references.js';
import { getDiagnosticsTool } from './get-diagnostics.js';
import { lspQueryTool } from './lsp-query.js';
import { analyzeImpactTool } from './blast-radius.js';
import { inspectImageTool, createInspectImageTool } from './inspect-image.js';
import { runCommandTool, createRunCommandTool } from './run-command.js';
import { createManageTaskTool } from './manage-task.js';
import { createScheduleTool } from './schedule-tool.js';
import { createWebSearchTool } from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';
import { createReadSharedContextTool, createWriteSharedContextTool } from './shared-context-tools.js';
import { createPublishAgentEventTool } from './agent-event-tools.js';
import { queryCallGraphTool } from './query-call-graph.js';
import { getRouteMapTool } from './get-route-map.js';
import { getSymbolContext360Tool } from './symbol-context-360.js';
import { getArchitectureTopologyTool } from './architecture-topology.js';
import { TaskManager } from '../tasks/task-manager.js';
import { ScheduleManager } from '../tasks/schedule-manager.js';
import { SharedContextService } from '../agent/shared-context-service.js';
import { AgentEventBus } from '../agent/agent-event-bus.js';
import { PlanManager } from '../agent/plan-manager.js';
import { createPlanTool, createUpdatePlanTaskTool } from './plan-tools.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { createSaveMemoryTool, createReadMemoryTool } from './memory-tools.js';
import { CitationValidatedRepositoryMemory } from '../memory/repository-memory.js';
import { createRecallRepositoryMemoryTool, createSaveRepositoryMemoryTool, createVerifyRepositoryMemoryTool } from './repository-memory-tools.js';
import { createReadCompressedCodeTool, createPackCodebaseTool } from './repomix-tool.js';
import { createSearchCodebaseFastTool } from './search-code-tool.js';
import { ToolRetriever, ToolRetrieverConfig } from './tool-retriever.js';
import { createDiscoverToolsTool } from './tool-discovery.js';
import { ComputerController, createComputerTool } from '../computer/index.js';

export interface ToolProvider {
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  getFunctionDeclarations(): FunctionDeclaration[];
  getRelevantTools?(query: string): FunctionDeclaration[];
  getRetriever?(): ToolRetriever;
}

/**
 * ToolRegistry quản lý danh bạ các Tool có sẵn trong hệ thống Coding Agent.
 * 
 * Giúp tách biệt hoàn toàn giữa:
 * - Agent Loop (điều phối vòng lặp)
 * - LLM (chọn tool)
 * - Tool Runner (kiểm tra an toàn và thực thi)
 * - Dynamic Tool Retriever (RATS - lọc động tool phù hợp ngữ cảnh, chống loãng description)
 */
export class ToolRegistry implements ToolProvider {
  private tools = new Map<string, ToolDefinition>();
  private retriever: ToolRetriever;
  private computerController: ComputerController;
  private sandboxManager?: any;
  private taskManager?: TaskManager;
  private permissionManager?: any;

  constructor(
    planManager?: PlanManager,
    memoryManager?: ProjectMemoryManager,
    retrieverConfig?: ToolRetrieverConfig
  ) {
    this.retriever = new ToolRetriever(retrieverConfig);
    this.computerController = new ComputerController();

    // Đăng ký mặc định các tool cốt lõi của Coding Agent
    this.register(readFileTool);
    this.register(listFilesTool);
    this.register(searchTextTool);
    this.register(applyPatchTool);
    this.register(replaceTextTool);
    this.register(writeFileTool);
    this.register(createFileTool);
    this.register(deleteFileTool);
    this.register(moveFileTool);
    this.register(inspectSymbolTool);
    this.register(findReferencesTool);
    this.register(getDiagnosticsTool);
    this.register(lspQueryTool);
    this.register(analyzeImpactTool);
    this.register(inspectImageTool);
    this.register(createComputerTool(this.computerController));
    this.register(runCommandTool);
    this.register(createWebSearchTool());
    this.register(createWebFetchTool());
    this.register(queryCallGraphTool);
    this.register(getRouteMapTool);
    this.register(getSymbolContext360Tool);
    this.register(getArchitectureTopologyTool);
    this.register(createSearchCodebaseFastTool());

    // Đăng ký Meta-Tool khám phá công cụ theo nhu cầu (Progressive Disclosure)
    this.register(createDiscoverToolsTool(this));

    // Đăng ký các planning tools nếu có PlanManager
    if (planManager) {
      this.attachPlanManager(planManager);
    }

    // Đăng ký các memory tools nếu có ProjectMemoryManager
    if (memoryManager) {
      this.attachMemoryManager(memoryManager);
    }
  }

  attachSession(session: any): void {
    this.register(createInspectImageTool(() => session));
    this.computerController.setSessionAccessor(() => session);
  }

  attachComputerController(controller: ComputerController): void {
    this.computerController = controller;
    this.register(createComputerTool(this.computerController));
  }

  getComputerController(): ComputerController {
    return this.computerController;
  }

  attachPlanManager(planManager: PlanManager): void {
    this.register(createPlanTool(planManager));
    this.register(createUpdatePlanTaskTool(planManager));
  }

  attachMemoryManager(memoryManager: ProjectMemoryManager): void {
    this.register(createSaveMemoryTool(memoryManager));
    this.register(createReadMemoryTool(memoryManager));
  }

  attachRepositoryMemory(memory: CitationValidatedRepositoryMemory): void {
    this.register(createSaveRepositoryMemoryTool(memory));
    this.register(createRecallRepositoryMemoryTool(memory));
    this.register(createVerifyRepositoryMemoryTool(memory));
  }

  attachSandboxManager(sandboxManager: any): void {
    this.sandboxManager = sandboxManager;
    this.register(createRunCommandTool(this.sandboxManager, this.taskManager, this.permissionManager));
  }

  attachTaskManager(taskManager: TaskManager): void {
    this.taskManager = taskManager;
    this.register(createManageTaskTool(taskManager));
    this.register(createRunCommandTool(this.sandboxManager, this.taskManager, this.permissionManager));
  }

  attachPermissionManager(permissionManager: any): void {
    this.permissionManager = permissionManager;
    this.register(createRunCommandTool(this.sandboxManager, this.taskManager, this.permissionManager));
  }

  attachScheduleManager(scheduleManager: ScheduleManager): void {
    this.register(createScheduleTool(scheduleManager));
  }

  attachSharedContextService(sharedContext: SharedContextService): void {
    this.register(createReadSharedContextTool(sharedContext));
    this.register(createWriteSharedContextTool(sharedContext));
  }

  attachAgentEventBus(eventBus: AgentEventBus): void {
    this.register(createPublishAgentEventTool(eventBus));
  }

  createScope(scopeId: string, allowedToolNames?: string[]): ToolScope {
    return new ToolScope(scopeId, this, allowedToolNames);
  }

  /**
   * Đăng ký một tool mới vào Registry và tái đồng bộ chỉ mục RATS
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.retriever.indexTools(this.getAll());
  }

  /**
   * Lấy tool theo tên
   */
  /**
   * Lấy tool theo tên (hỗ trợ alias tương thích: search_web -> web_search, read_url_content -> web_fetch)
   */
  has(name: string): boolean {
    if (name === 'search_web') return this.tools.has('web_search') || this.tools.has('search_web');
    if (name === 'read_url_content') return this.tools.has('web_fetch') || this.tools.has('read_url_content');
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    if (name === 'search_web') {
      const found = this.tools.get('web_search') || this.tools.get('search_web');
      if (found) return found;
    }
    if (name === 'read_url_content') {
      const found = this.tools.get('web_fetch') || this.tools.get('read_url_content');
      if (found) return found;
    }
    return this.tools.get(name);
  }

  /**
   * Lấy toàn bộ danh sách Tool
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Xuất danh sách schema FunctionDeclaration đầy đủ.
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
   * Dynamic Tool Retrieval (RATS): Lấy tập hợp FunctionDeclaration phù hợp nhất với ngữ cảnh hiện tại
   */
  getRelevantTools(query: string): FunctionDeclaration[] {
    return this.retriever.retrieve(query, this.getAll());
  }

  getRetriever(): ToolRetriever {
    return this.retriever;
  }

  configureRetriever(config: Partial<ToolRetrieverConfig>): void {
    this.retriever.configure(config);
  }

  /**
   * Thực thi trực tiếp tool với workspace context (fallback method)
   */
  async execute(name: string, args: Record<string, any>, workspace: Workspace = new Workspace()): Promise<Record<string, any>> {
    let resolvedName = name;
    let resolvedArgs = args;

    if (name === 'search_web' && !this.tools.has('search_web') && this.tools.has('web_search')) {
      resolvedName = 'web_search';
    } else if (name === 'read_url_content' && !this.tools.has('read_url_content') && this.tools.has('web_fetch')) {
      resolvedName = 'web_fetch';
      if (!resolvedArgs.url && resolvedArgs.Url) {
        resolvedArgs = { ...resolvedArgs, url: resolvedArgs.Url };
      }
    }

    const tool = this.get(resolvedName);
    if (!tool) {
      return {
        error: `Tool "${name}" không tồn tại trong ToolRegistry. Các tool hiện có: ${Array.from(this.tools.keys()).join(', ')}`,
        errorCode: 'UNKNOWN_TOOL',
      };
    }

    try {
      return await tool.execute(resolvedArgs, workspace);
    } catch (err: any) {
      return {
        error: `Lỗi khi thực thi tool "${name}": ${err.message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  }
}

/**
 * Per-agent tool capability view. Local registrations stay inside the scope;
 * base tools are visible only when included in the allowlist.
 */
export class ToolScope implements ToolProvider {
  private localTools = new Map<string, ToolDefinition>();
  private allowed?: Set<string>;
  private retriever: ToolRetriever;

  constructor(
    readonly id: string,
    private readonly base: ToolProvider,
    allowedToolNames?: string[],
  ) {
    this.allowed = allowedToolNames ? new Set(allowedToolNames) : undefined;
    this.retriever = new ToolRetriever();
    this.retriever.indexTools(this.getAll());
  }

  register(tool: ToolDefinition): void {
    this.localTools.set(tool.name, tool);
    this.retriever.indexTools(this.getAll());
  }

  get(name: string): ToolDefinition | undefined {
    const local = this.localTools.get(name);
    if (local) return local;
    if (name === 'search_web' && (!this.allowed || this.allowed.has('search_web') || this.allowed.has('web_search'))) {
      return this.base.get('web_search') || this.base.get('search_web');
    }
    if (name === 'read_url_content' && (!this.allowed || this.allowed.has('read_url_content') || this.allowed.has('web_fetch'))) {
      return this.base.get('web_fetch') || this.base.get('read_url_content');
    }
    if (this.allowed && !this.allowed.has(name)) return undefined;
    return this.base.get(name);
  }

  getAll(): ToolDefinition[] {
    const visible = this.allowed
      ? this.base.getAll().filter((tool) => this.allowed!.has(tool.name))
      : this.base.getAll();
    const byName = new Map(visible.map((tool) => [tool.name, tool]));
    for (const [name, tool] of this.localTools) byName.set(name, tool);
    return Array.from(byName.values());
  }

  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  getRelevantTools(query: string): FunctionDeclaration[] {
    return this.retriever.retrieve(query, this.getAll());
  }

  getRetriever(): ToolRetriever {
    return this.retriever;
  }
}
