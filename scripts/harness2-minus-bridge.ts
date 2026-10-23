/**
 * CLI Bridge between MinusCLI and Google Research Harness²
 * 
 * Usage:
 *   tsx scripts/harness2-minus-bridge.ts --export
 *   tsx scripts/harness2-minus-bridge.ts --demo
 */

import { Harness2RecursiveEngine, Harness2Bundle } from '../src/agent/harness2-bridge.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const engine = new Harness2RecursiveEngine();

  if (args.includes('--export')) {
    const exportPath = path.join(rootDir, 'external', 'harness2', 'runs', 'minus_harness');
    console.log(`📦 Đang xuất 8 thành phần Scaffolding của MinusCLI sang: ${exportPath}`);

    const bundle: Harness2Bundle = {
      systemPrompt: 'You are MinusCLI, an advanced autonomous software engineering agent powered by Gemini.',
      systemPromptPlan: engine.generatePhaseSystemPrompt('plan', [
        'Survey call graphs with GitNexus before writing plans',
        'Decompose into 2-5 verifiable DAG milestones',
      ]),
      systemPromptImplement: engine.generatePhaseSystemPrompt('implement', [
        'Require TDD reproduction tests before any code edit',
        'Verify with empirical test commands before reporting completion',
      ]),
      guardrails: [
        'MUST run impact before editing (GitNexus call graph intelligence)',
        'NEVER edit a function, class, or method before impact analysis',
        'Strictly avoid synthetic mock passes; require real verification',
        'Detect sycophancy and premise deception; reject invalid shortcuts',
      ],
      memory: 'MinusCLI utilizes a Temporal Knowledge Graph and Project Memory architecture.',
      toolGuidance: engine.generateStandardToolGuidanceCatalog(),
      subagents: {
        scout: {
          role: 'Read-only Reconnaissance Agent',
          instructions: 'Perform parallel code searches, AST analysis, and report findings.',
        },
        'subagent-gemini-swe-architect': {
          role: 'Full-repo Bug Specialist',
          instructions: 'Perform root cause analysis and upstream caller verification.',
        },
      },
      skills: ['verification-policy', 'architecture-playbooks', 'gitnexus-impact'],
      scripts: {
        test: 'npm test',
        build: 'npm run build',
      },
      plugins: {
        codegraph: { enabled: true, mode: 'local' },
        gitnexus: { enabled: true },
      },
    };

    await engine.exportBundleToDirectory(bundle, exportPath);
    console.log('✅ Đã xuất thành công 8 thành phần Harness²:');
    console.log('   - systemprompt.md');
    console.log('   - systemprompt_plan.md');
    console.log('   - systemprompt_implement.md');
    console.log('   - guardrails.md');
    console.log('   - LongTermMEMORY.md');
    console.log(`   - tool_descriptions/ (${Object.keys(bundle.toolGuidance).length} tools: ${Object.keys(bundle.toolGuidance).join(', ')})`);
    console.log('   - sub_agents/');
    console.log('   - skills/');
    console.log('\n🚀 Bạn có thể chạy harness2 trên thư mục này hoặc dùng trong benchmark.');
  } else if (args.includes('--import')) {
    const importPath = path.join(rootDir, 'external', 'harness2', 'runs', 'minus_harness');
    console.log(`📥 Đang nạp 8 thành phần Scaffolding từ Harness²: ${importPath}`);
    const bundle = await engine.importBundleFromDirectory(importPath);
    console.log(`✅ Đã nạp thành công Scaffold từ Harness²:`);
    console.log(`   - System Prompt Generic (${bundle.systemPrompt.length} chars)`);
    if (bundle.systemPromptPlan) console.log(`   - System Prompt [PLAN] (${bundle.systemPromptPlan.length} chars)`);
    if (bundle.systemPromptImplement) console.log(`   - System Prompt [IMPLEMENT] (${bundle.systemPromptImplement.length} chars)`);
    console.log(`   - Guardrails (${bundle.guardrails.length} rules)`);
    console.log(`   - Memory (${bundle.memory.length} chars)`);
    console.log(`   - Tools (${Object.keys(bundle.toolGuidance).length} tools: ${Object.keys(bundle.toolGuidance).join(', ')})`);
    console.log(`   - Subagents (${Object.keys(bundle.subagents).length} agents)`);
    console.log(`   - Skills (${bundle.skills.length} skills: ${bundle.skills.join(', ')})`);
  } else {

    console.log('MinusCLI <-> Harness² Bridge');
    console.log('Tùy chọn:');
    console.log('  --export   Xuất 8 thành phần Scaffold của MinusCLI sang định dạng Harness²');
    console.log('  --import   Nạp 8 thành phần Scaffold từ thư mục runs/minus_harness về MinusCLI');
  }

}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
