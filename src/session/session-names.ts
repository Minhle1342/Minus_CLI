import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SessionPersistence } from './session-persistence.js';

export interface SessionName { id: string; name: string; summary: string; createdAt: string }
export function shortSessionName(request: string): string {
  const text = request.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  const first = text.split(/(?<=[.!?])\s/)[0] || text;
  const chars = Array.from(first);
  return chars.length <= 64 ? first : chars.slice(0, 61).join('').replace(/\s+\S*$/, '') + '…';
}

/** Session labels are UI metadata; the event log remains the source of conversation history. */
export class SessionNames {
  constructor(private readonly persistence: SessionPersistence) {}
  private file(id: string): string { return this.persistence.getSessionPath(id) + '.meta.json'; }
  async get(id: string): Promise<SessionName | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      return value.id === id && typeof value.name === 'string' && value.name.trim() ? value : undefined;
    } catch { return undefined; }
  }
  async ensure(id: string, request: string, createdAt: string): Promise<{ entry: SessionName; created: boolean }> {
    const existing = await this.get(id);
    if (existing) return { entry: existing, created: false };
    const entry = { id, name: shortSessionName(request) || id, summary: request.replace(/\s+/g, ' ').trim().slice(0, 240), createdAt };
    await fs.mkdir(path.dirname(this.file(id)), { recursive: true });
    try { await fs.writeFile(this.file(id), JSON.stringify(entry), { encoding: 'utf8', flag: 'wx' }); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; return { entry: await this.get(id) || entry, created: false }; }
    return { entry, created: true };
  }
  async update(entry: SessionName): Promise<void> {
    const file = this.file(entry.id);
    const temporary = file + `.tmp-${process.pid}-${Date.now()}`;
    try { await fs.writeFile(temporary, JSON.stringify(entry), 'utf8'); await fs.rename(temporary, file); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async list(): Promise<SessionName[]> {
    const ids = await this.persistence.list();
    const entries: SessionName[] = [];
    // Read labels first; legacy sessions need only their first human message.
    for (const id of ids.reverse()) {
      let entry = await this.get(id);
      if (!entry) {
        const stream = createReadStream(this.persistence.getSessionPath(id), { encoding: 'utf8' });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        let createdAt = '';
        try {
          for await (const line of lines) {
            let event: any;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.kind === 'session') { createdAt = event.createdAt || ''; continue; }
            if (event.type !== 'user/message' || event.data?.source === 'system') continue;
            const request = (event.data?.content?.parts || []).map((part: any) => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
            if (request.trim()) { entry = (await this.ensure(id, request, createdAt || event.createdAt)).entry; break; }
          }
        } catch { /* A missing or incomplete file must not block the session picker. */ }
        finally { lines.close(); stream.destroy(); }
      }
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
