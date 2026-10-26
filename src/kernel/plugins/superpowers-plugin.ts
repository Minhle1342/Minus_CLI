import { AgentPlugin, KernelContext } from '../kernel.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { SuperpowersSource } from '../../skills/superpowers-source.js';
import { CapabilityCatalog } from '../../capabilities/capability-catalog.js';
import { CapabilityPolicy } from '../../capabilities/capability-policy.js';
import { createDefaultCapabilityCatalog } from '../../capabilities/default-capabilities.js';
import { WorktreeManager } from '../../workspace/worktree-manager.js';
import { ApprovalManager } from '../../agent/approval-manager.js';
import { ReviewManager } from '../../agent/review-manager.js';
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

  async apply(ctx: KernelContext): Promise<void> {
    this.worktreeManager = new WorktreeManager(ctx.workspace.rootDir);
    this.ocrReview = new OcrReviewService(ctx.workspace.rootDir);

    // 1. Nạp Superpowers Skills
    SuperpowersSource.registerSuperpowers(this.skillRegistry);

    this.onWorkspaceChanged = () => {
      this.worktreeManager = new WorktreeManager(ctx.workspace.rootDir);
      this.ocrReview?.setWorkspace(ctx.workspace.rootDir);
      (ctx as any).worktrees = this.worktreeManager;
    };
    ctx.events.on('workspace:changed', this.onWorkspaceChanged);

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
    (ctx as any).capabilities = this.capabilityCatalog;
    (ctx as any).capabilityPolicy = this.capabilityPolicy;
    (ctx as any).worktrees = this.worktreeManager;
    (ctx as any).approvals = this.approvalManager;
    (ctx as any).reviews = this.reviewManager;
    (ctx as any).ocrReview = this.ocrReview;
    (ctx as any).verification = this.verificationPolicy;
    // Legacy advisory map; phase authority belongs to the main phase controller.
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
    ctx.systemPrompt.unregister('dynamic-skill-loading');
  }

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  getCapabilityCatalog(): CapabilityCatalog {
    return this.capabilityCatalog;
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
