import type { MemoryCategory } from './types.js';

export type RepositoryCitationKind = 'file' | 'session-event' | 'commit' | 'compose';
export type RepositoryMemoryStatus = 'active' | 'stale' | 'contested' | 'superseded';
export type RepositoryMemorySource = 'manual' | 'tool-observation' | 'dream' | 'compose';

export interface FileRepositoryCitation {
  kind: 'file';
  path: string;
  contentHash: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface SessionEventRepositoryCitation {
  kind: 'session-event';
  sessionId: string;
  eventSeq: number;
  eventId?: string;
  eventType?: string;
  toolName?: string;
  outcome?: 'success' | 'failure';
}

export interface CommitRepositoryCitation {
  kind: 'commit';
  commit: string;
}

export interface ComposeRepositoryCitation {
  kind: 'compose';
  composeId: string;
  specHash?: string;
}

export type RepositoryCitation =
  | FileRepositoryCitation
  | SessionEventRepositoryCitation
  | CommitRepositoryCitation
  | ComposeRepositoryCitation;

export interface RepositoryMemoryRecord {
  id: string;
  statement: string;
  category: MemoryCategory;
  source: RepositoryMemorySource;
  confidence: number;
  status: RepositoryMemoryStatus;
  citations: RepositoryCitation[];
  concepts: string[];
  relatedFiles: string[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  invalidReasons?: string[];
  accessCount: number;
  supersedes?: string[];
}

export interface RepositoryMemoryStore {
  version: 1;
  records: RepositoryMemoryRecord[];
}

export interface CitationValidation {
  citation: RepositoryCitation;
  valid: boolean;
  reason?: string;
}

export interface RepositoryMemoryValidation {
  valid: boolean;
  validations: CitationValidation[];
  reasons: string[];
}

export interface RepositoryMemoryRecallResult {
  records: RepositoryMemoryRecord[];
  rendered: string;
  staleIds: string[];
  remoteAvailable: boolean;
}

export interface RepositoryMemoryInput {
  statement: string;
  category?: MemoryCategory;
  source?: RepositoryMemorySource;
  confidence?: number;
  citations: RepositoryCitation[];
  concepts?: string[];
  relatedFiles?: string[];
  supersedes?: string[];
}
