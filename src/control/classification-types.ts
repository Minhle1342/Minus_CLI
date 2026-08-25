export type TaskClass = 'question' | 'exploration' | 'bugfix' | 'feature' | 'refactor' | 'release' | 'operations';
export type TaskPhase = 'explore' | 'plan' | 'implement' | 'verify' | 'release';
export type TaskComplexity = 'trivial' | 'small' | 'medium' | 'large';
export type Externality = 'local' | 'network' | 'external-state';
export type Reversibility = 'read-only' | 'reversible' | 'hard-to-reverse';
export type ControlRisk = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type Capability =
  | 'inspect'
  | 'search'
  | 'plan'
  | 'memory'
  | 'edit'
  | 'execute'
  | 'verify'
  | 'git-read'
  | 'git-write'
  | 'network'
  | 'delegate'
  | 'complete';

export interface ClassificationDecision {
  id: string;
  version: 1;
  taskClass: TaskClass;
  phase: TaskPhase;
  complexity: TaskComplexity;
  externality: Externality;
  reversibility: Reversibility;
  risk: ControlRisk;
  requiredCapabilities: Capability[];
  confidence: number;
  fastPath: boolean;
  reasonCodes: string[];
  createdAt: string;
}

export type ToolControlMode = 'off' | 'shadow' | 'enforce';
