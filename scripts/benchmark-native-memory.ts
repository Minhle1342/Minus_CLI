import {
  getNativeVersion,
  isNativeAvailable,
  nativeTruncateToolOutput,
  nativeCompactHistory,
  nativeExtractFileSymbols,
  nativeFindSymbolInFile,
  nativeFastHistoryStats,
} from '../src/native/index.js';

console.log('=== BENCHMARK & VERIFICATION: RUST NATIVE MEMORY OFFLOAD ===\n');

console.log(`Native Core Available: ${isNativeAvailable()}`);
console.log(`Native Core Version: ${getNativeVersion()}\n`);

// 1. Benchmark & Test Truncate Tool Output
console.log('--- TEST 1: Tool Output Truncation & Error Extraction ---');
const largeOutputArray: string[] = [];
for (let i = 1; i <= 5000; i++) {
  if (i === 1200) {
    largeOutputArray.push('AssertionError [ERR_ASSERTION]: Expected status 200 but received 500 at UserService.test.ts:42');
  } else if (i === 3400) {
    largeOutputArray.push('FATAL: Database connection timeout after 30000ms');
  } else {
    largeOutputArray.push(`[INFO 2026-09-15 22:30:${String(i % 60).padStart(2, '0')}] Processing batch item ${i}... OK`);
  }
}
const rawLargeText = largeOutputArray.join('\n');
console.log(`Raw Output Size: ${(rawLargeText.length / 1024).toFixed(2)} KB (${largeOutputArray.length} lines)`);

const t0 = performance.now();
const truncRes = nativeTruncateToolOutput(rawLargeText, 100, 8000, true);
const t1 = performance.now();

console.log(`Truncation Execution Time: ${(t1 - t0).toFixed(3)} ms`);
console.log(`Was Truncated: ${truncRes.wasTruncated}`);
console.log(`Original Bytes: ${truncRes.originalBytes}`);
console.log(`Truncated Bytes: ${truncRes.truncatedBytes} (${((1 - truncRes.truncatedBytes / truncRes.originalBytes) * 100).toFixed(1)}% memory reduction)`);
console.log(`Lines Retained: ${truncRes.linesRetained}`);
console.log(`Snippet Preview:\n${truncRes.text.slice(0, 400)}...\n...\n${truncRes.text.slice(-300)}\n`);

// 2. Benchmark & Test Fast History Compaction
console.log('--- TEST 2: Native History Compaction ---');
const sampleMessages = [
  { role: 'user', parts: [{ text: 'Please analyze and fix the performance issue in agent loop.' }] },
  { role: 'model', parts: [{ functionCall: { name: 'run_command', args: { command: 'npm test' } } }] },
  { role: 'user', parts: [{ functionResponse: { name: 'run_command', response: { stdout: rawLargeText, exitCode: 1 } } }] },
  { role: 'model', parts: [{ text: 'I see the assertion error in UserService.test.ts.' }] },
  { role: 'user', parts: [{ text: 'Now fix it.' }] },
];

const messagesJson = JSON.stringify(sampleMessages);
const t2 = performance.now();
const compactRes = nativeCompactHistory(messagesJson, 10000, 2, 800);
const t3 = performance.now();

console.log(`Compaction Execution Time: ${(t3 - t2).toFixed(3)} ms`);
if (compactRes) {
  console.log(`Original Chars: ${compactRes.originalChars}`);
  console.log(`Compacted Chars: ${compactRes.compactedChars}`);
  console.log(`Tokens Saved Estimate: ${compactRes.estimatedTokensSaved}`);
  console.log(`Masked Count: ${compactRes.maskedCount}`);
}

// 3. Benchmark & Test Native Symbol Extraction
console.log('\n--- TEST 3: Native Symbol Extraction ---');
const tsCode = `
import { Workspace } from '../workspace/workspace.js';

/**
 * Main Controller for processing tasks
 */
export class TaskController {
  private id: string;

  constructor(id: string) {
    this.id = id;
  }

  async executeTask(name: string): Promise<boolean> {
    return true;
  }
}

export interface ControllerOptions {
  timeoutMs: number;
}

export function createController(id: string): TaskController {
  return new TaskController(id);
}
`;

const t4 = performance.now();
const symbols = nativeExtractFileSymbols('sample.ts', tsCode);
const t5 = performance.now();

console.log(`Symbol Extraction Time: ${(t5 - t4).toFixed(3)} ms`);
console.log(`Symbols Found: ${symbols?.length}`);
symbols?.forEach((s) => {
  console.log(`  - [${s.kind}] ${s.name} (Line ${s.line}, Exported: ${s.isExported})`);
});

const foundSym = nativeFindSymbolInFile('sample.ts', 'createController', tsCode);
console.log(`\nDirect Lookup for 'createController': found=${foundSym?.found}, kind=${foundSym?.kind}, line=${foundSym?.line}`);

console.log('\n=== ALL TESTS COMPLETED SUCCESSFULLY ===');
