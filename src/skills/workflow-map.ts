export type WorkflowPhase =
  | 'brainstorming'
  | 'design_approved'
  | 'worktree_isolated'
  | 'writing_plans'
  | 'tdd_implementation'
  | 'task_review'
  | 'verification'
  | 'finishing_branch'
  | 'completed';

export interface WorkflowTransition {
  from: WorkflowPhase;
  to: WorkflowPhase;
  requiredSkill?: string;
  reason?: string;
}

export class SuperpowersWorkflowMap {
  private currentPhase: WorkflowPhase = 'brainstorming';
  private history: { phase: WorkflowPhase; timestamp: string; reason?: string }[] = [
    { phase: 'brainstorming', timestamp: new Date().toISOString(), reason: 'Initial phase' },
  ];

  static readonly PHASE_RECOMMENDED_SKILLS: Record<WorkflowPhase, string[]> = {
    brainstorming: ['using-superpowers', 'brainstorming'],
    design_approved: ['using-git-worktrees'],
    worktree_isolated: ['writing-plans'],
    writing_plans: ['writing-plans', 'subagent-driven-development'],
    tdd_implementation: ['test-driven-development', 'subagent-driven-development'],
    task_review: ['requesting-code-review'],
    verification: ['test-driven-development', 'verification-before-completion'],
    finishing_branch: ['finishing-a-development-branch'],
    completed: [],
  };

  /**
   * Lấy giai đoạn hiện tại
   */
  getCurrentPhase(): WorkflowPhase {
    return this.currentPhase;
  }

  /**
   * Chuyển đổi giai đoạn an toàn
   */
  transitionTo(nextPhase: WorkflowPhase, reason?: string): boolean {
    const valid = this.isValidTransition(this.currentPhase, nextPhase);
    if (!valid) {
      return false;
    }

    this.currentPhase = nextPhase;
    this.history.push({
      phase: nextPhase,
      timestamp: new Date().toISOString(),
      reason,
    });

    return true;
  }

  /**
   * Kiểm tra tính hợp lệ của luồng chuyển đổi
   */
  isValidTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
    const validTransitions: Record<WorkflowPhase, WorkflowPhase[]> = {
      brainstorming: ['design_approved', 'writing_plans', 'worktree_isolated'],
      design_approved: ['worktree_isolated', 'writing_plans'],
      worktree_isolated: ['writing_plans', 'tdd_implementation'],
      writing_plans: ['tdd_implementation', 'worktree_isolated'],
      tdd_implementation: ['task_review', 'verification', 'finishing_branch'],
      task_review: ['tdd_implementation', 'verification', 'finishing_branch'],
      verification: ['tdd_implementation', 'finishing_branch', 'completed'],
      finishing_branch: ['completed', 'verification'],
      completed: ['brainstorming'],
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  /**
   * Lấy danh sách kỹ năng đề xuất cho giai đoạn hiện tại
   */
  getRecommendedSkills(): string[] {
    return SuperpowersWorkflowMap.PHASE_RECOMMENDED_SKILLS[this.currentPhase] || [];
  }

  getHistory(): { phase: WorkflowPhase; timestamp: string; reason?: string }[] {
    return [...this.history];
  }
}
