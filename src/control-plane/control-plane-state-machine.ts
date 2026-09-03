import type {
  LifecycleStatus,
  ControlPlaneState,
  ControlAction,
  CriticDecision,
} from './control-plane-state.js';

export interface StateMachineTransitionResult {
  allowed: boolean;
  fromStatus: LifecycleStatus;
  toStatus: LifecycleStatus;
  reason: string;
  nextRecommendedAction?: ControlAction;
}

export class ControlPlaneStateMachine {
  /**
   * Deterministically decides the next legal state transition in EDCP.
   */
  static transition(
    currentState: ControlPlaneState,
    requestedStatus: LifecycleStatus,
    criticDecision?: CriticDecision,
  ): StateMachineTransitionResult {
    const current = currentState.lifecycle.status;

    // Terminal states cannot transition
    if (current === 'COMPLETED' || current === 'BLOCKED' || current === 'FAILED') {
      return {
        allowed: false,
        fromStatus: current,
        toStatus: current,
        reason: `Cannot transition from terminal state '${current}'.`,
      };
    }

    // Direct transition to COMPLETED requires completion authorization from critic
    if (requestedStatus === 'COMPLETED') {
      if (!criticDecision || !criticDecision.approved || criticDecision.verdict !== 'ACCEPT_CANDIDATE') {
        return {
          allowed: false,
          fromStatus: current,
          toStatus: 'COMPLETION_CHECK',
          reason: 'Transition to COMPLETED blocked: Critic did not authorize acceptance.',
          nextRecommendedAction: {
            type: 'VERIFY',
            reason: 'Satisfy remaining contract checks before completing.',
          },
        };
      }

      return {
        allowed: true,
        fromStatus: current,
        toStatus: 'COMPLETED',
        reason: 'Task verified and authorized for completion by Critic.',
      };
    }

    // Valid state machine transitions
    return {
      allowed: true,
      fromStatus: current,
      toStatus: requestedStatus,
      reason: `Transitioned from ${current} to ${requestedStatus}.`,
    };
  }
}
