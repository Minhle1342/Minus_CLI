import type { AgentRegistry, AgentRecord } from './agent-registry.js';

export interface BenchmarkSpecialist {
  id: string;
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
 * Danh sách 5 Subagent chuyên gia được cấu hình dựa trên kết quả Benchmark cao nhất
 * của các họ mô hình ngôn ngữ lớn (LLMs) hiện có trong hệ sinh thái Minus_Cli.
 */
export const BENCHMARK_SPECIALISTS: BenchmarkSpecialist[] = [
  {
    id: 'subagent-deepseek-r1-math',
    name: 'DeepSeek-R1 Math & Deep Reasoning Specialist',
    model: 'deepseek-ai/DeepSeek-R1',
    provider: 'SiliconFlow / Groq',
    topBenchmark: 'MATH-500: 97.3% | AIME 2024: 79.8% - 87.5%',
    score: '97.3%',
    domain: 'Complex Logic, Advanced Mathematics, Dynamic Programming & Algorithmic Problem Solving',
    capabilities: ['reasoning', 'math', 'algorithm', 'chain-of-thought', 'competition-math', 'deepseek-r1'],
    systemInstruction: `You are the Math & Deep Reasoning Specialist powered by DeepSeek-R1.
Your strongest capability is solving complex mathematical proofs, competitive programming algorithms, and deep chain-of-thought logic (MATH-500: 97.3%, AIME: 87.5%).
Approach problems systematically: verify edge cases, prove invariants, and trace computational complexity thoroughly.`,
  },
  {
    id: 'subagent-qwen25-coder-synthesis',
    name: 'Qwen2.5-Coder Synthesis & Polyglot Implementation Specialist',
    model: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    provider: 'SiliconFlow',
    topBenchmark: 'HumanEval: 92.7% | MBPP: 90.2% | EvalPlus: 87.2%',
    score: '92.7%',
    domain: 'Clean Code Synthesis, Algorithmic Functions, Polyglot Coding (TS, Python, Go, C++, Rust)',
    capabilities: ['coding', 'code-generation', 'humaneval', 'polyglot', 'synthesis', 'qwen-coder'],
    systemInstruction: `You are the Code Synthesis Specialist powered by Qwen 2.5 Coder 32B.
Your strongest capability is producing pristine, syntactically flawless code across languages (HumanEval: 92.7%, MBPP: 90.2%).
Generate idiomatic, well-typed, clean implementations matching exact specifications with comprehensive edge-case handling.`,
  },
  {
    id: 'subagent-gemini-swe-architect',
    name: 'Gemini Software Engineering & Long-Context Architect',
    model: 'gemini-3.7-flash / gemini-2.5-pro',
    provider: 'Google AI Studio',
    topBenchmark: 'SWE-bench Verified: 59.6% | GPQA Diamond: 86.4% | Context: 1M-2M tokens',
    score: '59.6%',
    domain: 'Full-Repo Bug Fixing, Complex Multi-File Refactoring, Architecture Topology & Long-Context Reasoning',
    capabilities: ['swe-bench', 'bug-fixing', 'refactoring', 'long-context', 'architecture', 'gemini'],
    systemInstruction: `You are the Software Engineering & Long-Context Architect powered by Gemini 2.5/3.7.
Your strongest capability is resolving multi-file real-world repository bugs and navigating vast codebases (SWE-bench Verified: 59.6%, GPQA: 86.4%, 2M context).
Inspect full dependency graphs, cross-reference symbol call sites, and perform architectural refactoring with surgical precision.`,
  },
  {
    id: 'subagent-llama33-instruction-governor',
    name: 'Llama 3.3 Strict Instruction Following & Governance Specialist',
    model: 'groq/llama-3.3-70b-versatile',
    provider: 'Groq Cloud / Cerebras / SambaNova',
    topBenchmark: 'IFEval: 92.1% | GSM8K: 91.1% | MMLU: 86.0%',
    score: '92.1%',
    domain: 'Strict Instruction Adherence, Schema Compliance, Output Formatting, Governance & Constraint Verification',
    capabilities: ['instruction-following', 'ifeval', 'schema-validation', 'governance', 'llama-3.3'],
    systemInstruction: `You are the Instruction Following & Governance Specialist powered by Llama 3.3 70B.
Your strongest capability is unwavering adherence to strict rules, complex constraints, and precise schema specifications (IFEval: 92.1%).
Ensure 100% compliance with schemas, negative gates, invariants, and deterministic operational protocols without deviation.`,
  },
  {
    id: 'subagent-codestral-fim-surgeon',
    name: 'Codestral Surgical Infilling & FIM Specialist',
    model: 'mistral/codestral-latest',
    provider: 'Mistral AI',
    topBenchmark: 'HumanEval FIM: 91.6% | RepoBench: 34.0%',
    score: '91.6%',
    domain: 'Fill-In-the-Middle (FIM), Surgical In-Place Patching, Infilling Tests & Multi-file Gap Completion',
    capabilities: ['fim', 'infilling', 'surgical-patch', 'test-completion', 'codestral'],
    systemInstruction: `You are the Surgical Infilling & FIM Specialist powered by Codestral.
Your strongest capability is Fill-In-The-Middle (FIM) surgical edits and test infilling without modifying surrounding code (HumanEval FIM: 91.6%).
Execute exact minimal diffs, seamlessly complete function bodies, and generate inline tests fitting existing codebase conventions.`,
  },
];

/**
 * Đăng ký toàn bộ 5 Subagent chuyên gia theo Benchmark vào AgentRegistry.
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
 * Tìm kiếm Subagent chuyên gia phù hợp nhất dựa trên tên hoặc từ khóa benchmark.
 */
export function findSpecialistForBenchmark(benchmarkQuery: string): BenchmarkSpecialist | undefined {
  const clean = benchmarkQuery.trim().toLowerCase();
  if (!clean) return undefined;

  return BENCHMARK_SPECIALISTS.find((s) => {
    return (
      s.topBenchmark.toLowerCase().includes(clean) ||
      s.domain.toLowerCase().includes(clean) ||
      s.capabilities.some((c) => c.toLowerCase() === clean) ||
      s.id.toLowerCase().includes(clean)
    );
  });
}
