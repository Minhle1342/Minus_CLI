import { createHash } from 'node:crypto';

export type PromptCacheTier = 'T0' | 'T1' | 'T2' | 'T3';

export interface PromptCacheSection {
  id: string;
  tier: PromptCacheTier;
  content: string;
  order?: number;
}

export interface PromptCacheEnvelopeOptions {
  provider: string;
  model: string;
  toolSchemaVersion?: string;
  repositoryRevision?: string;
  policyVersion?: string;
}

export interface PromptCacheEnvelope {
  version: 2;
  cacheKey: string;
  canonicalPrompt: string;
  tiers: Array<{
    tier: PromptCacheTier;
    content: string;
    contentHash: string;
    cumulativePrefixHash: string;
  }>;
  metadata: Required<PromptCacheEnvelopeOptions>;
}

const TIER_ORDER: PromptCacheTier[] = ['T0', 'T1', 'T2', 'T3'];

/** Canonical, content-addressed prompt envelope. T3 remains the dynamic uncached tail. */
export function createPromptCacheEnvelope(
  sections: PromptCacheSection[],
  options: PromptCacheEnvelopeOptions,
): PromptCacheEnvelope {
  const metadata: Required<PromptCacheEnvelopeOptions> = {
    provider: options.provider.trim().toLowerCase(),
    model: options.model.trim(),
    toolSchemaVersion: options.toolSchemaVersion || 'unknown',
    repositoryRevision: options.repositoryRevision || 'unknown',
    policyVersion: options.policyVersion || 'prompt-cache-v2',
  };
  const ordered = [...sections]
    .filter((section) => section.id.trim() && section.content.trim())
    .sort((left, right) => TIER_ORDER.indexOf(left.tier) - TIER_ORDER.indexOf(right.tier)
      || (left.order ?? 0) - (right.order ?? 0)
      || left.id.localeCompare(right.id));
  const tiers: PromptCacheEnvelope['tiers'] = [];
  let cumulative = '';
  for (const tier of TIER_ORDER) {
    const content = ordered
      .filter((section) => section.tier === tier)
      .map((section) => canonicalizePromptText(section.content))
      .join('\n\n');
    if (!content) continue;
    cumulative = cumulative ? `${cumulative}\n\n${content}` : content;
    tiers.push({
      tier,
      content,
      contentHash: sha256(content),
      cumulativePrefixHash: sha256(cumulative),
    });
  }
  const canonicalPrompt = tiers.map((tier) => tier.content).join('\n\n');
  const identity = canonicalJson({ metadata, stablePrefixHash: stablePrefixHash(tiers) });
  return {
    version: 2,
    cacheKey: `pc2_${sha256(identity).slice(0, 48)}`,
    canonicalPrompt,
    tiers,
    metadata,
  };
}

export function createPromptCacheKey(
  prompt: string,
  options: PromptCacheEnvelopeOptions,
): string {
  return createPromptCacheEnvelope([{ id: 'stable-prefix', tier: 'T1', content: prompt }], options).cacheKey;
}

export function canonicalizePromptText(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').trim();
}

function stablePrefixHash(tiers: PromptCacheEnvelope['tiers']): string {
  const stable = tiers.filter((tier) => tier.tier !== 'T3');
  return stable.at(-1)?.cumulativePrefixHash || sha256('');
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
