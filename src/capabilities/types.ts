export type CapabilityCategory =
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'worktree'
  | 'agent'
  | 'approval'
  | 'planning'
  | 'memory'
  | 'network'
  | 'review';

export type CapabilitySideEffect = 'none' | 'workspace' | 'external';

export interface CapabilityDescriptor {
  name: string;
  toolName?: string;
  category: CapabilityCategory;
  sideEffect: CapabilitySideEffect;
  reversible: boolean;
  requiresApproval: boolean;
  retryable: boolean;
  description: string;
  scope?: string;
}

export interface CapabilityDecision {
  capabilityName: string;
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

export interface CapabilityPolicyConfig {
  denyCategories?: CapabilityCategory[];
  denyCapabilities?: string[];
  requireApprovalCapabilities?: string[];
  allowedScopes?: string[];
}
