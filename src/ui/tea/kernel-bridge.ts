import type { KernelEventBus, KernelEvents } from '../../kernel/kernel.js';
import type { KernelMsg, Msg } from './types.js';
export const KERNEL_EVENT_NAMES = [
  'kernel:init', 'kernel:disposed', 'plugin:registered', 'step:before', 'step:after',
  'router:decision', 'gate:exploration_sufficiency', 'gate:reproduction_advisory',
  'tool:before', 'tool:after', 'tool:error', 'model:thought', 'model:thinking:start',
  'model:thinking:end', 'model:retry', 'model:token', 'model:usage', 'model:request_telemetry',
  'tools:batch', 'model:final_answer', 'model:steered', 'workspace:changed', 'model:changed',
  'agent:status', 'agent/status', 'agent:abort', 'abort',
] as const satisfies readonly (keyof KernelEvents)[];
type MissingEvents = Exclude<keyof KernelEvents, typeof KERNEL_EVENT_NAMES[number]>;
const completeEventSurface: MissingEvents extends never ? true : never = true;
void completeEventSurface;

export class KernelTEAAdapter {
  constructor(private readonly events: KernelEventBus, private readonly send: (msg: Msg) => void) {}
  bind(): () => void {
    const removers = KERNEL_EVENT_NAMES.map(event => {
      const listener = (...args: Parameters<KernelEvents[typeof event]>) => {
        this.send({ type: 'kernel', event, args } as KernelMsg);
      };
      this.events.on(event, listener);
      return () => this.events.off(event, listener);
    });
    let bound = true;
    return () => { if (bound) { bound = false; for (const remove of removers) remove(); } };
  }
}
