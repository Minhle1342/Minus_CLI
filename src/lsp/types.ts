export type LspOperation =
  | 'hover'
  | 'definition'
  | 'references'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'implementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface NormalizedLspDiagnostic {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  message: string;
  code?: string | number;
  source?: string;
  category: 'error' | 'warning' | 'information' | 'hint';
  provider: string;
}

export interface LspServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  rootMarkers: string[];
  env: Record<string, string>;
  initializationOptions?: unknown;
  trust: boolean;
}

export interface LspRuntimeConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  diagnosticsWaitMs: number;
  brokenServerCooldownMs: number;
  maxDiagnosticsPerFile: number;
  servers: LspServerConfig[];
  configPath?: string;
  warnings: string[];
}

export interface LspServerStatus {
  id: string;
  root: string;
  status: 'starting' | 'connected' | 'broken';
  detail?: string;
}

