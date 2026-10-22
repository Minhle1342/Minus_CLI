/**
 * Harness2 Bridge & Recursive Harnessing Engine for MinusCLI
 * 
 * Implements Google Research Harness² (arXiv:2610.14224):
 * "Harness²: Recursive Agent Harnessing for an Open World"
 * 
 * Provides:
 * 1. Standardized 8-Component Agent Harness representation:
 *    - System Prompt, Guardrails, Memory, Tool Guidance, Subagents, Skills, Scripts, Plugins
 * 2. Task-Level Recursion:
 *    - Propose (Invariant & Domain variants)
 *    - Probe (Evaluating candidate configurations)
 *    - Compose (Contrastive synthesis without ground-truth labels)
 * 3. Harnessing-Level Recursion:
 *    - Experience Reflection & Accumulation across tasks
 */

import { CognitiveScaffold } from './cognitive-harness.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 8 Editable Components defined in Harness² */
export interface Harness2Bundle {
  systemPrompt: string;
  guardrails: string[];
  memory: string;
  toolGuidance: Record<string, string>;
  subagents: Record<string, { role: string; instructions: string; model?: string }>;
  skills: string[];
  scripts: Record<string, string>;
  plugins: Record<string, unknown>;
}

export interface HarnessCandidate {
  id: string;
  kind: 'base' | 'invariant' | 'domain' | 'composed';
  description: string;
  scaffold: CognitiveScaffold;
  toolGuidanceDelta?: Record<string, string>;
  additionalNegativeGates?: string[];
}

export interface ProbeEvaluation {
  candidateId: string;
  toolCallCount: number;
  unproductiveLoopsDetected: number;
  testsPassed: boolean;
  score: number;
  contrastNotes: string[];
}

export interface HarnessReflectionRecord {
  taskId: string;
  taskBrief: string;
  adoptedHarnessId: string;
  outcome: 'ok' | 'partial' | 'failed';
  lessonsLearned: string[];
  suggestedGuardrails: string[];
  timestamp: string;
}

export class Harness2RecursiveEngine {
  private persistentLibrary: HarnessReflectionRecord[] = [];

  constructor(initialLibrary: HarnessReflectionRecord[] = []) {
    this.persistentLibrary = [...initialLibrary];
  }

  /**
   * TASK-LEVEL RECURSION (Step 1): Propose candidate harness edits.
   * Generates invariant (broad discipline) and domain-specific (context-targeted) candidates.
   */
  proposeCandidates(baseScaffold: CognitiveScaffold, taskBrief: string): HarnessCandidate[] {
    const candidates: HarnessCandidate[] = [];

    // 1. Base Candidate
    candidates.push({
      id: 'base',
      kind: 'base',
      description: 'Default baseline scaffold',
      scaffold: { ...baseScaffold },
    });

    // 2. Invariant Candidate (inv1): Enforces strict verification discipline and zero-mock invariant
    const invGates = [
      ...baseScaffold.negativeGate,
      'NEVER modify existing test assertions merely to make a build pass without explicit authorization',
      'ALWAYS inspect caller references before changing function signatures',
    ];
    candidates.push({
      id: 'inv1',
      kind: 'invariant',
      description: 'Strict verification and zero-mock invariant',
      scaffold: {
        ...baseScaffold,
        negativeGate: invGates,
      },
      toolGuidanceDelta: {
        run_command: 'Run build and test verification commands immediately after each surgical edit',
      },
    });

    // 3. Domain Candidate (dom1): Injects domain-specific constraints from task keywords
    const isTypeScript = /ts|typescript|types/i.test(taskBrief);
    const isBug = /fix|bug|error|null|fail/i.test(taskBrief);

    const domGates = [...baseScaffold.negativeGate];
    if (isTypeScript) {
      domGates.push('Preserve exact TypeScript typing signatures; never use "any" as a quick escape');
    }
    if (isBug) {
      domGates.push('First reproduce the defect with a minimal regression assertion before editing fix targets');
    }

    candidates.push({
      id: 'dom1',
      kind: 'domain',
      description: `Targeted domain specialization (${isTypeScript ? 'TypeScript' : 'General'} + ${isBug ? 'Defect' : 'Feature'})`,
      scaffold: {
        ...baseScaffold,
        negativeGate: domGates,
      },
    });

    return candidates;
  }

  /**
   * TASK-LEVEL RECURSION (Step 2 & 3): Compose refined harness from probe contrasts.
   * Synthesizes winning elements into a single robust composed harness ('agg1').
   */
  composeHarness(
    baseScaffold: CognitiveScaffold,
    candidates: HarnessCandidate[],
    probeEvaluations: ProbeEvaluation[]
  ): { composedScaffold: CognitiveScaffold; selectedCandidateId: string } {
    if (!probeEvaluations || probeEvaluations.length === 0) {
      return { composedScaffold: baseScaffold, selectedCandidateId: 'base' };
    }

    // Rank candidates by probe score
    const sorted = [...probeEvaluations].sort((a, b) => b.score - a.score);
    const winner = sorted[0];
    const winningCandidate = candidates.find(c => c.id === winner.candidateId) || candidates[0];

    // Contrastive composition: merge all effective negative gates from top performers
    const consolidatedGates = new Set<string>(winningCandidate.scaffold.negativeGate);

    for (const probe of sorted) {
      if (probe.score > 0) {
        const c = candidates.find(cand => cand.id === probe.candidateId);
        if (c?.additionalNegativeGates) {
          for (const g of c.additionalNegativeGates) {
            consolidatedGates.add(g);
          }
        }
      }
    }

    const composedScaffold: CognitiveScaffold = {
      ...winningCandidate.scaffold,
      negativeGate: Array.from(consolidatedGates),
      executionTopology: [
        'Harness² Pre-flight: Propose-Probe-Compose validated',
        ...winningCandidate.scaffold.executionTopology,
      ],
    };

    return {
      composedScaffold,
      selectedCandidateId: winningCandidate.id,
    };
  }

  /**
   * HARNESSING-LEVEL RECURSION: Reflects on completed session and updates persistent playbook.
   */
  reflectAndAccumulate(record: HarnessReflectionRecord): void {
    this.persistentLibrary.push(record);
  }

  getLibrary(): readonly HarnessReflectionRecord[] {
    return this.persistentLibrary;
  }

  /**
   * Exports an 8-component bundle to disk matching Harness² directory layout.
   */
  async exportBundleToDirectory(bundle: Harness2Bundle, outDir: string): Promise<void> {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'systemprompt.md'), bundle.systemPrompt, 'utf-8');
    await fs.writeFile(path.join(outDir, 'guardrails.md'), bundle.guardrails.join('\n- '), 'utf-8');
    await fs.writeFile(path.join(outDir, 'LongTermMEMORY.md'), bundle.memory, 'utf-8');
    
    // Tools
    const toolsDir = path.join(outDir, 'tool_descriptions');
    await fs.mkdir(toolsDir, { recursive: true });
    for (const [name, desc] of Object.entries(bundle.toolGuidance)) {
      await fs.writeFile(path.join(toolsDir, `${name}.md`), desc, 'utf-8');
    }

    // Subagents
    const subagentsDir = path.join(outDir, 'sub_agents');
    await fs.mkdir(subagentsDir, { recursive: true });
    for (const [agentName, conf] of Object.entries(bundle.subagents)) {
      await fs.writeFile(path.join(subagentsDir, `${agentName}.json`), JSON.stringify(conf, null, 2), 'utf-8');
    }

    // Skills
    const skillsDir = path.join(outDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    for (const skill of bundle.skills) {
      await fs.writeFile(path.join(skillsDir, `${skill}.md`), `# Skill: ${skill}\n`, 'utf-8');
    }
  }
}
