import type {
  MutationTransaction,
  TransactionStatus,
} from '../control-plane-state.js';

export interface OpenTransactionParams {
  baseCheckpointId: string;
  baseWorkspaceDigest: string;
  affectedFiles?: string[];
  affectedSymbols?: string[];
  expectedEffects?: string[];
}

export class MutationTransactionManager {
  private currentTransaction?: MutationTransaction;
  private transactionCounter = 0;

  openTransaction(params: OpenTransactionParams): MutationTransaction {
    this.transactionCounter++;
    const transactionId = `tx_${Date.now()}_${this.transactionCounter}`;

    const tx: MutationTransaction = {
      transactionId,
      baseCheckpointId: params.baseCheckpointId,
      baseWorkspaceDigest: params.baseWorkspaceDigest,
      status: 'OPEN',
      affectedFiles: params.affectedFiles || [],
      affectedSymbols: params.affectedSymbols || [],
      mutationIds: [],
      expectedEffects: params.expectedEffects || [],
      openedAt: Date.now(),
    };

    this.currentTransaction = tx;
    return tx;
  }

  getActiveTransaction(): MutationTransaction | undefined {
    return this.currentTransaction;
  }

  recordMutation(mutationId: string, filePath: string): void {
    if (this.currentTransaction) {
      if (!this.currentTransaction.mutationIds.includes(mutationId)) {
        this.currentTransaction.mutationIds.push(mutationId);
      }
      if (!this.currentTransaction.affectedFiles.includes(filePath)) {
        this.currentTransaction.affectedFiles.push(filePath);
      }
    }
  }

  markVerifying(): void {
    if (this.currentTransaction) {
      this.currentTransaction.status = 'VERIFYING';
    }
  }

  commit(): MutationTransaction | undefined {
    if (!this.currentTransaction) return undefined;
    this.currentTransaction.status = 'COMMITTED';
    this.currentTransaction.closedAt = Date.now();
    const finished = this.currentTransaction;
    this.currentTransaction = undefined;
    return finished;
  }

  rollback(): MutationTransaction | undefined {
    if (!this.currentTransaction) return undefined;
    this.currentTransaction.status = 'ROLLED_BACK';
    this.currentTransaction.closedAt = Date.now();
    const finished = this.currentTransaction;
    this.currentTransaction = undefined;
    return finished;
  }
}
