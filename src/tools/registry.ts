import type { FunctionDeclaration } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { readFileTool } from './read-file.js';
import { listFilesTool } from './list-files.js';
import { searchTextTool } from './search-text.js';
import { replaceTextTool } from './replace-text.js';
import { writeFileTool } from './write-file.js';
import { writeToFileTool } from './write-to-file.js';
import { replaceFileContentTool } from './replace-file-content.js';
import { multiReplaceFileContentTool } from './multi-replace-file-content.js';
import { runCommandTool, createRunCommandTool } from './run-command.js';
import { createManageTaskTool } from './manage-task.js';
import { searchWebTool, webSearchTool } from './web-search.js';
import { readUrlContentTool, webFetchTool } from './web-fetch.js';
import { createFileTool } from './create-file.js';
import { searchCodebaseFastTool } from './search-code-tool.js';
import { ToolRetriever, ToolRetrieverConfig, ToolRetrievalQueryInput, ToolCompactStub } from './tool-retriever.js';
import { isOrchestrationTool } from '../control/phase-tool-effects.js';

export interface ToolProvider {
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  getFunctionDeclarations(): FunctionDeclaration[];
  getRelevantTools?(query: ToolRetrievalQueryInput): FunctionDeclaration[];
  getRetriever?(): ToolRetriever;
  getToolCatalogStubs?(): ToolCompactStub[];
}

/**
 * 8 canonical core tools exposed to LLM:
 * read_file, write_file, replace_text, list_files, search_text, run_command, web_search, web_fetch.
 */
export const CANONICAL_MODEL_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'replace_text',
  'list_files',
  'search_text',
  'run_command',
  'web_search',
  'web_fetch',
]);

/**
 * Compatibility/workflow tool aliases that remain executable via get/has/execute,
 * but are strictly hidden from LLM schema declarations.
 */
export const MODEL_HIDDEN_TOOL_NAMES = new Set([
  'search_web',
  'read_url_content',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'search_codebase_fast',
]);

/**
 * Tools that stay executable once attached but only appear in model
 * declarations after their unlock event (background task notice claimed).
 */
export const LAZY_TOOL_NAMES = new Set(['manage_task']);

function modelVisibleTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(
    (tool) => (CANONICAL_MODEL_TOOL_NAMES.has(tool.name) || isOrchestrationTool(tool.name))
      && !MODEL_HIDDEN_TOOL_NAMES.has(tool.name)
      && !LAZY_TOOL_NAMES.has(tool.name)
  );
}

/**
 * ToolRegistry quản lý danh bạ các Tool có sẵn trong hệ thống Coding Agent.
 * Chỉ đăng ký và phơi bày 8 tool cốt lõi cho LLM.
 */
export class ToolRegistry implements ToolProvider {
  private tools = new Map<string, ToolDefinition>();
  private retriever: ToolRetriever;
  private computerController?: any;
  private sandboxManager?: any;
  private taskManager?: any;
  private permissionManager?: any;

  constructor(
    _planManager?: any,
    _memoryManager?: any,
    retrieverConfig?: ToolRetrieverConfig,
    _options?: { enableGameTools?: boolean }
  ) {
    this.retriever = new ToolRetriever(retrieverConfig);

    // Register ONLY the 8 canonical core tools
    this.register(readFileTool);
    this.register(listFilesTool);
    this.register(searchTextTool);
    this.register(replaceTextTool);
    this.register(writeFileTool);
    this.register(runCommandTool);
    this.register(webSearchTool);
    this.register(webFetchTool);

    // Register compatibility aliases (hidden from model declarations)
    this.register(searchWebTool);
    this.register(readUrlContentTool);
    this.register(writeToFileTool);
    this.register(replaceFileContentTool);
    this.register(multiReplaceFileContentTool);
    this.register(createFileTool);
    this.register(searchCodebaseFastTool);
  }

  attachSession(_session: any): void {
    // No-op: legacy image inspection tools removed
  }

  async registerGameTools(): Promise<void> {
    // No-op: game tools removed
  }

  attachComputerController(controller: any): void {
    this.computerController = controller;
  }

  attachBrowserManager(_manager: any): void {
    // No-op: browser MCP tools removed
  }

  async attachReaManager(_manager: any): Promise<number> {
    // No-op: REA tools removed
    return 0;
  }

  getComputerController(): any {
    return this.computerController;
  }

  attachPlanManager(_planManager: any): void {
    // No-op: plan tools removed from LLM
  }

  attachMemoryManager(_memoryManager: any): void {
    // No-op: memory tools removed from LLM
  }

  attachRepositoryMemory(_memory: any): void {
    // No-op: repository memory tools removed
  }

  attachHypothesisTracker(_tracker: any, _workspace?: Workspace): void {
    // No-op: hypothesis tools removed
  }

  attachGitTools(_workspace: Workspace, _forceEnable = false): void {
    // No-op: git operations unified into run_command
  }

  attachSandboxManager(sandboxManager: any): void {
    this.sandboxManager = sandboxManager;
    this.register(createRunCommandTool(this.sandboxManager, this.taskManager, this.permissionManager));
  }

  attachTaskManager(taskManager: any): void {
    this.taskManager = taskManager;
    this.register(createRunCommandTool(this.sandboxManager, this.taskManager, this.permissionManager));
    // Registered but hidden from default declarations (LAZY_TOOL_NAMES) —
    // it unlocks after a background-task notice is claimed.
    this.register(createManageTaskTool(taskManager));
  }

  attachPermissionManager(permissionManager: any): void {
    this.permissionManager = permissionManager;
    this.register(createRunCommandTool(this.sandboxManager, this.taskManager, this.permissionManager));
  }

  attachScheduleManager(_scheduleManager: any): void {
    // No-op: schedule tool removed
  }

  attachSharedContextService(_sharedContext: any): void {
    // No-op: shared context tools removed
  }

  attachAgentEventBus(_eventBus: any): void {
    // No-op: agent event tools removed
  }

  attachSessionDiff(_getManager: () => any): void {
    // No-op: session diff tool removed
  }

  attachAgentOrchestrator(_orchestrator: any): void {
    // No-op: subagent tools removed
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
   * Kiểm tra tool tồn tại theo tên hoặc alias tương thích
   */
  has(name: string): boolean {
    if (this.tools.has(name)) return true;
    if (name === 'search_web') return this.tools.has('web_search');
    if (name === 'web_search') return this.tools.has('search_web');
    if (name === 'read_url_content') return this.tools.has('web_fetch');
    if (name === 'web_fetch') return this.tools.has('read_url_content');
    if (name === 'write_to_file' || name === 'create_file') return this.tools.has('write_file');
    if (name === 'replace_file_content' || name === 'multi_replace_file_content') return this.tools.has('replace_text');
    if (name === 'search_codebase_fast' || name === 'tools_search') return this.tools.has('search_text');
    return false;
  }

  /**
   * Lấy tool theo tên (ưu tiên exact match, sau đó hỗ trợ alias tương thích)
   */
  get(name: string): ToolDefinition | undefined {
    const exact = this.tools.get(name);
    if (exact) return exact;
    if (name === 'search_web') return this.tools.get('web_search');
    if (name === 'web_search') return this.tools.get('search_web');
    if (name === 'read_url_content') return this.tools.get('web_fetch');
    if (name === 'web_fetch') return this.tools.get('read_url_content');
    if (name === 'write_to_file' || name === 'create_file') return this.tools.get('write_file');
    if (name === 'replace_file_content' || name === 'multi_replace_file_content') return this.tools.get('replace_text');
    if (name === 'search_codebase_fast' || name === 'tools_search') return this.tools.get('search_text');
    return undefined;
  }

  /**
   * Lấy toàn bộ danh sách Tool
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Xuất danh sách schema FunctionDeclaration đầy đủ cho LLM.
   * Luôn chỉ chứa 8 tool cốt lõi đã qua modelVisibleTools.
   */
  getFunctionDeclarations(): FunctionDeclaration[] {
    return modelVisibleTools(this.getAll())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  /**
   * Dynamic Tool Retrieval (RATS): Lấy tập hợp FunctionDeclaration phù hợp
   */
  getRelevantTools(query: ToolRetrievalQueryInput): FunctionDeclaration[] {
    return this.retriever.retrieve(query, modelVisibleTools(this.getAll()));
  }

  getToolCatalogStubs(): ToolCompactStub[] {
    return this.retriever.getToolCatalogStubs(modelVisibleTools(this.getAll()));
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

    if (!this.tools.has(name)) {
      if (name === 'search_web' && this.tools.has('web_search')) {
        resolvedName = 'web_search';
      } else if (name === 'web_search' && this.tools.has('search_web')) {
        resolvedName = 'search_web';
      } else if (name === 'read_url_content' && this.tools.has('web_fetch')) {
        resolvedName = 'web_fetch';
        if (!resolvedArgs.url && resolvedArgs.Url) {
          resolvedArgs = { ...resolvedArgs, url: resolvedArgs.Url };
        }
      } else if (name === 'web_fetch' && this.tools.has('read_url_content')) {
        resolvedName = 'read_url_content';
        if (!resolvedArgs.Url && resolvedArgs.url) {
          resolvedArgs = { ...resolvedArgs, Url: resolvedArgs.url };
        }
      } else if (name === 'tools_search' && this.tools.has('search_text')) {
        resolvedName = 'search_text';
      }
    }

    const tool = this.get(resolvedName);
    if (!tool) {
      const available = this.getFunctionDeclarations().map((t) => t.name).join(', ');
      return {
        error: `Tool "${name}" does not exist in ToolRegistry. Available tools: ${available}`,
        errorCode: 'UNKNOWN_TOOL',
      };
    }

    try {
      return await tool.execute(resolvedArgs, workspace);
    } catch (err: any) {
      return {
        error: `Failed to execute tool "${name}": ${err.message}`,
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

  getBaseProvider(): ToolProvider {
    return this.base;
  }

  register(tool: ToolDefinition): void {
    this.localTools.set(tool.name, tool);
    this.retriever.indexTools(this.getAll());
  }

  get(name: string): ToolDefinition | undefined {
    const local = this.localTools.get(name);
    if (local) return local;
    if (this.allowed && !this.allowed.has(name)) {
      // Check alias permission
      const alias = name === 'search_web' ? 'web_search'
        : name === 'web_search' ? 'search_web'
        : name === 'read_url_content' ? 'web_fetch'
        : name === 'web_fetch' ? 'read_url_content'
        : name === 'write_to_file' || name === 'create_file' ? 'write_file'
        : name === 'replace_file_content' || name === 'multi_replace_file_content' ? 'replace_text'
        : name === 'search_codebase_fast' || name === 'tools_search' ? 'search_text'
        : undefined;
      if (!alias || !this.allowed.has(alias)) return undefined;
    }
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
    return modelVisibleTools(this.getAll())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  getRelevantTools(query: ToolRetrievalQueryInput): FunctionDeclaration[] {
    return this.retriever.retrieve(query, modelVisibleTools(this.getAll()));
  }

  getToolCatalogStubs(): ToolCompactStub[] {
    return this.retriever.getToolCatalogStubs(modelVisibleTools(this.getAll()));
  }

  getRetriever(): ToolRetriever {
    return this.retriever;
  }
}

export { writeToFileTool, replaceFileContentTool, multiReplaceFileContentTool, searchWebTool, readUrlContentTool };
