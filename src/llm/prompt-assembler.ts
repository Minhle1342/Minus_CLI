export interface PromptSection {
  id: string;
  content: string;
  priority?: number;
}

interface RegisteredPromptSection extends PromptSection {
  order: number;
}

/** Deterministic, plugin-extensible system prompt composition. */
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

  assemble(): string {
    return this.sortedSections().map((section) => section.content.trim()).join('\n\n');
  }

  private sortedSections(): RegisteredPromptSection[] {
    return Array.from(this.sections.values()).sort(
      (a, b) => (a.priority || 0) - (b.priority || 0) || a.order - b.order,
    );
  }
}
