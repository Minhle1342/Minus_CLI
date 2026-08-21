export type MemoryScope = 'project' | 'session' | 'goal';
export type MemorySource = 'manual' | 'workspace-index' | 'tool-result' | 'model';
export type MemoryCategory = 'convention' | 'architecture' | 'gotcha' | 'rule' | 'insight';

export interface MemoryRecord {
  id: string;
  key: string;
  insight: string;
  category: MemoryCategory;
  scope: MemoryScope;
  source: MemorySource;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  goalId?: string;
  tags?: string[];
}

export interface MemoryQueryOptions {
  scopes?: MemoryScope[];
  limit?: number;
  sessionId?: string;
  goalId?: string;
}
