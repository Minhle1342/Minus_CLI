/**
 * Minimal Conductor REST client (sidecar).
 * Disabled by default. Enable with MINUS_CONDUCTOR_URL=http://localhost:8080/api
 * No new dependencies: uses global fetch (Node 22+).
 */
import type { ConductorWorkflowDef } from './conductor-workflow.js';

export interface ConductorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export function isConductorEnabled(): boolean {
  return Boolean(process.env.MINUS_CONDUCTOR_URL?.trim());
}

function baseUrl(override?: string): string {
  const url = (override ?? process.env.MINUS_CONDUCTOR_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Conductor disabled: set MINUS_CONDUCTOR_URL to enable.');
  return url;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
  void controller;
}

async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const res = await withTimeout(fetch(`${baseUrl()}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  }), timeoutMs);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Conductor ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}

export async function registerWorkflow(
  def: ConductorWorkflowDef,
  opts: ConductorClientOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  // PUT /metadata/workflow is upsert in Conductor OSS.
  await request<void>('/metadata/workflow', {
    method: 'PUT',
    body: JSON.stringify(def),
  }, timeoutMs);
}

export async function startWorkflow(
  name: string,
  input: Record<string, unknown> = {},
  opts: ConductorClientOptions & { version?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const res = await request<{ workflowId: string }>('/workflow', {
    method: 'POST',
    body: JSON.stringify({ name, version: opts.version ?? 1, input }),
  }, timeoutMs);
  return res.workflowId;
}

export async function getWorkflowStatus(
  workflowId: string,
  opts: ConductorClientOptions = {},
): Promise<{ status: string; raw: unknown }> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const raw = await request<Record<string, unknown>>(
    `/workflow/${encodeURIComponent(workflowId)}`,
    { method: 'GET' },
    timeoutMs,
  );
  return { status: String(raw.status ?? 'UNKNOWN'), raw };
}
