import type { PromptAssemblyContext } from './prompt-sections.js';
import {
  canonicalizePromptText,
  TIER_ORDER,
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
    return this.sortedSections()
      .filter((section) => !section.condition || section.condition(ctx))
      .map((section) => canonicalizePromptText(section.content))
      .filter(Boolean)
      .join('\n\n');
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
