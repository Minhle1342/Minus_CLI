import type {
  EvidenceRecord,
  EvidenceType,
  EvidenceStatus,
  EvidenceFreshness,
} from '../control-plane-state.js';

export interface CreateEvidenceParams {
  type: EvidenceType;
  workspaceDigest?: string;
  mutationSeq?: number;
  sourceTool: string;
  status: EvidenceStatus;
  summary: string;
  command?: string;
  target?: string;
  affectedFiles?: string[];
  supports?: string[];
  contradicts?: string[];
  artifactRefs?: string[];
  rawDetails?: Record<string, any>;
}

export class EvidenceRecordBuilder {
  private static counter = 0;

  static create(params: CreateEvidenceParams): EvidenceRecord {
    this.counter++;
    const evidenceId = `ev_${Date.now()}_${this.counter}`;
    const freshness: EvidenceFreshness = params.status === 'STALE' ? 'STALE' : 'FRESH';

    return {
      evidenceId,
      type: params.type,
      generatedAt: Date.now(),
      workspaceDigest: params.workspaceDigest || 'unknown',
      mutationSeq: params.mutationSeq ?? 0,
      sourceTool: params.sourceTool,
      command: params.command,
      target: params.target,
      affectedFiles: params.affectedFiles,
      status: params.status,
      freshness,
      supports: params.supports || [],
      contradicts: params.contradicts || [],
      artifactRefs: params.artifactRefs,
      summary: params.summary,
      rawDetails: params.rawDetails,
    };
  }
}
