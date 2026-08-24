export interface AgentMemoryClientOptions {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AgentMemoryRememberInput {
  id: string;
  project: string;
  content: string;
  concepts: string[];
  files: string[];
  sourceObservationIds: string[];
  type: string;
}

/** Optional AgentMemory bridge. All failures are deliberately fail-open. */
export class AgentMemoryClient {
  private readonly baseUrl?: string;
  private readonly secret?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private healthCache?: { value: boolean; expiresAt: number };

  constructor(options: AgentMemoryClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.AGENTMEMORY_URL || '').replace(/\/$/, '') || undefined;
    this.secret = options.secret || process.env.AGENTMEMORY_SECRET;
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  async health(): Promise<boolean> {
    if (!this.baseUrl) return false;
    if (this.healthCache && this.healthCache.expiresAt > Date.now()) return this.healthCache.value;
    try {
      const response = await this.request('/agentmemory/health', { method: 'GET' });
      this.healthCache = { value: response.ok, expiresAt: Date.now() + 30_000 };
      return response.ok;
    } catch {
      this.healthCache = { value: false, expiresAt: Date.now() + 10_000 };
      return false;
    }
  }

  async remember(input: AgentMemoryRememberInput): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const response = await this.request('/agentmemory/remember', {
        method: 'POST',
        body: JSON.stringify({
          project: input.project,
          content: `[minus-repository-memory:${input.id}] ${input.content}`,
          concepts: input.concepts,
          files: input.files,
          sourceObservationIds: input.sourceObservationIds,
          type: input.type,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async smartSearch(query: string, limit = 20): Promise<{ ids: string[]; available: boolean }> {
    if (!this.baseUrl) return { ids: [], available: false };
    try {
      const response = await this.request('/agentmemory/smart-search', {
        method: 'POST',
        body: JSON.stringify({ query, limit }),
      });
      if (!response.ok) return { ids: [], available: false };
      const payload: any = await response.json();
      const candidates = Array.isArray(payload) ? payload
        : Array.isArray(payload?.results) ? payload.results
          : Array.isArray(payload?.memories) ? payload.memories
            : Array.isArray(payload?.data) ? payload.data : [];
      const ids: string[] = [];
      for (const candidate of candidates) {
        const match = JSON.stringify(candidate).match(/\[minus-repository-memory:([^\]]+)\]/);
        if (match?.[1] && !ids.includes(match[1])) ids.push(match[1]);
      }
      return { ids, available: true };
    } catch {
      return { ids: [], available: false };
    }
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.secret) headers.authorization = `Bearer ${this.secret}`;
      return await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
