/**
 * System Prompt & Modular Prompt Architecture.
 *
 * Implements the 4 Token Optimization Strategies:
 * 1. Lean Core Invariant System Prompt (~280 tokens) at priority -1000.
 * 2. Context-Aware Progressive Disclosure (Unity, Computer Use, Architecture, Frontend loaded on-demand).
 * 3. Deduplication & High-Density Phrasing (shared macros in ./sections/shared.ts).
 * 4. Deterministic Prefix Invariance for optimal KV-Cache hit rate (>85%).
 *
 * Section content lives in ./sections/*; this module is the composition root
 * (standard system prompt + subagent specialization).
 */

import {
  CORE_SYSTEM_PROMPT,
  SECTION_PATCH_FORMAT_SPEC,
  resolvePatchFormatSpec,
  SECTION_GIT_OPERATIONS,
  SECTION_FRONTEND_UI,
  SECTION_ANTIGRAVITY_TOOLS,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_TOOL_PLAYBOOKS,
  SECTION_COMPUTER_USE,
  SECTION_UNITY_GAME_DEV,
  SECTION_ARCHITECTURE_ANALYSIS,
  SECTION_TASK_ORCHESTRATOR_BOUNDARIES,
  SECTION_SEMANTIC_BLAST_RADIUS_FULL,
  SECTION_TERMINAL_SANDBOX_FULL,
  SECTION_ANTIGRAVITY_TOOLCHAIN_FULL,
  SECTION_CODEBASE_INTELLIGENCE_FULL,
  SECTION_COMPUTER_USE_FULL,
  SECTION_ERROR_DETECTIVE_PROTOCOL,
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  type PromptAssemblyContext,
  GIT_WORKFLOW_PROMPTS,
  type GitWorkflowPromptId,
  SECTION_PHASE_EXPLORE_GUIDANCE,
  SECTION_PHASE_EXPLORE_READONLY_GUIDANCE,
  SECTION_PHASE_PLAN_GUIDANCE,
  SECTION_PHASE_IMPLEMENT_GUIDANCE,
  SECTION_PHASE_VERIFY_GUIDANCE,
  SECTION_PHASE_RELEASE_GUIDANCE,
  resolvePhaseDynamicGuidance,
  buildPhaseToolAuthorityDirective,
  type PhaseGuidanceOptions,
  SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
  type MonorepoKind,
  clearPromptContextCache,
  needsFrontendGuidance,
  needsCodebaseIntelligenceGuidance,
  needsSubagentOrchestratorGuidance,
} from './prompt-sections.js';
import { PromptAssembler } from './prompt-assembler.js';

export {
  CORE_SYSTEM_PROMPT,
  SECTION_PATCH_FORMAT_SPEC,
  resolvePatchFormatSpec,
  SECTION_GIT_OPERATIONS,
  SECTION_FRONTEND_UI,
  SECTION_ANTIGRAVITY_TOOLS,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_TOOL_PLAYBOOKS,
  GIT_WORKFLOW_PROMPTS,
  type GitWorkflowPromptId,
  SECTION_COMPUTER_USE,
  SECTION_UNITY_GAME_DEV,
  SECTION_ARCHITECTURE_ANALYSIS,
  SECTION_TASK_ORCHESTRATOR_BOUNDARIES,
  SECTION_SEMANTIC_BLAST_RADIUS_FULL,
  SECTION_TERMINAL_SANDBOX_FULL,
  SECTION_ANTIGRAVITY_TOOLCHAIN_FULL,
  SECTION_CODEBASE_INTELLIGENCE_FULL,
  SECTION_COMPUTER_USE_FULL,
  SECTION_ERROR_DETECTIVE_PROTOCOL,
  DEFAULT_PROMPT_SECTIONS,
  detectPromptContext,
  type PromptAssemblyContext,
  type MonorepoKind,
  clearPromptContextCache,
  needsFrontendGuidance,
  needsCodebaseIntelligenceGuidance,
  needsSubagentOrchestratorGuidance,
  PromptAssembler,
  SECTION_PHASE_EXPLORE_GUIDANCE,
  SECTION_PHASE_EXPLORE_READONLY_GUIDANCE,
  SECTION_PHASE_PLAN_GUIDANCE,
  SECTION_PHASE_IMPLEMENT_GUIDANCE,
  SECTION_PHASE_VERIFY_GUIDANCE,
  SECTION_PHASE_RELEASE_GUIDANCE,
  resolvePhaseDynamicGuidance,
  buildPhaseToolAuthorityDirective,
  type PhaseGuidanceOptions,
  SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
};

/**
 * Build a lean unified system prompt with all default sections for the context.
 * This is the single default system prompt: providers fall back to it when the
 * caller passes no explicit system prompt (the agent loop always passes one).
 */
export function buildModelIdentitySection(provider: string, modelId: string, displayName?: string): { id: string; content: string; priority: number } {
  const name = (displayName || modelId).trim() || 'unknown model';
  return { id: 'model-identity', content: `You are powered by ${name} (${provider.trim()}/${modelId.trim()}).`, priority: 0 };
}

export function createStandardSystemPrompt(ctx?: PromptAssemblyContext, modelInfo?: { provider: string; modelId: string; displayName?: string }): string {
  const assembler = new PromptAssembler();
  if (modelInfo?.modelId) assembler.register(buildModelIdentitySection(modelInfo.provider, modelInfo.modelId, modelInfo.displayName));
  for (const s of DEFAULT_PROMPT_SECTIONS) {
    assembler.register(s);
  }
  return assembler.assembleForContext(ctx || {});
}

export interface SubagentPromptResolutionOptions {
  capabilities?: string[];
  toolNames?: string[];
  brief?: string;
}

/**
 * Auto-resolve specialized prompt sections for subagents by role and capabilities.
 * Assembles core plus only the role-specific modules a subagent needs.
 */
export function resolveSubagentPromptSections(options: SubagentPromptResolutionOptions = {}): Array<{ id: string; content: string; priority?: number }> {
  const sections: Array<{ id: string; content: string; priority?: number }> = [
    { id: 'core', content: CORE_SYSTEM_PROMPT, priority: -1000 },
  ];

  const caps = (options.capabilities || []).map((c) => c.toLowerCase());
  const tools = (options.toolNames || []).map((t) => t.toLowerCase());
  const brief = (options.brief || '').toLowerCase();

  // 1. Phân giải công cụ Git
  if (tools.some((t) => t.startsWith('git_') || t === 'run_command')) {
    sections.push({ id: 'git-operations', content: SECTION_GIT_OPERATIONS, priority: 100 });
  }

  // 2. Chuyên gia Lập trình / Refactor / Sửa mã (Code Writer / Refactoring Specialist)
  const isCoder = caps.some((c) => c.includes('code') || c.includes('refactor') || c.includes('humaneval') || c.includes('fim'))
    || tools.some((t) => ['replace_text', 'write_file'].includes(t));
  if (isCoder) {
    sections.push({ id: 'patch-format-spec', content: SECTION_PATCH_FORMAT_SPEC, priority: 150 });
    sections.push({ id: 'semantic-blast-radius', content: SECTION_SEMANTIC_BLAST_RADIUS_FULL, priority: 200 });
  }

  // 3. Chuyên gia Gỡ lỗi / Root Cause / Verification (Debugger / SWE-bench)
  const isDebugger = caps.some((c) => c.includes('debug') || c.includes('swe-bench') || c.includes('test'))
    || /\bdebug\b/.test(brief) || /\bfix\b/.test(brief);
  if (isDebugger) {
    sections.push({ id: 'error-detective', content: SECTION_ERROR_DETECTIVE_PROTOCOL, priority: 250 });
  }

  // 4. Chuyên gia Nghiên cứu / Kiến trúc / Toán học (Deep Researcher / Reasoning Specialist)
  const isArchitectOrResearcher = caps.some((c) => c.includes('math') || c.includes('reasoning') || c.includes('research') || c.includes('architecture'))
    || tools.some((t) => ['search_text', 'read_file', 'list_files'].includes(t));
  if (isArchitectOrResearcher) {
    sections.push({ id: 'codebase-intelligence', content: SECTION_CODEBASE_INTELLIGENCE_FULL, priority: 300 });
  }

  // 5. Chuyên gia Terminal / Lệnh nền / DevOps
  const isTerminalOrDevOps = tools.some((t) => t === 'run_command');
  if (isTerminalOrDevOps) {
    sections.push({ id: 'terminal-sandbox', content: SECTION_TERMINAL_SANDBOX_FULL, priority: 350 });
    sections.push({ id: 'antigravity-tools', content: SECTION_ANTIGRAVITY_TOOLCHAIN_FULL, priority: 400 });
  }

  // 6. Chuyên gia GUI Desktop
  if (tools.includes('computer')) {
    sections.push({ id: 'computer-use', content: SECTION_COMPUTER_USE_FULL, priority: 500 });
  }

  return sections;
}
