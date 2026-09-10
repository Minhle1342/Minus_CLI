import type { PromptAssemblyContext } from './prompt-sections.js';
import { createPromptCacheKey } from './cache-envelope.js';

export interface PromptSection {
  id: string;
  content: string;
  priority?: number;
  condition?: (ctx: PromptAssemblyContext) => boolean;
}

interface RegisteredPromptSection extends PromptSection {
  order: number;
}

/** Deterministic, plugin-extensible system prompt composition with progressive context awareness. */
export class PromptAssembler {
  private sections = new Map<string, RegisteredPromptSection>();
  private nextOrder = 0;

  constructor(basePrompt = '') {
    if (basePrompt) {
      this.register({ id: 'core', content: basePrompt, priority: -1000 });
    }
  }

  register(section: PromptSection): () => void {
    if (!section.id.trim()) throw new Error('Prompt section id must not be empty.');
    if (!section.content.trim()) throw new Error(`Prompt section "${section.id}" must not be empty.`);
    if (this.sections.has(section.id)) {
      throw new Error(`Prompt section "${section.id}" is already registered.`);
    }

    this.sections.set(section.id, { ...section, order: this.nextOrder++ });
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
   * Preserves deterministic sorting: Priority ascending (-1000 Core first), then order.
   */
  assembleForContext(ctx: PromptAssemblyContext = {}): string {
    return this.sortedSections()
      .filter((section) => !section.condition || section.condition(ctx))
      .map((section) => section.content.trim())
      .join('\n\n');
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
    return Array.from(this.sections.values()).sort(
      (a, b) => (a.priority || 0) - (b.priority || 0) || a.order - b.order,
    );
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

