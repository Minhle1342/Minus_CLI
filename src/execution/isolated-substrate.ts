import {
  IExecutionSubstrate,
  SubstrateCommandOptions,
  SubstrateExecutionResult,
  SubstrateTelemetry,
  SubstrateType,
} from './types.js';
import { LocalExecutionSubstrate } from './local-substrate.js';
import { SandboxPolicyEngine, SandboxPolicyMode } from '../sandbox/sandbox-policy.js';

export interface IsolatedSubstrateConfig {
  workspaceRoot: string;
  policyMode?: SandboxPolicyMode;
  defaultTimeoutMs?: number;
}

/**
 * IsolatedExecutionSubstrate - Tầng Thực thi Phân lập có Kiểm soát Chính sách (Sandboxed Substrate)
 * 
 * Kiểm duyệt mọi lệnh trước khi chuyển tới Host Substrate bằng SandboxPolicyEngine.
 */
export class IsolatedExecutionSubstrate implements IExecutionSubstrate {
  readonly name = 'isolated-sandboxed-substrate';
  readonly type: SubstrateType = 'sandboxed';

  private innerSubstrate: LocalExecutionSubstrate;
  private policyEngine: SandboxPolicyEngine;

  constructor(config: IsolatedSubstrateConfig) {
    this.innerSubstrate = new LocalExecutionSubstrate({
      defaultCwd: config.workspaceRoot,
      defaultTimeoutMs: config.defaultTimeoutMs,
    });
    this.policyEngine = new SandboxPolicyEngine(config.workspaceRoot, config.policyMode || 'workspace-write');
  }

  async init(): Promise<void> {
    await this.innerSubstrate.init();
  }

  async isAvailable(): Promise<boolean> {
    return this.innerSubstrate.isAvailable();
  }

  getPolicyEngine(): SandboxPolicyEngine {
    return this.policyEngine;
  }

  async exec(command: string, options: SubstrateCommandOptions = {}): Promise<SubstrateExecutionResult> {
    const startTime = Date.now();

    // 1. Đánh giá lệnh qua Sandbox Policy Engine
    const evalResult = this.policyEngine.evaluateCommand(command, options.cwd);
    if (!evalResult.allowed) {
      return {
        stdout: '',
        stderr: `[Sandbox Policy Rejection]: ${evalResult.reason || 'Command violates sandbox policy.'}`,
        exitCode: 126, // Command invoked cannot execute
        durationMs: Date.now() - startTime,
        substrateType: this.type,
        success: false,
        diagnostic: evalResult.reason,
        suggestion: 'Check permissions or perform the operation within the workspace scope.',
      };
    }

    // 2. Làm sạch biến môi trường
    const sanitizedEnv = this.policyEngine.sanitizeEnvironment(
      options.isolatedEnv ? { ...options.env } : { ...process.env, ...options.env },
    );

    // 3. Chuyển tiếp thực thi tới Inner Substrate
    return this.innerSubstrate.exec(evalResult.sanitizedCommand || command, {
      ...options,
      env: sanitizedEnv,
      isolatedEnv: true,
    });
  }

  getTelemetry(): SubstrateTelemetry {
    return this.innerSubstrate.getTelemetry();
  }

  async dispose(): Promise<void> {
    await this.innerSubstrate.dispose();
  }
}
