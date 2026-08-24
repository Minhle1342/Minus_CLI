import type { MemoryCategory, MemoryProvenance } from '../memory/types.js';

export type DreamEvidenceKind = 'human' | 'tool-success' | 'tool-failure' | 'plan' | 'goal' | 'memory' | 'audit';

export interface DreamEvidence {
  id: string;
  sessionId: string;
  eventSeq: number;
  createdAt: string;
  kind: DreamEvidenceKind;
  text: string;
  verified: boolean;
}

export interface DreamCursor {
  lastSeq: number;
}

export interface DreamState {
  version: 1;
  lastRunAt?: string;
  lastSuccessfulRunId?: string;
  cursors: Record<string, DreamCursor>;
  lastReport?: DreamRunReport;
}

export interface DreamProposal {
  action: 'remember' | 'forget';
  key: string;
  insight?: string;
  category?: MemoryCategory;
  confidence: number;
  evidenceIds: string[];
  tags?: string[];
  reason?: string;
}

export interface DreamAgentInput {
  evidence: DreamEvidence[];
  existingMemory: Array<{
    id: string;
    key: string;
    insight: string;
    category: MemoryCategory;
    confidence: number;
    trustStatus: string;
  }>;
  maxProposals: number;
}

export interface DreamAgent {
  readonly model: string;
  isConfigured(): boolean;
  propose(input: DreamAgentInput): Promise<DreamProposal[]>;
}

export interface DreamConfig {
  enabled: boolean;
  intervalMs: number;
  maxSessions: number;
  maxEvents: number;
  maxInputChars: number;
  maxProposals: number;
  minEvidence: number;
  lockStaleMs: number;
}

export interface DreamScanResult {
  evidence: DreamEvidence[];
  nextCursors: Record<string, DreamCursor>;
  scannedSessions: number;
  scannedEvents: number;
  truncated: boolean;
}

export interface DreamRunReport {
  runId: string;
  model: string;
  mode: 'apply' | 'preview' | 'auto';
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  startedAt: string;
  finishedAt: string;
  scannedSessions: number;
  scannedEvents: number;
  evidenceCount: number;
  proposals: number;
  accepted: number;
  rejected: number;
  upserted: number;
  superseded: number;
  pruned: number;
  preview?: Array<{ key: string; action: string; confidence: number; evidence: number }>;
}

export interface VerifiedDreamMemory {
  key: string;
  insight: string;
  category: MemoryCategory;
  confidence: number;
  tags: string[];
  provenance: MemoryProvenance[];
}
