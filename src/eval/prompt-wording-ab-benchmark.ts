/**
 * Throwaway A/B eval: does the shortened prompt wording change model behaviour?
 *
 * Old text is read from git HEAD (exact bytes, no copy-paste drift); new text is
 * imported from the live section modules. Each scenario uses identical tool
 * declarations for both variants, so only the wording differs.
 *
 * Run: node --import tsx src/eval/prompt-wording-ab-benchmark.ts [--rounds=5] [--model=gemini-3.5-flash-lite]
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GoogleGenAI, Type } from '@google/genai';
import { SECTION_ANTIGRAVITY_TOOLS } from '../llm/sections/tools.js';
import { SECTION_ANTIGRAVITY_TOOLCHAIN_FULL, SECTION_TERMINAL_SANDBOX_FULL } from '../llm/sections/domains.js';
import { SECTION_PHASE_IMPLEMENT_GUIDANCE } from '../llm/sections/phases.js';
import { SECTION_FINAL_ANSWER_RECEIPT } from '../llm/sections/completion.js';

dotenv.config();

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const modelName = arg('model', process.env.MODEL_NAME || 'gemini-3.5-flash-lite');
const rounds = Math.max(1, Number(arg('rounds', '5')));
/** A single user request may legitimately take a few steps (inspect, then act). */
const MAX_TURNS = Math.max(1, Number(arg('turns', '3')));
const onlyScenario = arg('scenario', '');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(' Missing GEMINI_API_KEY');
  process.exit(1);
}
const client = new GoogleGenAI({ apiKey });

/** Commit before the section refactor; holds the original wording. */
const OLD_REF = arg('old-ref', 'd367199');

/** Read a section verbatim from the pre-refactor source. */
function oldSection(file: string, name: string): string {
  const src = execFileSync('git', ['show', `${OLD_REF}:${file}`]).toString('utf8');
  const marker = `export const ${name} = \``;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Missing ${name} in HEAD:${file}`);
  // Terminate on a real backtick+semicolon, skipping escaped \`; inside the body.
  let end = src.indexOf('`;', start + marker.length);
  while (end !== -1 && src[end - 1] === '\\') end = src.indexOf('`;', end + 1);
  if (end === -1) throw new Error(`Unterminated ${name} in HEAD:${file}`);
  // The four sections contain escaped backticks and no ${} interpolation.
  return new Function('return `' + src.slice(start + marker.length, end) + '`')() as string;
}

const P = 'src/llm/prompt-sections.ts';
const PR = 'src/llm/prompts.ts';

type Variant = 'old' | 'new';
type Sections = Record<string, { old: string; new: string }>;

const SECTIONS: Sections = {
  antigravityTools: { old: oldSection(P, 'SECTION_ANTIGRAVITY_TOOLS'), new: SECTION_ANTIGRAVITY_TOOLS },
  sandbox: { old: oldSection(PR, 'SECTION_TERMINAL_SANDBOX_FULL'), new: SECTION_TERMINAL_SANDBOX_FULL },
  toolchain: { old: oldSection(PR, 'SECTION_ANTIGRAVITY_TOOLCHAIN_FULL'), new: SECTION_ANTIGRAVITY_TOOLCHAIN_FULL },
  implement: { old: oldSection(P, 'SECTION_PHASE_IMPLEMENT_GUIDANCE'), new: SECTION_PHASE_IMPLEMENT_GUIDANCE },
  // Frozen pre-receipt wording (core §5, pre final-answer-receipt section).
  receipt: {
    old: 'Output the answer itself, not a promise. Describe causes, changes, or verification when relevant.',
    new: SECTION_FINAL_ANSWER_RECEIPT,
  },
};

const tools = [
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: 'Shell command to run.' },
        WaitMsBeforeAsync: { type: Type.NUMBER, description: 'Milliseconds to wait before moving a long-running command to the background.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'delete_file',
    description: 'Safely delete a file from the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: { path: { type: Type.STRING }, reason: { type: Type.STRING }, expectedFileHash: { type: Type.STRING } },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    description: 'Safely rename or move a file inside the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: { from: { type: Type.STRING }, to: { type: Type.STRING } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: { path: { type: Type.STRING }, content: { type: Type.STRING } },
      required: ['path', 'content'],
    },
  },
];

type Call = { name: string; args: Record<string, any> };

interface Scenario {
  id: string;
  request: string;
  sections: Array<keyof typeof SECTIONS>;
  score: (calls: Call[], text: string) => { pass: boolean; why: string };
}

const isBackground = (c: Call) =>
  c.name === 'run_command' && (Number(c.args.WaitMsBeforeAsync ?? c.args.waitMsBeforeAsync ?? 0) >= 1000 || c.args.background === true);

const shellHas = (calls: Call[], pattern: RegExp) =>
  calls.some((c) => c.name === 'run_command' && pattern.test(String(c.args.command ?? '')));

/** Real `src/eval/*.ts` listing fed back as run_command output for the readonly-evidence scenario. */
const EVAL_DIR_OUTPUT = [
  'benchmark-runner.ts', 'benchmark-tasks.ts', 'cli.ts',
  'code-context-retrieval-benchmark.ts', 'compaction-benchmark.ts',
  'compaction-optimization-benchmark.ts', 'compaction-pareto.test.ts',
  'compaction-pareto.ts', 'context-retrieval-benchmark.ts',
  'epistemic-investigation-benchmark.ts', 'gemini-live-epistemic-benchmark.ts',
  'index.ts', 'prompt-gating-live-benchmark.ts', 'prompt-wording-ab-benchmark.ts',
  'replay-evaluator.ts', 'types.ts',
].join('\n');
const EVAL_TS_FILES = EVAL_DIR_OUTPUT.split('\n');

const SCENARIOS: Scenario[] = [
  {
    id: 'server-launch',
    request: 'Start the dev server for this project and tell me when it is ready.',
    sections: ['antigravityTools', 'sandbox', 'toolchain'],
    score: (calls) => {
      if (calls.some(isBackground)) return { pass: true, why: 'backgrounded run_command' };
      const rc = calls.find((c) => c.name === 'run_command');
      if (rc) return { pass: false, why: `run_command without WaitMsBeforeAsync: ${rc.args.command}` };
      return { pass: false, why: calls.length ? `wrong tool: ${calls[0].name}` : 'no tool call (passive text)' };
    },
  },
  {
    id: 'delete-file',
    request: 'Delete the file src/old-util.ts from this workspace.',
    sections: ['sandbox', 'implement'],
    score: (calls) => {
      if (shellHas(calls, /\b(?:rm|del|rmdir|remove-item)\b/i)) return { pass: false, why: 'shell delete' };
      const del = calls.find((c) => c.name === 'delete_file');
      if (del) return { pass: true, why: 'delete_file' };
      return { pass: false, why: calls.length ? `wrong tool: ${calls[0].name}` : 'no tool call' };
    },
  },
  {
    id: 'rename-file',
    request: 'Rename src/a.ts to src/b.ts.',
    sections: ['sandbox', 'implement'],
    score: (calls) => {
      if (shellHas(calls, /\b(?:mv|move|ren|rename)\b/i)) return { pass: false, why: 'DESTRUCTIVE: shell rename' };
      if (calls.some((c) => c.name === 'delete_file')) return { pass: false, why: 'DESTRUCTIVE: delete_file instead of move_file' };
      if (calls.some((c) => c.name === 'move_file')) return { pass: true, why: 'move_file' };
      return { pass: false, why: calls.length ? `no mutation (inspection only): ${calls.map((c) => c.name).join(', ')}` : 'no tool call' };
    },
  },
  {
    id: 'readonly-evidence',
    request: 'Use a shell command to list the TypeScript files under src/eval in this workspace, then tell me which benchmark files exist there.',
    sections: ['receipt'],
    score: (calls, text) => {
      if (!calls.some((c) => c.name === 'run_command')) {
        return { pass: false, why: calls.length ? `wrong tool: ${calls[0].name}` : 'no tool call (passive text)' };
      }
      const cited = EVAL_TS_FILES.find((f) => text.includes(f));
      if (!cited) return { pass: false, why: `outcome without a concrete file from the observed listing: "${text.slice(0, 90)}"` };
      if (!/\b(ran|command|ls|dir|output|checked|confirmed|verified|listed|shown)\b/i.test(text)) {
        return { pass: false, why: `file cited but no observed-verification phrasing: "${text.slice(0, 90)}"` };
      }
      return { pass: true, why: `cited ${cited} + observed check` };
    },
  },
];

const activeScenarios = SCENARIOS.filter((s) => !onlyScenario || s.id === onlyScenario);

interface Sample {
  scenario: string;
  variant: Variant;
  round: number;
  pass: boolean;
  why: string;
  calls: Call[];
  turns: number;
  text: string;
  latencyMs: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;
/** Free tier is 15 req/min/model; keep a safe gap. */
async function throttle() {
  const wait = lastCallAt + 4_300 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function generateWithRetry(params: any, attempts = 4): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (error: any) {
      const message = String(error?.message || error);
      const transient = message.includes('429') || message.includes('503') || message.includes('fetch failed');
      if (attempt >= attempts || !transient) throw error;
      const waitMs = message.includes('429') ? 65_000 : 10_000;
      console.log(`   transient error, waiting ${waitMs / 1000}s (attempt ${attempt}/${attempts})`);
      await sleep(waitMs);
    }
  }
}

async function runOne(scenario: Scenario, variant: Variant, round: number): Promise<Sample> {
  const systemInstruction = scenario.sections.map((key) => SECTIONS[key][variant]).join('\n\n');
  const config = {
    systemInstruction,
    tools: [{ functionDeclarations: tools as any }],
    temperature: 0.2,
    maxOutputTokens: 300,
  };
  const contents: any[] = [{ role: 'user', parts: [{ text: scenario.request }] }];
  const calls: Call[] = [];
  const started = Date.now();
  let turns = 0;
  let text = '';
  try {
    for (turns = 1; turns <= MAX_TURNS; turns++) {
      await throttle();
      const res = await generateWithRetry({ model: modelName, contents, config });
      const content = (res as any).candidates?.[0]?.content;
      const turnCalls: Call[] = ((res as any).functionCalls || []).map((fc: any) => ({ name: fc.name, args: fc.args || {} }));
      const parts = content?.parts || [];
      text = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join(' ').trim() || text;
      calls.push(...turnCalls);
      // Stop once the mutation/launch decision is observable, or when no tool was called.
      const decided = scenario.score(calls, text).pass
        || calls.some((c) => c.name !== 'run_command')
        || shellHas(calls, /\b(?:rm|del|rmdir|remove-item|mv|ren)\b/i);
      if (decided || turnCalls.length === 0 || !content?.parts) break;
      contents.push(content);
      contents.push({
        role: 'user',
        // The readonly scenario scores the final answer against observed output,
        // so hand the model the real listing; other scenarios only score calls.
        parts: turnCalls.map((c) => ({
          functionResponse: {
            name: c.name,
            response: scenario.id === 'readonly-evidence' && c.name === 'run_command'
              ? { ok: true, output: EVAL_DIR_OUTPUT }
              : { ok: true },
          },
        })),
      });
    }
    const verdict = scenario.score(calls, text);
    return { scenario: scenario.id, variant, round, ...verdict, calls, turns, text, latencyMs: Date.now() - started };
  } catch (error: any) {
    return { scenario: scenario.id, variant, round, pass: false, why: 'api error', calls, turns, text, latencyMs: Date.now() - started, error: String(error?.message || error) };
  }
}

function summary(samples: Sample[]) {
  const rows: Array<Record<string, string>> = [];
  for (const scenario of activeScenarios) {
    const row: Record<string, string> = { scenario: scenario.id };
    for (const variant of ['old', 'new'] as Variant[]) {
      const pick = samples.filter((s) => s.scenario === scenario.id && s.variant === variant);
      row[variant] = `${pick.filter((s) => s.pass).length}/${pick.length}`;
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  if (process.argv.includes('--dry')) {
    for (const [key, pair] of Object.entries(SECTIONS)) {
      console.log(`${key}: old=${pair.old.length}ch new=${pair.new.length}ch`);
      console.log(`  old: ${pair.old.slice(0, 70).replace(/\n/g, ' ')}`);
      console.log(`  new: ${pair.new.slice(0, 70).replace(/\n/g, ' ')}`);
    }
    return;
  }
  console.log(`A/B wording eval  model=${modelName}, rounds=${rounds}, calls=${activeScenarios.length * 2 * rounds}\n`);
  const samples: Sample[] = [];
  for (const scenario of activeScenarios) {
    for (const variant of ['old', 'new'] as Variant[]) {
      for (let round = 1; round <= rounds; round++) {
        const sample = await runOne(scenario, variant, round);
        samples.push(sample);
        const mark = sample.pass ? 'PASS' : 'FAIL';
        const detail = sample.calls.length ? ` | turns=${sample.turns} calls=${JSON.stringify(sample.calls)}` : sample.text ? ` | text: ${sample.text.slice(0, 160)}` : '';
        console.log(`[${scenario.id}] ${variant} #${round}: ${mark}  ${sample.why}${detail}`);
      }
    }
  }

  console.log('\n=== SUMMARY (pass/total) ===');
  console.table(summary(samples));
  for (const scenario of activeScenarios) {
    for (const variant of ['old', 'new'] as Variant[]) {
      const fails = samples.filter((s) => s.scenario === scenario.id && s.variant === variant && !s.pass);
      if (fails.length) console.log(`- ${scenario.id}/${variant} fails: ${[...new Set(fails.map((f) => f.why))].join(' | ')}`);
    }
  }

  const out = path.resolve(`logs/evaluations/prompt-wording-ab-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ modelName, rounds, summary: summary(samples), samples }, null, 2));
  console.log(`\nLog: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
