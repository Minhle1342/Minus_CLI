import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type AciGuardrailMode = 'off' | 'observe' | 'enforce';

export interface AciToolInvocationInput {
  toolName: string;
  args: Record<string, unknown>;
  workspaceRoot: string;
}

export interface AciValidationResult {
  allowed: boolean;
  sanitizedArgs?: Record<string, unknown>;
  reasonCode?: string;
  rejectionMessage?: string;
  remediationHint?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';
}

export interface AciGuardrailTelemetrySnapshot {
  totalValidations: number;
  blockedCalls: number;
  syntaxViolationsPrevented: number;
  safetyViolationsBlocked: number;
  ambiguousReplacementsBlocked: number;
  pathViolationsBlocked: number;
}

export function resolveAciGuardrailMode(value = process.env.MINUS_ACI_GUARDRAILS): AciGuardrailMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'enforce' || normalized === 'observe') return normalized;
  if (normalized === 'off') return 'off';
  return 'observe';
}

export class AciGuardrails {
  private totalValidations = 0;
  private blockedCalls = 0;
  private syntaxViolationsPrevented = 0;
  private safetyViolationsBlocked = 0;
  private ambiguousReplacementsBlocked = 0;
  private pathViolationsBlocked = 0;

  validate(input: AciToolInvocationInput, mode: AciGuardrailMode = 'observe'): AciValidationResult {
    this.totalValidations++;
    const { toolName, args, workspaceRoot } = input;

    // 1. Safety Guardrails for Shell Commands (SWE-agent Command Isolation & Safety Rules)
    if (toolName === 'run_command' || toolName === 'execute_command') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (/git\s+push(\s+.*)?\s+main\b/i.test(command)) {
        this.blockedCalls++;
        this.safetyViolationsBlocked++;
        return {
          allowed: mode !== 'enforce',
          reasonCode: 'PROHIBITED_PUSH_TO_MAIN',
          rejectionMessage: 'ACI Guardrail: Direct git push to main is strictly prohibited without explicit user instruction.',
          remediationHint: 'Push to a feature branch or request explicit confirmation from the user.',
          riskLevel: 'BLOCKED',
        };
      }

      if (/rm\s+-rf\s+(\/|~|\.\.)/i.test(command) || /del\s+\/[sfq]\s+[c-z]:\\/i.test(command)) {
        this.blockedCalls++;
        this.safetyViolationsBlocked++;
        return {
          allowed: mode !== 'enforce',
          reasonCode: 'CATASTROPHIC_DELETION_BLOCKED',
          rejectionMessage: 'ACI Guardrail: Catastrophic deletion command targeting root or home directory blocked.',
          riskLevel: 'BLOCKED',
        };
      }
    }

    // 2. Pre-validation for Mutation Tools (SWE-agent Lint-in-the-loop & Path Sandboxing)
    if (toolName === 'replace_text' || toolName === 'replace_file_content') {
      const filePath = typeof args.path === 'string' ? args.path : typeof args.TargetFile === 'string' ? args.TargetFile : '';
      const targetContent = typeof args.searchContent === 'string' ? args.searchContent
        : typeof args.TargetContent === 'string' ? args.TargetContent
        : typeof args.target === 'string' ? args.target : undefined;
      const replacement = typeof args.replaceWith === 'string' ? args.replaceWith
        : typeof args.ReplacementContent === 'string' ? args.ReplacementContent
        : typeof args.replacement === 'string' ? args.replacement : undefined;

      if (!filePath) {
        this.blockedCalls++;
        this.pathViolationsBlocked++;
        return {
          allowed: mode !== 'enforce',
          reasonCode: 'MISSING_FILE_PATH',
          rejectionMessage: 'ACI Guardrail: Target file path is missing in mutation tool invocation.',
          riskLevel: 'HIGH',
        };
      }

      const resolved = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(workspaceRoot, filePath));
      if (!fs.existsSync(resolved)) {
        this.blockedCalls++;
        this.pathViolationsBlocked++;
        return {
          allowed: mode !== 'enforce',
          reasonCode: 'FILE_NOT_FOUND',
          rejectionMessage: `ACI Guardrail: Target file does not exist: ${filePath}`,
          remediationHint: 'Verify the file path with search_codebase_fast or locate_files before modifying.',
          riskLevel: 'HIGH',
        };
      }

      if (targetContent !== undefined && replacement !== undefined) {
        try {
          const content = fs.readFileSync(resolved, 'utf-8');
          if (!content.includes(targetContent)) {
            this.blockedCalls++;
            this.ambiguousReplacementsBlocked++;
            return {
              allowed: mode !== 'enforce',
              reasonCode: 'TARGET_CONTENT_NOT_FOUND',
              rejectionMessage: `ACI Guardrail: targetContent was not found in ${filePath}.`,
              remediationHint: 'Read the latest file content using read_file before attempting replace_text.',
              riskLevel: 'HIGH',
            };
          }

          const occurrences = content.split(targetContent).length - 1;
          const allowMultiple = Boolean(args.allowMultiple);
          if (occurrences > 1 && !allowMultiple) {
            this.blockedCalls++;
            this.ambiguousReplacementsBlocked++;
            return {
              allowed: mode !== 'enforce',
              reasonCode: 'AMBIGUOUS_REPLACEMENT',
              rejectionMessage: `ACI Guardrail: targetContent appears ${occurrences} times in ${filePath}. Ambiguous replacement is dangerous.`,
              remediationHint: 'Provide more surrounding context in targetContent or specify unique line range.',
              riskLevel: 'HIGH',
            };
          }

          // Syntax verification after simulated replacement for TypeScript/JavaScript
          if (/\.(ts|tsx|js|jsx)$/i.test(resolved)) {
            const simulatedContent = content.replace(targetContent, replacement);
            const syntaxCheck = this.checkTypeScriptSyntax(resolved, simulatedContent);
            if (!syntaxCheck.valid) {
              this.blockedCalls++;
              this.syntaxViolationsPrevented++;
              return {
                allowed: mode !== 'enforce',
                reasonCode: 'SYNTAX_VIOLATION_PREVENTED',
                rejectionMessage: `ACI Guardrail: Replacement introduces fatal syntax errors: ${syntaxCheck.error}`,
                remediationHint: 'Check matching braces, semicolons, and export syntax in replacementContent.',
                riskLevel: 'HIGH',
              };
            }
          } else if (/\.json$/i.test(resolved)) {
            const simulatedContent = content.replace(targetContent, replacement);
            try {
              JSON.parse(simulatedContent);
            } catch (jsonErr: any) {
              this.blockedCalls++;
              this.syntaxViolationsPrevented++;
              return {
                allowed: mode !== 'enforce',
                reasonCode: 'INVALID_JSON_PREVENTED',
                rejectionMessage: `ACI Guardrail: Replacement results in malformed JSON: ${jsonErr.message}`,
                riskLevel: 'HIGH',
              };
            }
          }
        } catch (readErr: any) {
          // File read error, pass through safely
        }
      }
    }

    // 3. Pre-validation for File Reading Tools
    if (toolName === 'read_file') {
      const filePath = typeof args.path === 'string' ? args.path : '';
      if (filePath) {
        const resolved = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(workspaceRoot, filePath));
        if (!fs.existsSync(resolved)) {
          this.blockedCalls++;
          this.pathViolationsBlocked++;
          return {
            allowed: mode !== 'enforce',
            reasonCode: 'READ_FILE_NOT_FOUND',
            rejectionMessage: `ACI Guardrail: File not found: ${filePath}`,
            remediationHint: 'Use search_codebase_fast to find the correct path before reading.',
            riskLevel: 'MEDIUM',
          };
        }
      }
    }

    return {
      allowed: true,
      riskLevel: 'LOW',
    };
  }

  private checkTypeScriptSyntax(fileName: string, content: string): { valid: boolean; error?: string } {
    try {
      const sourceFile = ts.createSourceFile(
        fileName,
        content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const parseDiagnostics = (sourceFile as any).parseDiagnostics;
      if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) {
        const first = parseDiagnostics[0];
        const message = typeof first.messageText === 'string' ? first.messageText : first.messageText?.messageText;
        return { valid: false, error: message || 'Syntax parse error' };
      }
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }

  snapshot(): AciGuardrailTelemetrySnapshot {
    return {
      totalValidations: this.totalValidations,
      blockedCalls: this.blockedCalls,
      syntaxViolationsPrevented: this.syntaxViolationsPrevented,
      safetyViolationsBlocked: this.safetyViolationsBlocked,
      ambiguousReplacementsBlocked: this.ambiguousReplacementsBlocked,
      pathViolationsBlocked: this.pathViolationsBlocked,
    };
  }
}
