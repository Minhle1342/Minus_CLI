import type { PromptAssemblyContext } from './prompt-sections.js';
import {
  canonicalizePromptText,
  computeStablePrefixHash,
  createPromptCacheEnvelope,
  hashPromptText,
  TIER_ORDER,
  type PromptCacheEnvelope,
  type PromptCacheSection,
  type PromptCacheTier,
} from './cache-envelope.js';

export interface PromptSection {
  id: string;
  content: string;
  priority?: number;
  condition?: (ctx: PromptAssemblyContext) => boolean;
  /** Explicit tier assignment. If omitted, resolved deterministically from priority. */
  tier?: PromptCacheTier;
}

export interface PromptEnvelopeOptions {
  provider: string;
  model: string;
  toolSchemaVersion?: string;
  repositoryRevision?: string;
  policyVersion?: string;
}

/** One included section's identity for churn attribution (no content copied). */
export interface AssembledPromptSectionDigest {
  id: string;
  tier: PromptCacheTier;
  contentHash: string;
}

export interface AssembledPromptEnvelope {
  /** Byte-identical to `assembleForContext(ctx)`; asserted before returning. */
  prompt: string;
  envelope: PromptCacheEnvelope;
  /** Hash of T0..T2 only; T3 is the intentionally dynamic tail. */
  stablePrefixHash: string;
  sections: AssembledPromptSectionDigest[];
}

interface IncludedPromptSection {
  id: string;
  tier: PromptCacheTier;
  content: string;
}

interface RegisteredPromptSection extends PromptSection {
  order: number;
  tier: PromptCacheTier;
}

/**
 * Resolves the cache tier for a prompt section:
 * - T0 (Priority < 0): Strict Static Invariants & System Core (never changes).
 * - T1 (0 <= Priority < 500): Repository Static Rules, Environment Invariants, Tool Declarations.
 * - T2 (500 <= Priority < 1000): Session-Stable Directives, Playbooks, Mode Boundaries.
 * - T3 (Priority >= 1000): Dynamic Context & Ephemeral Step Tail.
 */
export function resolveSectionTier(section: PromptSection): PromptCacheTier {
  const p = section.priority ?? 0;
  return section.tier ?? (p < 0 ? 'T0' : p < 500 ? 'T1' : p < 1000 ? 'T2' : 'T3');
}

/**
 * Deterministic, plugin-extensible system prompt composition with Static-First Prefix Alignment.
 * Enforces strict KV-Cache Prefix Invariance across turns and steps.
 */
export class PromptAssembler {
  private sections = new Map<string, RegisteredPromptSection>();
  private nextOrder = 0;

  constructor(basePrompt = '') {
    if (basePrompt) this.register({ id: 'core', content: basePrompt, priority: -1000, tier: 'T0' });
  }

  register(section: PromptSection): () => void {
    if (!section.id.trim()) throw new Error('Prompt section id must not be empty.');
    if (!section.content.trim()) throw new Error(`Prompt section "${section.id}" must not be empty.`);
    if (this.sections.has(section.id)) {
      throw new Error(`Prompt section "${section.id}" is already registered.`);
    }

    this.sections.set(section.id, {
      ...section,
      tier: resolveSectionTier(section),
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
    return this.collectIncludedSections(ctx)
      .map((section) => section.content)
      .join('\n\n');
  }

  /**
   * P2: assemble the prompt AND its cache envelope from the same section list.
   *
   * The prompt string is byte-identical to `assembleForContext` (asserted below),
   * so switching a caller to this method cannot change prompt semantics. The
   * envelope adds two things the raw string cannot provide:
   *   1. `stablePrefixHash` — T0..T2 only, so a T3-only change is not mistaken for
   *      a prompt-cache break;
   *   2. per-section hashes — churn can be attributed to a specific section id
   *      instead of "the system prompt changed".
   */
  assembleWithEnvelope(
    ctx: PromptAssemblyContext = {},
    options: PromptEnvelopeOptions,
  ): AssembledPromptEnvelope {
    const included = this.collectIncludedSections(ctx);
    const prompt = included.map((section) => section.content).join('\n\n');
    const envelopeSections: PromptCacheSection[] = included.map((section, index) => ({
      id: section.id,
      tier: section.tier,
      content: section.content,
      // `order` = position in the assembler's canonical ordering, so the envelope
      // sorts back to exactly the same sequence the prompt uses.
      order: index,
    }));
    const envelope = createPromptCacheEnvelope(envelopeSections, options);
    if (envelope.canonicalPrompt !== prompt) {
      throw new Error(
        'Prompt envelope drift: canonicalPrompt differs from the assembled system prompt. '
        + 'A section tier/priority change broke the static-first prefix invariant.',
      );
    }
    return {
      prompt,
      envelope,
      stablePrefixHash: computeStablePrefixHash(envelope.tiers),
      sections: included.map((section) => ({
        id: section.id,
        tier: section.tier,
        contentHash: hashPromptText(section.content),
      })),
    };
  }

  private collectIncludedSections(ctx: PromptAssemblyContext = {}): IncludedPromptSection[] {
    return this.sortedSections()
      .filter((section) => !section.condition || section.condition(ctx))
      .map((section) => ({
        id: section.id,
        tier: section.tier,
        content: canonicalizePromptText(section.content),
      }))
      .filter((section) => Boolean(section.content));
  }

  private sortedSections(): RegisteredPromptSection[] {
    return Array.from(this.sections.values()).sort((a, b) =>
      (TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)) ||
      ((a.priority ?? 0) - (b.priority ?? 0)) ||
      (a.order - b.order) ||
      a.id.localeCompare(b.id)
    );
  }
}
