import type { Content } from '@google/genai';
import { createHash } from 'node:crypto';

/** Only observations with an explicit, successful replacement can be unpinned. */
export function selectReplacedObservationIds(history: Content[]): string[] {
  const calls = new Map<string, { name?: string; args?: Record<string, any> }>();
  const latest = new Map<string, string>();
  const replaced: string[] = [];
  for (const message of history) {
    for (const part of message.parts || []) {
      const call = part.functionCall;
      if (call?.id) calls.set(call.id, call);
      const response = part.functionResponse;
      const payload = response?.response as Record<string, any> | undefined;
      if (!response?.id || !payload || payload.success === false
        || (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
        || payload.status === 'masked' || payload.status === 'superseded') continue;
      let key: string | undefined;
      // Identical snapshots only: a changed snapshot may still be needed as
      // before/after evidence. Hashing avoids retaining duplicate large strings.
      const path = payload.path || payload.filePath || calls.get(response.id)?.args?.path;
      if (['read_file', 'view_file', 'read_compressed_code'].includes(response.name || '')
        && typeof payload.content === 'string' && typeof path === 'string') {
        key = `file:${response.name}:${path}:${createHash('sha256').update(JSON.stringify({
          payload, args: calls.get(response.id)?.args,
        })).digest('hex')}`;
      } else if (response.name === 'run_command' && payload.exitCode === 0) {
        const command = payload.command || calls.get(response.id)?.args?.command;
        if (typeof command === 'string' && command.trim()) key = `command:${command.trim()}:${createHash('sha256')
          .update(JSON.stringify({ payload, args: calls.get(response.id)?.args })).digest('hex')}`;
      }
      if (!key) continue;
      const previous = latest.get(key);
      if (previous && previous !== response.id) replaced.push(previous);
      latest.set(key, response.id);
    }
  }
  return Array.from(new Set(replaced));
}
