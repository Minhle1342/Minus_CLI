/**
 * Builds a read-only, failure-conditioned investigation menu for verification
 * failures. It intentionally does not block a repair: a precise compiler error
 * can justify a direct, bounded fix. The menu gives the model grounded options
 * before it chooses its next action.
 */
export interface FailureInvestigationMutation {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
  files: string[];
}

export interface FailureInvestigationOption {
  id: string;
  toolName: 'read_file' | 'get_diagnostics' | 'query_call_graph';
  args: Record<string, any>;
  reason: string;
  expectedInformationGain: 'high' | 'medium';
}

export interface FailureInvestigationBrief {
  mode: 'soft';
  command: string;
  exitCode?: number;
  failureExcerpt: string;
  recentMutation?: {
    toolName: string;
    files: string[];
    modifiedSymbols: string[];
    directConsumers: string[];
    impactedTestSuites: string[];
  };
  options: FailureInvestigationOption[];
  prompt: string;
}

export interface FailureInvestigationInput {
  command: string;
  result: Record<string, any>;
  recentMutation?: FailureInvestigationMutation;
}

interface ErrorLocation {
  path: string;
  line?: number;
}

const SOURCE_FILE_PATTERN = /((?:[A-Za-z]:[\\/])?[\w@./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|cpp|c|h))(?:\:(\d+)(?:\:\d+)?)?/i;

function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item : item && typeof item === 'object' ? (item as any).name || (item as any).path : '')
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function findErrorLocation(text: string): ErrorLocation | undefined {
  const match = SOURCE_FILE_PATTERN.exec(text);
  if (!match) return undefined;
  return {
    path: match[1].replace(/\\/g, '/'),
    ...(match[2] ? { line: Number(match[2]) } : {}),
  };
}

function collectMutationFiles(mutation?: FailureInvestigationMutation): string[] {
  if (!mutation) return [];
  return unique([
    ...mutation.files,
    ...toStrings(mutation.result.changedFiles),
    ...toStrings(mutation.result.filesModified),
    ...toStrings(mutation.result.modifiedFiles),
    ...['path', 'filePath', 'targetFile', 'TargetFile'].flatMap((key) => {
      const value = mutation.args[key] ?? mutation.result[key];
      return typeof value === 'string' ? [value] : [];
    }),
  ]);
}

function summarizeMutation(mutation?: FailureInvestigationMutation): FailureInvestigationBrief['recentMutation'] | undefined {
  if (!mutation) return undefined;
  const blast = mutation.result.blastRadius && typeof mutation.result.blastRadius === 'object'
    ? mutation.result.blastRadius as Record<string, any>
    : {};
  const files = collectMutationFiles(mutation);
  const modifiedSymbols = unique([
    ...toStrings(blast.modifiedSymbols),
    ...toStrings(blast.changedSymbols),
  ]);
  const directConsumers = toStrings(blast.directConsumers);
  const impactedTestSuites = toStrings(blast.impactedTestSuites);
  if (!files.length && !modifiedSymbols.length && !directConsumers.length && !impactedTestSuites.length) return undefined;
  return { toolName: mutation.toolName, files, modifiedSymbols, directConsumers, impactedTestSuites };
}

function lineWindow(line?: number): Partial<Pick<FailureInvestigationOption['args'], 'startLine' | 'endLine'>> {
  if (!line || !Number.isFinite(line)) return {};
  return { startLine: Math.max(1, line - 10), endLine: line + 15 };
}

/**
 * Produce at most three high-signal read-only options. Callers expose the
 * returned prompt and options to the model; they never dispatch these tools.
 */
export function buildFailureInvestigationBrief(input: FailureInvestigationInput): FailureInvestigationBrief {
  const failureText = [input.result.stderr, input.result.error, input.result.diagnostic, input.result.stdout]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
  const failureExcerpt = (failureText || 'Verification failed without diagnostic output.').slice(0, 600);
  const location = findErrorLocation(failureText);
  const recentMutation = summarizeMutation(input.recentMutation);
  const options: FailureInvestigationOption[] = [];
  const addOption = (option: FailureInvestigationOption) => {
    if (!options.some((item) => item.toolName === option.toolName && JSON.stringify(item.args) === JSON.stringify(option.args))) {
      options.push(option);
    }
  };

  if (location) {
    addOption({
      id: 'inspect-failure-location',
      toolName: 'read_file',
      args: { path: location.path, ...lineWindow(location.line) },
      reason: `Read the source location named by the failing verification${location.line ? ` (line ${location.line})` : ''}.`,
      expectedInformationGain: 'high',
    });
    if (/\.[cm]?[jt]sx?$/i.test(location.path)) {
      addOption({
        id: 'diagnose-failure-location',
        toolName: 'get_diagnostics',
        args: { path: location.path },
        reason: 'Check compiler and type diagnostics at the reported TypeScript/JavaScript file.',
        expectedInformationGain: 'high',
      });
    }
  }

  const mutationFile = recentMutation?.files.find((file) => file !== location?.path);
  if (mutationFile) {
    addOption({
      id: 'inspect-recent-mutation',
      toolName: 'read_file',
      args: { path: mutationFile },
      reason: 'Compare the most recent mutation with the failure before changing another file.',
      expectedInformationGain: 'high',
    });
  }

  const mutationSymbol = recentMutation?.modifiedSymbols[0];
  if (mutationSymbol) {
    addOption({
      id: 'trace-mutated-symbol-consumers',
      toolName: 'query_call_graph',
      args: { symbolName: mutationSymbol, direction: 'callers', depth: 1, pruneNoise: true },
      reason: 'Inspect direct consumers of the recently changed symbol for a causal link to the verification failure.',
      expectedInformationGain: 'medium',
    });
  }

  if (!options.length) {
    addOption({
      id: 'collect-workspace-diagnostics',
      toolName: 'get_diagnostics',
      args: {},
      reason: 'The failure has no usable source location; collect diagnostics before changing code.',
      expectedInformationGain: 'medium',
    });
  }

  const selected = options.slice(0, 3);
  const mutationLine = recentMutation
    ? `Recent mutation: ${recentMutation.toolName}; files=${recentMutation.files.join(', ') || 'unknown'}; symbols=${recentMutation.modifiedSymbols.join(', ') || 'unknown'}; direct consumers=${recentMutation.directConsumers.join(', ') || 'unknown'}.`
    : 'Recent mutation: no reliable mutation evidence is available.';
  const optionsText = selected.map((option, index) => (
    `${index + 1}. ${option.toolName}(${JSON.stringify(option.args)}) — ${option.reason} [${option.expectedInformationGain} information gain]`
  )).join('\n');
  const prompt = [
    '[SOFT FAILURE INVESTIGATION MODE]',
    `Verification command failed${typeof input.result.exitCode === 'number' ? ` (exit ${input.result.exitCode})` : ''}: ${input.command}`,
    mutationLine,
    'Choose the smallest discriminating read-only investigation before mutating when uncertainty remains:',
    optionsText,
    'A direct bounded repair is still allowed when the diagnostic identifies an unambiguous local cause. If repairing now, base it on the observed error and do not rerun the same verification unchanged.',
  ].join('\n');

  return {
    mode: 'soft',
    command: input.command,
    ...(typeof input.result.exitCode === 'number' ? { exitCode: input.result.exitCode } : {}),
    failureExcerpt,
    ...(recentMutation ? { recentMutation } : {}),
    options: selected,
    prompt,
  };
}
