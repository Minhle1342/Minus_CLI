import { AgentPlugin, KernelContext } from '../kernel.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { SkillActivator } from '../../skills/skill-activator.js';
import { SuperpowersSource } from '../../skills/superpowers-source.js';
import { CapabilityCatalog } from '../../capabilities/capability-catalog.js';
import { CapabilityPolicy } from '../../capabilities/capability-policy.js';
import { createDefaultCapabilityCatalog } from '../../capabilities/default-capabilities.js';
import { WorktreeManager } from '../../workspace/worktree-manager.js';
import { createWorktreeTools } from '../../tools/worktree-tools.js';
import { ApprovalManager } from '../../agent/approval-manager.js';
import { createApprovalTools } from '../../tools/approval-tools.js';
import { ReviewManager } from '../../agent/review-manager.js';
import { createReviewTools } from '../../tools/review-tools.js';
import { VerificationPolicy } from '../../skills/verification-policy.js';
import { SuperpowersWorkflowMap } from '../../skills/workflow-map.js';
import { OcrReviewService } from '../../review/open-code-review.js';

const FILE_MUTATION_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'replace_text',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_patch',
  'create_file',
  'delete_file',
  'move_file',
]);

export class SuperpowersPlugin implements AgentPlugin {
  readonly name = 'superpowers';
  readonly version = '1.0.0';
  readonly description = 'Superpowers Skills, Worktree isolation, Review gates, and Capability catalog';

  private skillRegistry = new SkillRegistry();
  private capabilityCatalog: CapabilityCatalog = createDefaultCapabilityCatalog();
  private capabilityPolicy = new CapabilityPolicy();
  private activator: SkillActivator;
  private worktreeManager?: WorktreeManager;
  private approvalManager = new ApprovalManager();
  private reviewManager = new ReviewManager();
  private ocrReview?: OcrReviewService;
  private verificationPolicy = new VerificationPolicy();
  private workflowMap = new SuperpowersWorkflowMap();
  private onWorkspaceChanged?: (oldPath: string, newPath: string) => void;
  private onToolAfter?: (
    toolName: string,
    result: Record<string, any>,
    durationMs: number,
    args: Record<string, any>,
    context?: { sessionId?: string; agentId?: string; turn?: number },
  ) => void;

  constructor() {
    this.activator = new SkillActivator(this.skillRegistry, this.capabilityCatalog);
  }

  async apply(ctx: KernelContext): Promise<void> {
    this.worktreeManager = new WorktreeManager(ctx.workspace.rootDir);
    this.ocrReview = new OcrReviewService(ctx.workspace.rootDir);

    // 1. Nạp Superpowers Skills
    SuperpowersSource.registerSuperpowers(this.skillRegistry);

    // 2. Đăng ký các Tools bổ sung vào ToolRegistry
    const worktreeTools = createWorktreeTools(this.worktreeManager);
    for (const tool of worktreeTools) {
      ctx.tools.register(tool);
    }

    // Dedicated git_* tools stay unregistered by design: all Git flows through
    // run_command, which enforces the same scope/intent policy (see
    // checkGitPolicyForShell in tools/run-command.ts). This keeps a single
    // policy path and avoids fragmenting the model-visible tool surface.
    this.onWorkspaceChanged = () => {
      this.worktreeManager = new WorktreeManager(ctx.workspace.rootDir);
      this.ocrReview?.setWorkspace(ctx.workspace.rootDir);
      (ctx as any).worktrees = this.worktreeManager;
      for (const tool of createWorktreeTools(this.worktreeManager)) ctx.tools.register(tool);
    };
    ctx.events.on('workspace:changed', this.onWorkspaceChanged);

    const approvalTools = createApprovalTools(this.approvalManager);
    for (const tool of approvalTools) {
      ctx.tools.register(tool);
    }

    const reviewTools = createReviewTools(this.reviewManager, this.ocrReview);
    for (const tool of reviewTools) {
      ctx.tools.register(tool);
    }

    // 3. Gắn Hook Turn-Start để tự động kích hoạt Skills và nạp Prompt Sections
    ctx.agentHooks.register('superpowers-activator', {
      'agent/turn-start': async (hookCtx) => {
        const history = hookCtx.session.getHistory();
        const lastUserMessage = history.filter((m: any) => m.role === 'user').pop();
        const userText = lastUserMessage?.parts?.[0]?.text || '';

        const activation = this.activator.evaluate({
          session: hookCtx.session,
          userRequest: userText,
          availableCapabilities: this.capabilityCatalog.list().map((c) => c.name),
        });

        // Ghi nhận quyết định kích hoạt vào Session
        for (const decision of activation.decisions) {
          hookCtx.session.recordSkillDecision(decision);
        }

        // Nạp các section của skill vào System Prompt
        for (const section of activation.promptSections) {
          ctx.systemPrompt.unregister(section.name);
          ctx.systemPrompt.register({
            id: section.name,
            content: section.content,
            priority: section.priority,
          });
        }

        return { allow: true };
      },
    });

    // 4. Theo dõi thay đổi code & xác thực qua VerificationPolicy
    this.onToolAfter = (toolName, result, _durationMs, args) => {
      const failed = Boolean(result?.error || result?.errorCode || result?.success === false
        || (typeof result?.exitCode === 'number' && result.exitCode !== 0));
      if (FILE_MUTATION_TOOLS.has(toolName) && !failed) {
        this.verificationPolicy.recordModification();
      } else if (toolName === 'run_command') {
        this.verificationPolicy.recordVerification(
          String(args?.command || ''),
          !failed,
          result?.stdout?.slice(0, 200) || '',
          result?.exitCode
        );
      }
    };
    ctx.events.on('tool:after', this.onToolAfter);

    // 5. Gắn các services vào KernelContext mở rộng
    (ctx as any).skills = this.skillRegistry;
    (ctx as any).activator = this.activator;
    (ctx as any).capabilities = this.capabilityCatalog;
    (ctx as any).capabilityPolicy = this.capabilityPolicy;
    (ctx as any).worktrees = this.worktreeManager;
    (ctx as any).approvals = this.approvalManager;
    (ctx as any).reviews = this.reviewManager;
    (ctx as any).ocrReview = this.ocrReview;
    (ctx as any).verification = this.verificationPolicy;
    (ctx as any).workflow = this.workflowMap;
  }

  dispose(ctx: KernelContext): void {
    if (this.onWorkspaceChanged) {
      ctx.events.off('workspace:changed', this.onWorkspaceChanged);
      this.onWorkspaceChanged = undefined;
    }
    if (this.onToolAfter) {
      ctx.events.off('tool:after', this.onToolAfter);
      this.onToolAfter = undefined;
    }
    ctx.agentHooks.unregister('superpowers-activator');
  }

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  getCapabilityCatalog(): CapabilityCatalog {
    return this.capabilityCatalog;
  }

  getActivator(): SkillActivator {
    return this.activator;
  }

  getApprovalManager(): ApprovalManager {
    return this.approvalManager;
  }

  getReviewManager(): ReviewManager {
    return this.reviewManager;
  }

  getOcrReviewService(): OcrReviewService | undefined {
    return this.ocrReview;
  }

  getVerificationPolicy(): VerificationPolicy {
    return this.verificationPolicy;
  }
}
