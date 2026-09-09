import crypto from 'node:crypto';

export interface StepRetrievalQueryInput {
  userRequest: string;
  activeTask?: {
    title?: string;
    acceptanceCriteria?: string;
    notes?: string;
    readSet?: string[];
    writeSet?: string[];
    symbols?: string[];
  };
  phase?: string;
  taskClass?: string;
  hypothesis?: { statement?: string; targetFiles?: string[] };
  lastToolName?: string;
  lastToolResult?: unknown;
  allowedToolNames?: string[];
}

export interface StepRetrievalQueryResult {
  query: string;
  fingerprint: string;
  failureSignature: string;
  discoveredFiles: string[];
  discoveredSymbols: string[];
}

/** Builds a deterministic, evidence-aware retrieval query for each reasoning step. */
export class StepRetrievalQueryBuilder {
  build(input: StepRetrievalQueryInput): StepRetrievalQueryResult {
    const toolEvidence = this.compactToolEvidence(input.lastToolResult);
    const failureSignature = this.buildFailureSignature(input.lastToolName, toolEvidence);
    const discoveredFiles = this.extractFiles(toolEvidence);
    const discoveredSymbols = this.extractSymbols(toolEvidence);
    const activeFiles = [
      ...(input.activeTask?.readSet || []),
      ...(input.activeTask?.writeSet || []),
      ...(input.hypothesis?.targetFiles || []),
      ...discoveredFiles,
    ];
    const activeSymbols = [...(input.activeTask?.symbols || []), ...discoveredSymbols];

    const parts = [
      input.userRequest,
      input.activeTask?.title,
      input.activeTask?.acceptanceCriteria,
      input.activeTask?.notes,
      input.phase ? `phase:${input.phase}` : '',
      input.taskClass ? `task:${input.taskClass}` : '',
      input.hypothesis?.statement ? `hypothesis:${input.hypothesis.statement}` : '',
      activeFiles.length ? `files:${[...new Set(activeFiles)].join(' ')}` : '',
      activeSymbols.length ? `symbols:${[...new Set(activeSymbols)].join(' ')}` : '',
      input.lastToolName ? `last-tool:${input.lastToolName}` : '',
      toolEvidence ? `evidence:${toolEvidence}` : '',
    ].filter(Boolean);

    const query = parts.join('\n').slice(0, 8_000);
    const fingerprintPayload = JSON.stringify({
      query,
      phase: input.phase || '',
      taskClass: input.taskClass || '',
      hypothesis: input.hypothesis?.statement || '',
      failureSignature,
      allowedToolNames: [...(input.allowedToolNames || [])].sort(),
    });

    return {
      query,
      fingerprint: crypto.createHash('sha256').update(fingerprintPayload).digest('hex'),
      failureSignature,
      discoveredFiles: [...new Set(discoveredFiles)],
      discoveredSymbols: [...new Set(discoveredSymbols)],
    };
  }

  private compactToolEvidence(value: unknown): string {
    if (value === undefined || value === null) return '';
    let text = '';
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      text = String(value);
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 1_600);
  }

  private buildFailureSignature(toolName: string | undefined, evidence: string): string {
    if (!evidence || !/(error|failed|failure|exception|exitcode[^0-9]*[1-9])/i.test(evidence)) return '';
    return crypto.createHash('sha1').update(`${toolName || 'tool'}:${evidence}`).digest('hex').slice(0, 16);
  }

  private extractFiles(text: string): string[] {
    const matches = text.match(/(?:[A-Za-z]:[\\/])?(?:[\w@.-]+[\\/])+[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|java|cs|go|rs|cpp|c|h|md|yaml|yml)/g) || [];
    return matches.map((value) => value.trim()).filter(Boolean).slice(0, 12);
  }

  private extractSymbols(text: string): string[] {
    const matches = text.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g) || [];
    return matches.filter((value) => !value.includes('/')).slice(0, 12);
  }
}
