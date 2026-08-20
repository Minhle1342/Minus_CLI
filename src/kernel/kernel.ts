import { EventEmitter } from 'node:events';
import { Workspace } from '../workspace/workspace.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { PlanManager } from '../agent/plan-manager.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import { CheckpointManager } from '../workspace/checkpoint.js';
import { ContextCompactor } from '../agent/context-compactor.js';
import { ReflectionEngine } from '../agent/reflection-engine.js';
import { ToolDefinition } from '../tools/types.js';

export interface KernelEvents {
  'kernel:init': () => void;
  'plugin:registered': (pluginName: string) => void;
  'step:before': (step: number, maxSteps: number) => void;
  'step:after': (step: number) => void;
  'tool:before': (toolName: string, args: Record<string, any>) => void;
  'tool:after': (toolName: string, result: Record<string, any>, durationMs: number) => void;
  'tool:error': (toolName: string, error: any) => void;
  'model:thought': (thought: string) => void;
  'model:final_answer': (answer: string) => void;
  'workspace:changed': (oldPath: string, newPath: string) => void;
}

export interface KernelContext {
  workspace: Workspace;
  tools: ToolRegistry;
  toolRunner: ToolRunner;
  plan: PlanManager;
  memory: ProjectMemoryManager;
  checkpoints: CheckpointManager;
  compactor: ContextCompactor;
  reflection: ReflectionEngine;
  llm: any;
  events: EventEmitter;
  registerTool: (tool: ToolDefinition) => void;
  setWorkspace: (workspace: Workspace) => void;
  setLLM: (llm: any) => void;
}

export interface AgentPlugin {
  name: string;
  version?: string;
  description?: string;
  apply: (ctx: KernelContext) => void | Promise<void>;
  dispose?: (ctx: KernelContext) => void | Promise<void>;
}

/**
 * AgentKernel - Vi nhân điều phối trung tâm theo chuẩn Cordis (Micro-Kernel Architecture)
 * 
 * Nguyên lý hoạt động:
 * 1. Kernel chỉ quản lý Context, Event Bus và Plugin Lifecycle.
 * 2. Tất cả mọi tính năng (LLM, Workspace, Tools, Memory, Plan, Sandbox) đều là Plugins độc lập.
 * 3. Cho phép cắm/rút (Hot-pluggable) các Tool và Service mới mà không cần chạm vào Agent Core Loop.
 */
export class AgentKernel {
  readonly ctx: KernelContext;
  private plugins = new Map<string, AgentPlugin>();
  private isInitialized = false;

  constructor(workspace: Workspace = new Workspace(), llm?: any) {
    const events = new EventEmitter();
    const plan = new PlanManager();
    const memory = new ProjectMemoryManager(workspace.rootDir);
    const checkpoints = new CheckpointManager(workspace.rootDir);
    const compactor = new ContextCompactor();
    const reflection = new ReflectionEngine();
    const tools = new ToolRegistry(plan, memory);
    const toolRunner = new ToolRunner(tools, workspace);

    this.ctx = {
      workspace,
      tools,
      toolRunner,
      plan,
      memory,
      checkpoints,
      compactor,
      reflection,
      llm,
      events,
      registerTool: (tool: ToolDefinition) => {
        this.ctx.tools.register(tool);
      },
      setWorkspace: (newWs: Workspace) => {
        const oldPath = this.ctx.workspace.rootDir;
        this.ctx.workspace = newWs;
        this.ctx.toolRunner = new ToolRunner(this.ctx.tools, newWs);
        (this.ctx as any).checkpoints = new CheckpointManager(newWs.rootDir);
        (this.ctx as any).memory = new ProjectMemoryManager(newWs.rootDir);
        this.ctx.checkpoints.init().catch(() => {});
        this.ctx.memory.init(newWs).catch(() => {});
        this.ctx.events.emit('workspace:changed', oldPath, newWs.rootDir);
      },
      setLLM: (newLlm: any) => {
        this.ctx.llm = newLlm;
      },
    };
  }

  /**
   * Đăng ký một Plugin vào Kernel
   */
  async use(plugin: AgentPlugin): Promise<this> {
    if (this.plugins.has(plugin.name)) {
      console.warn(`Plugin "${plugin.name}" đã được đăng ký trước đó. Đang nạp lại.`);
    }

    this.plugins.set(plugin.name, plugin);
    await plugin.apply(this.ctx);
    this.ctx.events.emit('plugin:registered', plugin.name);
    return this;
  }

  /**
   * Khởi tạo toàn bộ Kernel và kích hoạt các services
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;
    await this.ctx.checkpoints.init();
    await this.ctx.memory.init(this.ctx.workspace);
    this.isInitialized = true;
    this.ctx.events.emit('kernel:init');
  }

  /**
   * Lấy danh sách các plugins đã đăng ký
   */
  getLoadedPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Huỷ và giải phóng plugin
   */
  async unuse(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;
    if (plugin.dispose) {
      await plugin.dispose(this.ctx);
    }
    this.plugins.delete(pluginName);
    return true;
  }
}
