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
      guardrails: [
        'MUST run impact before editing (GitNexus call graph intelligence)',
        'NEVER edit a function, class, or method before impact analysis',
        'Strictly avoid synthetic mock passes; require real verification',
        'Detect sycophancy and premise deception; reject invalid shortcuts',
      ],
      memory: 'MinusCLI utilizes a Temporal Knowledge Graph and Project Memory architecture.',
      toolGuidance: {
        spawn_agent: 'Launch background scout/specialist subagents for parallel exploration without lock conflicts.',
        run_command: 'Execute terminal verification commands with strict timeout.',
        replace_file_content: 'Perform surgical, atomic single-block mutations.',
      },
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
    console.log('   - guardrails.md');
    console.log('   - LongTermMEMORY.md');
    console.log('   - tool_descriptions/');
    console.log('   - sub_agents/');
    console.log('   - skills/');
    console.log('\n🚀 Bạn có thể chạy harness2 trên thư mục này hoặc dùng trong benchmark.');
  } else {
    console.log('MinusCLI <-> Harness² Bridge');
    console.log('Tùy chọn:');
    console.log('  --export   Xuất 8 thành phần Scaffold của MinusCLI sang định dạng Harness²');
  }
}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
