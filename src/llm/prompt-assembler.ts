import type { PromptAssemblyContext } from './prompt-sections.js';
import {
  createPromptCacheKey,
  createPromptCacheEnvelope,
  type PromptCacheEnvelope,
  type PromptCacheEnvelopeOptions,
  type PromptCacheSection,
  type PromptCacheTier,
  canonicalizePromptText,
} from './cache-envelope.js';

export interface PromptSection {
  id: string;
  content: string;
  priority?: number;
  condition?: (ctx: PromptAssemblyContext) => boolean;
  /** Explicit tier assignment. If omitted, resolved deterministically from priority. */
  tier?: PromptCacheTier;
}

interface RegisteredPromptSection extends PromptSection {
  order: number;
}

export interface TieredAssembledPrompt {
  t0Core: string;
  t1RepoRules: string;
  t2SessionDirectives: string;
  t3DynamicTail: string;
  /** Prefix consisting of T0 + T1 + T2 - guaranteed stable across dynamic step changes. */
  stablePrefix: string;
  /** Full prompt concatenated in static-first tier order. */
  fullPrompt: string;
  /** Unique cache signature for the prompt. */
  cacheSignature: string;
  /** Number of active sections included in this assembly. */
  sectionCount: number;
}

const TIER_ORDER: PromptCacheTier[] = ['T0', 'T1', 'T2', 'T3'];

/**
 * Resolves the cache tier for a prompt section:
 * - T0 (Priority < 0): Strict Static Invariants & System Core (never changes).
 * - T1 (0 <= Priority < 500): Repository Static Rules, Environment Invariants, Tool Declarations.
 * - T2 (500 <= Priority < 1000): Session-Stable Directives, Playbooks, Mode Boundaries.
 * - T3 (Priority >= 1000): Dynamic Context & Ephemeral Step Tail.
 */
export function resolveSectionTier(section: PromptSection): PromptCacheTier {
  if (section.tier) return section.tier;
  const p = section.priority ?? 0;
  if (p < 0) return 'T0';
  if (p < 500) return 'T1';
  if (p < 1000) return 'T2';
  return 'T3';
}

/**
 * Deterministic, plugin-extensible system prompt composition with Static-First Prefix Alignment.
 * Enforces strict KV-Cache Prefix Invariance across turns and steps.
 */
export class PromptAssembler {
  private sections = new Map<string, RegisteredPromptSection>();
  private nextOrder = 0;

  constructor(basePrompt = '') {
    if (basePrompt) {
      this.register({ id: 'core', content: basePrompt, priority: -1000, tier: 'T0' });
    }
  }

  register(section: PromptSection): () => void {
    if (!section.id.trim()) throw new Error('Prompt section id must not be empty.');
    if (!section.content.trim()) throw new Error(`Prompt section "${section.id}" must not be empty.`);
    if (this.sections.has(section.id)) {
      throw new Error(`Prompt section "${section.id}" is already registered.`);
    }

    this.sections.set(section.id, {
      ...section,
      tier: section.tier || resolveSectionTier(section),
      order: this.nextOrder++,
    });
    return () => this.unregister(section.id);
  }

  unregister(id: string): boolean {
    return this.sections.delete(id);
  }

  list(): string[] {
    return this.sortedSections().map((section) => section.id);
  }

  /**
   * Assembles system prompt with progressive disclosure filtering based on context.
   * Sections without a condition are always included.
   * Preserves deterministic Static-First Prefix Invariance:
   * Tier ascending (T0 -> T1 -> T2 -> T3), then priority ascending, then registration order, then id tie-break.
   * Applies canonical text normalization to prevent whitespace-driven cache misses across platforms.
   */
  assembleForContext(ctx: PromptAssemblyContext = {}): string {
    return this.sortedSections()
      .filter((section) => !section.condition || section.condition(ctx))
      .map((section) => canonicalizePromptText(section.content))
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Assembles the prompt broken down into structured cache tiers (T0, T1, T2, T3)
   * and separates the cacheable stablePrefix from the dynamicTail.
   */
  assembleTiered(ctx: PromptAssemblyContext = {}): TieredAssembledPrompt {
    const active = this.sortedSections().filter((section) => !section.condition || section.condition(ctx));
    const byTier: Record<PromptCacheTier, string[]> = { T0: [], T1: [], T2: [], T3: [] };

    for (const section of active) {
      const tier = resolveSectionTier(section);
      const canonical = canonicalizePromptText(section.content);
      if (canonical) {
        byTier[tier].push(canonical);
      }
    }

    const t0Core = byTier.T0.join('\n\n');
    const t1RepoRules = byTier.T1.join('\n\n');
    const t2SessionDirectives = byTier.T2.join('\n\n');
    const t3DynamicTail = byTier.T3.join('\n\n');

    const stablePrefix = [t0Core, t1RepoRules, t2SessionDirectives].filter(Boolean).join('\n\n');
    const fullPrompt = [stablePrefix, t3DynamicTail].filter(Boolean).join('\n\n');
    const cacheSignature = this.getCacheSignature(ctx);

    return {
      t0Core,
      t1RepoRules,
      t2SessionDirectives,
      t3DynamicTail,
      stablePrefix,
      fullPrompt,
      cacheSignature,
      sectionCount: active.length,
    };
  }

  /**
   * Generates a stable prefix signature guaranteed to remain invariant
   * when dynamic T3 sections are added or mutated.
   */
  getStablePrefixSignature(ctx: PromptAssemblyContext = {}): string {
    const tiered = this.assembleTiered(ctx);
    return createPromptCacheKey(tiered.stablePrefix || tiered.fullPrompt, {
      provider: 'provider-neutral',
      model: 'runtime-selected',
      policyVersion: 'prefix-alignment-v2',
    });
  }

  /**
   * Builds a standardized PromptCacheEnvelope for explicit context caching (e.g. Gemini / Anthropic cache breakpoint).
   */
  createCacheEnvelope(
    options: PromptCacheEnvelopeOptions,
    ctx: PromptAssemblyContext = {},
  ): PromptCacheEnvelope {
    const active = this.sortedSections().filter((section) => !section.condition || section.condition(ctx));
    const promptCacheSections: PromptCacheSection[] = active.map((s) => ({
      id: s.id,
      tier: resolveSectionTier(s),
      content: s.content,
      order: s.order,
    }));
    return createPromptCacheEnvelope(promptCacheSections, options);
  }

  /**
   * Default assemble method for backward compatibility.
   * Evaluates all sections with an empty context (only unconditionally enabled sections or conditions returning true for {}).
   */
  assemble(): string {
    return this.assembleForContext({});
  }

  /**
   * Generates a collision-resistant, content-addressed signature for prompt-caching validation.
   */
  getCacheSignature(ctx: PromptAssemblyContext = {}): string {
    const text = this.assembleForContext(ctx);
    if (process.env.MINUS_CACHE_ENVELOPE_V2 === 'off') return legacyCacheSignature(text);
    return createPromptCacheKey(text, {
      provider: 'provider-neutral',
      model: 'runtime-selected',
      policyVersion: 'prompt-assembler-v2',
    });
  }

  private sortedSections(): RegisteredPromptSection[] {
    return Array.from(this.sections.values()).sort((a, b) => {
      const tierA = resolveSectionTier(a);
      const tierB = resolveSectionTier(b);
      const tierDiff = TIER_ORDER.indexOf(tierA) - TIER_ORDER.indexOf(tierB);
      if (tierDiff !== 0) return tierDiff;
      const priorityDiff = (a.priority || 0) - (b.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      const orderDiff = a.order - b.order;
      if (orderDiff !== 0) return orderDiff;
      return a.id.localeCompare(b.id);
    });
  }
}

function legacyCacheSignature(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return `h_${(hash >>> 0).toString(16)}_${text.length}`;
}
