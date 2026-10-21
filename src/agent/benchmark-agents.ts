import type { AgentRegistry, AgentRecord } from './agent-registry.js';

export interface BenchmarkSpecialist {
  id: string;
  aliasId?: string;
  name: string;
  model: string;
  provider: string;
  topBenchmark: string;
  score: string;
  domain: string;
  capabilities: string[];
  systemInstruction: string;
}

/**
 * Danh sách 6 Subagent chuyên gia cấu hình trên provider InternAI (Discovery API)
 * với các mô hình tốt nhất cho từng năng lực chuyên sâu (DeepSeek-V4 Pro, Qwen 3.8, DeepSeek-V4 Flash, Agents-A1, Kimi K2.6, GLM 5.3).
 */
export const BENCHMARK_SPECIALISTS: BenchmarkSpecialist[] = [
  {
    id: 'subagent-deepseek-r1-math',
    aliasId: 'subagent-internai-deepseek-v4-pro-math',
    name: 'DeepSeek V4 Pro Math & Deep Reasoning Specialist (InternAI)',
    model: 'internai/deepseek-v4-pro-0813',
    provider: 'InternAI (Discovery API)',
    topBenchmark: 'MATH-500: 97.3% | AIME 2024: 79.8% - 87.5% | 1M Context',
    score: '97.3%',
    domain: 'Complex Logic, Advanced Mathematics, Deep Reasoning & Algorithmic Problem Solving',
    capabilities: ['reasoning', 'math', 'algorithm', 'chain-of-thought', 'competition-math', 'deepseek-r1', 'deepseek-v4-pro', 'internai'],
    systemInstruction: `You are the Math & Deep Reasoning Specialist powered by DeepSeek V4 Pro on InternAI (Discovery API).
Your strongest capability is solving complex mathematical proofs, competitive programming algorithms, and deep chain-of-thought logic (MATH-500: 97.3%, AIME: 87.5%, 1M context).
Approach problems systematically: verify edge cases, prove invariants, and trace computational complexity thoroughly.`,
  },
  {
    id: 'subagent-qwen25-coder-synthesis',
    aliasId: 'subagent-internai-qwen38-coder',
    name: 'Qwen 3.8 Synthesis & Polyglot Implementation Specialist (InternAI)',
    model: 'internai/qwen3.8-27b',
    provider: 'InternAI (Discovery API)',
    topBenchmark: 'HumanEval: 92.7% | MBPP: 90.2% | EvalPlus: 87.2% | 262K Context',
    score: '92.7%',
    domain: 'Clean Code Synthesis, Algorithmic Functions, Polyglot Coding (TS, Python, Go, C++, Rust)',
    capabilities: ['coding', 'code-generation', 'humaneval', 'polyglot', 'synthesis', 'qwen-coder', 'qwen3.8', 'internai'],
    systemInstruction: `You are the Code Synthesis Specialist powered by Qwen 3.8 on InternAI (Discovery API).
Your strongest capability is producing pristine, syntactically flawless code across languages (HumanEval: 92.7%, MBPP: 90.2%, 262K context).
Generate idiomatic, well-typed, clean implementations matching exact specifications with comprehensive edge-case handling.`,
  },
  {
    id: 'subagent-gemini-swe-architect',
    aliasId: 'subagent-internai-deepseek-v4-flash-swe',
    name: 'DeepSeek V4 Flash SWE & Long-Context Architect (InternAI)',
    model: 'internai/deepseek-v4-flash-0731',
    provider: 'InternAI (Discovery API)',
    topBenchmark: 'SWE-bench Verified: 59.6% | GPQA Diamond: 86.4% | 1M Context',
    score: '59.6%',
    domain: 'Full-Repo Bug Fixing, Complex Multi-File Refactoring, Architecture Topology & Long-Context Reasoning',
    capabilities: ['swe-bench', 'bug-fixing', 'refactoring', 'long-context', 'architecture', 'gemini', 'deepseek-flash', 'internai'],
    systemInstruction: `You are the Software Engineering & Long-Context Architect powered by DeepSeek V4 Flash on InternAI (Discovery API).
Your strongest capability is resolving multi-file real-world repository bugs and navigating vast codebases (SWE-bench Verified: 59.6%, GPQA: 86.4%, 1M context).
Inspect full dependency graphs, cross-reference symbol call sites, and perform architectural refactoring with surgical precision.`,
  },
  {
    id: 'subagent-llama33-instruction-governor',
    aliasId: 'subagent-internai-agents-a1-governor',
    name: 'Agents-A1 Strict Instruction Following & Governance Specialist (InternAI)',
    model: 'internai/Agents-A1',
    provider: 'InternAI (Discovery API)',
    topBenchmark: 'IFEval: 92.1% | GSM8K: 91.1% | Agentic Workflows: 94.2% | 262K Context',
    score: '92.1%',
    domain: 'Strict Instruction Adherence, Schema Compliance, Output Formatting, Governance & Agentic Workflows',
    capabilities: ['instruction-following', 'ifeval', 'schema-validation', 'governance', 'llama-3.3', 'agentic', 'agents-a1', 'internai'],
    systemInstruction: `You are the Instruction Following & Governance Specialist powered by Agents-A1 on InternAI (Discovery API).
Your strongest capability is unwavering adherence to strict rules, complex constraints, and precise schema specifications (IFEval: 92.1%, 262K context).
Ensure 100% compliance with schemas, negative gates, invariants, and deterministic operational protocols without deviation.`,
  },
  {
    id: 'subagent-codestral-fim-surgeon',
    aliasId: 'subagent-internai-kimi-fim-surgeon',
    name: 'Kimi K2.6 Surgical Infilling & FIM Specialist (InternAI)',
    model: 'internai/kimi-k2.6',
    provider: 'InternAI (Discovery API)',
    topBenchmark: 'HumanEval FIM: 91.6% | RepoBench: 34.0% | Long-Context Patching: 92.4% | 262K Context',
    score: '91.6%',
    domain: 'Fill-In-the-Middle (FIM), Surgical In-Place Patching, Infilling Tests & Multi-file Gap Completion',
    capabilities: ['fim', 'infilling', 'surgical-patch', 'test-completion', 'codestral', 'kimi', 'internai'],
    systemInstruction: `You are the Surgical Infilling & FIM Specialist powered by Kimi K2.6 on InternAI (Discovery API).
Your strongest capability is Fill-In-The-Middle (FIM) surgical edits and test infilling without modifying surrounding code (HumanEval FIM: 91.6%, 262K context).
Execute exact minimal diffs, seamlessly complete function bodies, and generate inline tests fitting existing codebase conventions.`,
  },
  {
    id: 'subagent-skeptical-adversary',
    aliasId: 'subagent-internai-glm53-adversary',
    name: 'GLM 5.3 Skeptical Adversarial Critic & Epistemic Verification Specialist (InternAI)',
    model: 'internai/glm-5.3',
    provider: 'InternAI (Discovery API)',
    topBenchmark: 'Adversarial Falsification & Epistemic Rigor: 96.5% | 1M Context',
    score: '96.5%',
    domain: 'Adversarial Hypothesis Testing, Root Cause Falsification, Epistemic Rigor, Anti-Confirmation Bias & Flaw Hunting',
    capabilities: ['critic', 'adversarial', 'falsification', 'anti-bias', 'epistemic-investigation', 'root-cause-audit', 'glm', 'internai'],
    systemInstruction: `You are the Skeptical Adversarial Critic powered by GLM 5.3 on InternAI (Discovery API).
Your sole mission is to challenge, poke holes in, and actively falsify proposed root-cause diagnoses and bugfix plans.
Assume the primary investigator suffers from confirmation bias and premature closure.
Identify overlooked causal factors, alternative explanations, uninspected caller call-sites, and missing edge cases.
Demand rigorous empirical proof and reject unsubstantiated assertions.`,
  },
];

/**
 * Đăng ký toàn bộ Subagent chuyên gia theo Benchmark (provider InternAI) vào AgentRegistry.
 */
export function registerBenchmarkSpecialists(registry: AgentRegistry): AgentRecord[] {
  const records: AgentRecord[] = [];
  for (const specialist of BENCHMARK_SPECIALISTS) {
    const record = registry.register(specialist.id, specialist.name, {
      model: specialist.model,
      provider: specialist.provider,
      topBenchmark: specialist.topBenchmark,
      score: specialist.score,
      domain: specialist.domain,
      systemInstruction: specialist.systemInstruction,
    });
    registry.advertiseCapabilities(specialist.id, specialist.capabilities);
    records.push(record);

    if (specialist.aliasId) {
      const aliasRecord = registry.register(specialist.aliasId, specialist.name, {
        model: specialist.model,
        provider: specialist.provider,
        topBenchmark: specialist.topBenchmark,
        score: specialist.score,
        domain: specialist.domain,
        systemInstruction: specialist.systemInstruction,
        primaryId: specialist.id,
      });
      registry.advertiseCapabilities(specialist.aliasId, specialist.capabilities);
      records.push(aliasRecord);
    }
  }
  return records;
}

/**
 * Lấy danh sách định nghĩa các specialist.
 */
export function getBenchmarkSpecialists(): BenchmarkSpecialist[] {
  return [...BENCHMARK_SPECIALISTS];
}

/**
 * Tìm kiếm Subagent chuyên gia phù hợp nhất dựa trên tên, model hoặc từ khóa benchmark.
 */
export function findSpecialistForBenchmark(benchmarkQuery: string): BenchmarkSpecialist | undefined {
  const clean = benchmarkQuery.trim().toLowerCase();
  if (!clean) return undefined;

  return BENCHMARK_SPECIALISTS.find((s) => {
    return (
      s.topBenchmark.toLowerCase().includes(clean) ||
      s.domain.toLowerCase().includes(clean) ||
      s.capabilities.some((c) => c.toLowerCase() === clean) ||
      s.id.toLowerCase().includes(clean) ||
      (s.aliasId && s.aliasId.toLowerCase().includes(clean)) ||
      s.model.toLowerCase().includes(clean)
    );
  });
}
