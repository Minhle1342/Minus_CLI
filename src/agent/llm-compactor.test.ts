import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeMessagesForCompaction,
  compactHistoryWithLLM,
  COMPACTION_SYSTEM_PROMPT,
} from './llm-compactor.js';
import { ContextCompactor } from './context-compactor.js';
import {
  parseCompactionText,
  formatCompactionCard,
} from '../ui/tea/models/viewport-model.js';

test('serializeMessagesForCompaction formats transcript cleanly for LLM input', () => {
  const messages: any[] = [
    { role: 'user', parts: [{ text: 'Please investigate issue #42' }] },
    {
      role: 'model',
      parts: [
        { text: 'I will start by checking the logs.' },
        { functionCall: { name: 'run_command', args: { command: 'grep ERROR app.log' } } },
      ],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'run_command',
            response: { exitCode: 0, stdout: 'ERROR: connection refused at 10.0.0.1:5432' },
          },
        },
      ],
    },
  ];

  const serialized = serializeMessagesForCompaction(messages);
  assert.ok(serialized.includes('[USER]: Please investigate issue #42'));
  assert.ok(serialized.includes('[ASSISTANT]: I will start by checking the logs.'));
  assert.ok(serialized.includes('[TOOL CALL: run_command]: args={"command":"grep ERROR app.log"}'));
  assert.ok(serialized.includes('[TOOL RESULT: run_command]:'));
  assert.ok(serialized.includes('ERROR: connection refused at 10.0.0.1:5432'));
});

test('compactHistoryWithLLM calls generate and returns structured text', async () => {
  let capturedPrompt = '';
  let capturedSystemPrompt = '';

  const mockLLM = {
    async generate(sessionOrPrompt: any, _history: any[], options: any) {
      if (typeof sessionOrPrompt === 'string') {
        capturedPrompt = sessionOrPrompt;
      } else if (sessionOrPrompt?.getHistory) {
        capturedPrompt = sessionOrPrompt.getHistory()[0]?.parts?.[0]?.text || '';
      }
      capturedSystemPrompt = options?.systemPrompt || '';
      return {
        text: `Objective
- Investigate database connectivity error

Requirements
- Do not modify code without confirmation

Decisions
- Confirmed database host 10.0.0.1 is unreachable

Work State
Completed
- Checked app.log
Active
- Pinging network gateway
Blocked
- None

Next Move
1. Check VPN status
2. Test port 5432 connectivity

Relevant Files
- app.log (inspected)

Important Context
- PostgreSQL service on 10.0.0.1:5432 was restarted`,
      };
    },
  };

  const messages: any[] = [
    { role: 'user', parts: [{ text: 'Check DB error' }] },
    { role: 'model', parts: [{ text: 'Checking log...' }] },
  ];

  const result = await compactHistoryWithLLM(messages, mockLLM);
  assert.ok(result.includes('Objective'));
  assert.ok(result.includes('Requirements'));
  assert.ok(result.includes('Decisions'));
  assert.ok(result.includes('Work State'));
  assert.ok(result.includes('Next Move'));
  assert.ok(result.includes('Relevant Files'));
  assert.ok(result.includes('Important Context'));
  assert.equal(capturedSystemPrompt, COMPACTION_SYSTEM_PROMPT);
  assert.ok(capturedPrompt.includes('Check DB error'));
});

test('parseCompactionText parses all 7 structured sections correctly', () => {
  const sample = `[ROLLING DIALOGUE SYNOPSIS - TURNS 1 to 5 ARCHIVED]:
Objective
- Investigate QR code generation error on UAT

Requirements
- Read only investigation, do not edit code

Decisions
- Installed chrome-devtools-mcp globally
- Reused existing auth tokens

Work State
Completed
- Verified /DRW page loads normally
Active
- Inspecting network traces on /Tem/
Blocked
- Need devtools session restart

Next Move
1. Restart OpenCode service
2. Re-trigger QR code print flow
3. Inspect devtools console error

Relevant Files
- c:\\app\\routes\\qr.ts (L45-L60, controller route)
- c:\\app\\services\\printer.ts (driver wrapper)

Important Context
- Server runs on Windows Server 2022 IIS 10
- API endpoint is https://trial.datnhanh.com.vn:342/DRW/`;

  const parsed = parseCompactionText(sample);
  assert.equal(parsed.rangeLabel, 'TURNS 1 to 5 ARCHIVED');
  assert.equal(parsed.objective.length, 1);
  assert.ok(parsed.objective[0].includes('QR code generation error'));
  assert.equal(parsed.requirements.length, 1);
  assert.equal(parsed.decisions.length, 2);
  assert.equal(parsed.workState.completed.length, 1);
  assert.equal(parsed.workState.active.length, 1);
  assert.equal(parsed.workState.blocked.length, 1);
  assert.equal(parsed.nextMove.length, 3);
  assert.equal(parsed.relevantFiles.length, 2);
  assert.equal(parsed.importantContext.length, 2);
});

test('formatCompactionCard renders all 7 sections with Tokyo Night styling', () => {
  const sample = `[ROLLING DIALOGUE SYNOPSIS - TURNS 1 to 3 ARCHIVED]:
Objective
- Test UI Card

Requirements
- Render all items

Decisions
- Chosen Tokyo Night palette

Work State
Completed
- Setup parser
Active
- Styling borders
Blocked
- Waiting for test run

Next Move
1. Verify terminal output
2. Check color contrast

Relevant Files
- src/ui/tea/models/viewport-model.ts (L300-L500)

Important Context
- Width set to 100 columns`;

  const lines = formatCompactionCard(sample, 100, false);
  const fullText = lines.join('\n');

  // Verify top and bottom borders
  assert.ok(fullText.includes('╭─'));
  assert.ok(fullText.includes('╰─'));
  assert.ok(fullText.includes('Context Compaction (LLM)'));

  // Verify all 7 section icons and headers are present
  assert.ok(fullText.includes('🎯 Objective'));
  assert.ok(fullText.includes('📋 Requirements'));
  assert.ok(fullText.includes('💡 Decisions'));
  assert.ok(fullText.includes('⚡ Work State'));
  assert.ok(fullText.includes('✔ Completed:'));
  assert.ok(fullText.includes('● Active:'));
  assert.ok(fullText.includes('✖ Blocked:'));
  assert.ok(fullText.includes('🚀 Next Move'));
  assert.ok(fullText.includes('📁 Relevant Files'));
  assert.ok(fullText.includes('📌 Important Context'));

  // Verify collapsed rendering with generous width
  const collapsedLines = formatCompactionCard(sample, 140, true);
  const collapsedText = collapsedLines.join('\n');
  assert.ok(collapsedText.includes('▸'));
  assert.ok(collapsedText.includes('Ctrl+O to expand'));
});

test('compactCompletedTurnWindowAsync integrates custom LLM text into window synopsis', async () => {
  const mockLLM = {
    async generate() {
      return {
        text: `Objective
- Refactor compaction to LLM standard

Requirements
- 7 structured sections

Decisions
- Preserved existing tool pairing invariants

Work State
Completed
- Added llm-compactor
Active
- Testing integration
Blocked
- None

Next Move
1. Run full test suite

Relevant Files
- src/agent/llm-compactor.ts

Important Context
- Fallback to rule-based if LLM fails`,
      };
    },
  };

  const compactor = new ContextCompactor();
  const entries: any[] = [
    { turn: 1, message: { role: 'user', parts: [{ text: 'Turn 1 user' }] } },
    { turn: 1, message: { role: 'model', parts: [{ text: 'Turn 1 assistant' }] } },
    { turn: 2, message: { role: 'user', parts: [{ text: 'Turn 2 user' }] } },
    { turn: 2, message: { role: 'model', parts: [{ text: 'Turn 2 assistant' }] } },
    { turn: 3, message: { role: 'user', parts: [{ text: 'Turn 3 user' }] } },
    { turn: 3, message: { role: 'model', parts: [{ text: 'Turn 3 assistant' }] } },
  ];

  const result = await compactor.compactCompletedTurnWindowAsync(entries, {
    completedTurns: [1, 2, 3],
    preserveCompletedTurns: 1,
    llm: mockLLM,
  });

  const synopsisText = (result.messages[0]?.parts?.[0] as any)?.text || '';
  assert.ok(synopsisText.includes('Objective'));
  assert.ok(synopsisText.includes('Refactor compaction to LLM standard'));
  assert.ok(synopsisText.includes('Work State'));
  assert.ok(synopsisText.includes('Next Move'));
  assert.ok(synopsisText.includes('Relevant Files'));
  assert.ok(synopsisText.includes('Important Context'));
});
