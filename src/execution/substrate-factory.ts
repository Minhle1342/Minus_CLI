import { IExecutionSubstrate, SubstrateType } from './types.js';
import { LocalExecutionSubstrate } from './local-substrate.js';
import { IsolatedExecutionSubstrate } from './isolated-substrate.js';
import { SandboxPolicyMode } from '../sandbox/sandbox-policy.js';

export interface SubstrateFactoryOptions {
  type?: SubstrateType;
  workspaceRoot: string;
  policyMode?: SandboxPolicyMode;
  timeoutMs?: number;
}

/**
 * ExecutionSubstrateFactory - Nhà máy Khởi tạo Substrate theo Cấu hình
 */
export class ExecutionSubstrateFactory {
  static create(options: SubstrateFactoryOptions): IExecutionSubstrate {
    const type = options.type || (process.env.EXECUTION_SUBSTRATE as SubstrateType) || 'sandboxed';

    switch (type) {
      case 'local':
        return new LocalExecutionSubstrate({
          defaultCwd: options.workspaceRoot,
          defaultTimeoutMs: options.timeoutMs,
        });

      case 'sandboxed':
      default:
        return new IsolatedExecutionSubstrate({
          workspaceRoot: options.workspaceRoot,
          policyMode: options.policyMode || 'workspace-write',
          defaultTimeoutMs: options.timeoutMs,
        });
    }
  }
}
