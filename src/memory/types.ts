export type MemoryScope = 'project' | 'session' | 'goal';
export type MemorySource = 'manual' | 'workspace-index' | 'tool-result' | 'model';
export type MemoryCategory = 'convention' | 'architecture' | 'gotcha' | 'rule' | 'insight';
export type MemoryTrustStatus = 'active' | 'contested' | 'superseded';

export interface MemoryRecord {
  id: string;
  key: string;
  insight: string;
  category: MemoryCategory;
  scope: MemoryScope;
  source: MemorySource;
  confidence: number;
  trustStatus: MemoryTrustStatus;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  goalId?: string;
  tags?: string[];
  sourceEventSeq?: number;
  sourceToolCallId?: string;
  expiresAt?: string;
  conflictReason?: string;
}

export interface MemoryQueryOptions {
  scopes?: MemoryScope[];
  limit?: number;
  sessionId?: string;
  goalId?: string;
  minConfidence?: number;
  includeContested?: boolean;
  includeExpired?: boolean;
}
