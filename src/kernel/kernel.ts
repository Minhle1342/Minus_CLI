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
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { TaskManager } from '../tasks/task-manager.js';
import { GoalManager } from '../agent/goal-manager.js';
import { AgentHookRegistry } from '../agent/agent-hooks.js';
import { AgentInbox } from '../agent/agent-inbox.js';
import { PromptAssembler } from '../llm/prompt-assembler.js';
import { CODING_AGENT_SYSTEM_PROMPT } from '../llm/prompts.js';
import { AgentRegistry } from '../agent/agent-registry.js';
import { SessionManager } from '../session/session-manager.js';
import { SuperpowersPlugin } from './plugins/superpowers-plugin.js';
import { PermissionManager } from '../security/permission-manager.js';
import { HypothesisTracker } from '../agent/hypothesis-tracker.js';
import { CriticGate } from '../agent/critic-gate.js';
import { ScheduleManager } from '../tasks/schedule-manager.js';
import { SharedContextService } from '../agent/shared-context-service.js';
import { AgentEventBus } from '../agent/agent-event-bus.js';
import { DreamManager } from '../dream/dream-manager.js';

export interface KernelEvents {
  'kernel:init': () => void;
  'plugin:registered': (pluginName: string) => void;
  'step:before': (step: number, maxSteps: number) => void;
  'step:after': (step: number) => void;
  'tool:before': (toolName: string, args: Record<string, any>) => void;
  'tool:after': (
    toolName: string,
    result: Record<string, any>,
    durationMs: number,
    args: Record<string, any>,
    context?: { sessionId?: string; agentId?: string; turn?: number },
  ) => void;
  'tool:error': (toolName: string, error: any) => void;
  'model:thought': (thought: string) => void;
  'model:token': (token: string) => void;
  'model:usage': (usage: import('../llm/gemini.js').LLMUsage) => void;
  'model:final_answer': (answer: string) => void;
  'workspace:changed': (oldPath: string, newPath: string) => void;
  'model:changed': (newModel: string) => void;
  'agent:status': (record: { id: string; status: string; sessionId?: string; turn?: number; step?: number }) => void;
  'agent/status': (record: { id: string; status: string; sessionId?: string; turn?: number; step?: number }) => void;
}

/** Typed event surface for plugins and live agent observers. */
export class KernelEventBus {
  private readonly emitter = new EventEmitter();

  on<K extends keyof KernelEvents>(
    event: K,
    listener: (...args: Parameters<KernelEvents[K]>) => void,
  ): this {
    this.emitter.on(event as string, listener as (...args: any[]) => void);
    return this;
  }

  once<K extends keyof KernelEvents>(
    event: K,
    listener: (...args: Parameters<KernelEvents[K]>) => void,
  ): this {
    this.emitter.once(event as string, listener as (...args: any[]) => void);
    return this;
  }

  off<K extends keyof KernelEvents>(
    event: K,
    listener: (...args: Parameters<KernelEvents[K]>) => void,
  ): this {
    this.emitter.off(event as string, listener as (...args: any[]) => void);
    return this;
  }

  emit<K extends keyof KernelEvents>(event: K, ...args: Parameters<KernelEvents[K]>): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  listenerCount<K extends keyof KernelEvents>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }
}

export interface KernelContext {
  workspace: Workspace;
  tools: ToolRegistry;
  toolRunner: ToolRunner;
  permissions: PermissionManager;
  plan: PlanManager;
  goal: GoalManager;
  agentHooks: AgentHookRegistry;
  inbox: AgentInbox;
  systemPrompt: PromptAssembler;
  agents: AgentRegistry;
  sessions: SessionManager;
  memory: ProjectMemoryManager;
  dream: DreamManager;
  checkpoints: CheckpointManager;
  compactor: ContextCompactor;
  reflection: ReflectionEngine;
  hypothesis: HypothesisTracker;
  critic: CriticGate;
  sandbox: SandboxManager;
  tasks: TaskManager;
  schedules: ScheduleManager;
  sharedContext: SharedContextService;
  agentEvents: AgentEventBus;
  llm: any;
  events: KernelEventBus;
  registerTool: (tool: ToolDefinition) => void;
  setWorkspace: (workspace: Workspace) => void;
  setLLM: (llm: any, modelName?: string) => void;
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
 * Quản lý:
 * 1. KernelContext và toàn bộ các subsystem (Tools, Workspace, Sandbox, Tasks, Plan, Memory).
 * 2. Event Bus đa luồng.
 * 3. Hot-pluggable Plugin Lifecycle.
 */
export class AgentKernel {
  readonly ctx: KernelContext;
  private plugins = new Map<string, AgentPlugin>();
  private isInitialized = false;

  constructor(workspace: Workspace = new Workspace(), llm?: any) {
    const events = new KernelEventBus();
    const plan = new PlanManager();
    const goal = new GoalManager();
    const agentHooks = new AgentHookRegistry();
    const inbox = new AgentInbox();
    const systemPrompt = new PromptAssembler(CODING_AGENT_SYSTEM_PROMPT);
    const agents = new AgentRegistry();
    const sessions = new SessionManager(workspace.rootDir);
    const memory = new ProjectMemoryManager(workspace.rootDir);
    const dream = new DreamManager(workspace.rootDir, memory);
    const checkpoints = new CheckpointManager(workspace.rootDir);
    const compactor = new ContextCompactor();
    const reflection = new ReflectionEngine();
    const hypothesis = new HypothesisTracker();
    const critic = new CriticGate();
    const sandbox = new SandboxManager({ workspacePath: workspace.rootDir });
    const tasks = new TaskManager(workspace.rootDir);
    const schedules = new ScheduleManager();
    const sharedContext = new SharedContextService();
    const agentEvents = new AgentEventBus();
    const tools = new ToolRegistry(plan, memory);
    tools.attachSandboxManager(sandbox);
    tools.attachTaskManager(tasks);
    tools.attachScheduleManager(schedules);
    tools.attachSharedContextService(sharedContext);
    tools.attachAgentEventBus(agentEvents);
    const permissions = new PermissionManager();
    const toolRunner = new ToolRunner(tools, workspace, permissions);

    this.ctx = {
      workspace,
      tools,
      toolRunner,
      permissions,
      plan,
      goal,
      agentHooks,
      inbox,
      systemPrompt,
      agents,
      sessions,
      memory,
      dream,
      checkpoints,
      compactor,
      reflection,
      hypothesis,
      critic,
      sandbox,
      tasks,
      schedules,
      sharedContext,
      agentEvents,
      llm,
      events,
      registerTool: (tool: ToolDefinition) => {
        this.ctx.tools.register(tool);
      },
      setWorkspace: (newWs: Workspace) => {
        const oldPath = this.ctx.workspace.rootDir;
        this.ctx.workspace = newWs;
        this.ctx.toolRunner = new ToolRunner(this.ctx.tools, newWs, this.ctx.permissions);
        (this.ctx as any).checkpoints = new CheckpointManager(newWs.rootDir);
        this.ctx.memory.setWorkspace(newWs.rootDir);
        this.ctx.dream.setWorkspace(newWs.rootDir, this.ctx.memory);
        this.ctx.sessions.setWorkspace(newWs.rootDir);
        (this.ctx as any).tasks = new TaskManager(newWs.rootDir);
        this.ctx.sandbox.updateWorkspace(newWs.rootDir).catch(() => {});
        this.ctx.checkpoints.init().catch(() => {});
        this.ctx.memory.init(newWs).catch(() => {});
        this.ctx.events.emit('workspace:changed', oldPath, newWs.rootDir);
      },
      setLLM: (newLlm: any, newModelName?: string) => {
        this.ctx.llm = newLlm;
        if (newModelName) {
          this.ctx.events.emit('model:changed', newModelName);
        }
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

    if (!this.plugins.has('superpowers')) {
      await this.use(new SuperpowersPlugin());
    }

    // Tool/capability registration must survive a Docker startup failure.
    await this.ctx.sandbox.init();

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
