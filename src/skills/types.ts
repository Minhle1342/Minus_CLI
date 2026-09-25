export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'builtin' | 'workspace' | 'external';
  path: string;
  requires?: string[];
  conflicts?: string[];
  priority?: number;
  autoActivate?: boolean;
  requiredCapabilities?: string[];
  contentHash?: string;
  tags?: string[];
  author?: string;
}

export interface SkillActivationDecision {
  skillId: string;
  version: string;
  decision: 'activated' | 'rejected' | 'disabled' | 'incompatible';
  reason?: string;
  timestamp: string;
  contentHash?: string;
  injectedSectionName?: string;
}

export interface SkillSourceConfig {
  name: string;
  type: 'local' | 'pinned';
  path: string;
  revision?: string;
}
