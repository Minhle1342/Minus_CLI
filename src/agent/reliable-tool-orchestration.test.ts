import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SemanticSlicer } from './semantic-slicer.js';
import {
  ReliableToolOrchestrationTelemetry,
  applyReliableToolRouteToDeclarations,
  decideReliableToolRoute,
  resolveReliableToolOrchestrationMode,
} from './reliable-tool-orchestration.js';
import { ToolSynergyAdvisor } from './tool-synergy-advisor.js';
import { TypeScriptService } from '../tools/typescript-service.js';
import { CodebaseIntelligenceService } from '../tools/codebase-intelligence.js';
import { createGetSymbolContext360Tool } from '../tools/symbol-context-360.js';
import { Workspace } from '../workspace/workspace.js';


test('TypeScript compiler AST extracts exact methods despite braces in strings and comments', () => {
  const source = `
export class Alpha {
  run(value: string): string {
    const misleading = "}";
    // another misleading brace: }
    return value + misleading;
  }
}

export class Beta {
  run(): number {
    return 42;
  }
}
`;
  const outline = SemanticSlicer.extractOutline('sample.ts', source);
  assert.equal(outline.parser, 'typescript-ast');
  assert.equal(outline.confidence, 'high');
  assert.ok(outline.symbols.some((symbol) => symbol.qualifiedName === 'Alpha.run'));
  assert.ok(outline.symbols.some((symbol) => symbol.qualifiedName === 'Beta.run'));

  const ambiguous = SemanticSlicer.sliceSymbol(source, 'run', 'sample.ts');
  assert.equal(ambiguous.found, false);
  assert.equal(ambiguous.ambiguousMatches?.length, 2);

  const exact = SemanticSlicer.sliceSymbol(source, 'Alpha.run', 'sample.ts');
  assert.equal(exact.found, true);
  assert.equal(exact.complete, true);
  assert.match(exact.code || '', /return value \+ misleading/);
  assert.doesNotMatch(exact.code || '', /return 42/);
});

test('TypeScript AST includes exported arrow functions and multiline declarations', () => {
  const source = `export const calculate = async (
  left: number,
  right: number,
): Promise<number> => {
  return left + right;
};`;
  const slice = SemanticSlicer.sliceSymbol(source, 'calculate', 'math.ts');
  assert.equal(slice.found, true);
  assert.equal(slice.startLine, 1);
  assert.equal(slice.endLine, 6);
  assert.match(slice.code || '', /return left \+ right/);
});

test('Python parser follows indentation beyond the former twenty-line cutoff', () => {
  const body = Array.from({ length: 30 }, (_, index) => `        values.append(${index})`).join('\n');
  const source = `class Worker:\n    @trace\n    def execute(self):\n        values = []\n${body}\n        return values\n\ndef after():\n    return True\n`;
  const slice = SemanticSlicer.sliceSymbol(source, 'Worker.execute', 'worker.py');
  assert.equal(slice.found, true);
  assert.equal(slice.parser, 'python-indentation');
  assert.equal(slice.confidence, 'medium');
  assert.equal(slice.startLine, 2);
  assert.match(slice.code || '', /values\.append\(29\)/);
  assert.doesNotMatch(slice.code || '', /def after/);
});

test('routing progresses search to graph context to exact body to impact', () => {
  const afterSearch = decideReliableToolRoute({
    lastToolName: 'search_codebase_fast',
    lastToolResult: { hits: [{ path: 'src/service.ts', symbol: 'Service.run' }] },
  });
  assert.equal(afterSearch.stage, 'symbol_context');
  assert.equal(afterSearch.selectedTool, 'get_symbol_context_360');
  assert.deepEqual(afterSearch.suggestedArgs, { symbol: 'Service.run', path: 'src/service.ts' });

  const afterContext = decideReliableToolRoute({
    lastToolName: 'get_symbol_context_360',
    lastToolResult: { context360: { symbol: 'run', file: ' shorts/service.ts' } },
  });
  assert.equal(afterContext.stage, 'exact_implementation');
  assert.equal(afterContext.selectedTool, 'read_file');
  assert.deepEqual(afterContext.suggestedArgs, { path: 'shorts/service.ts', symbol: 'run' });

  const afterBody = decideReliableToolRoute({
    lastToolName: 'read_file',
    lastToolResult: { path: 'src/service.ts', symbol: 'run', completeDeclaration: true },
  });
  assert.equal(afterBody.stage, 'ready_for_mutation');
  assert.equal(afterBody.selectedTool, 'analyze_impact');
  assert.equal(afterBody.constrainSafe, true);
});

test('multi-file search uses adaptive compression and unavailable tools fail open', () => {
  const compressed = decideReliableToolRoute({
    lastToolName: 'search_codebase_fast',
    lastToolResult: { hits: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/a.ts' }] },
  });
  assert.equal(compressed.selectedTool, 'read_compressed_code');
  assert.deepEqual(compressed.suggestedArgs, { paths: ['src/a.ts', 'src/b.ts'], fidelity: 'adaptive' });

  const unavailable = decideReliableToolRoute({
    userRequest: 'understand auth flow',
    visibleToolNames: ['run_command'],
  });
  assert.equal(unavailable.selectedTool, undefined);
  assert.equal(unavailable.failOpen, true);
  assert.equal(unavailable.constrainSafe, false);

  const declarations = [
    { name: 'search_codebase_fast' },
    { name: 'read_compressed_code' },
    { name: 'get_symbol_context_360' },
    { name: 'read_file' },
    { name: 'replace_text' },
  ];
  const enforced = applyReliableToolRouteToDeclarations(declarations, compressed, 'enforce');
  assert.deepEqual(enforced.map((tool) => tool.name), [
    'read_compressed_code',
    'get_symbol_context_360',
    'read_file',
    'replace_text',
  ]);
  assert.equal(applyReliableToolRouteToDeclarations(declarations, unavailable, 'enforce').length, declarations.length);
  assert.equal(applyReliableToolRouteToDeclarations(declarations, compressed, 'shadow').length, declarations.length);
});

test('advisor emits actionable reliable-retrieval guidance without an invalid 360 call', () => {
  const advisor = new ToolSynergyAdvisor();
  const first = advisor.advise({ activeTaskTitle: 'Understand authentication flow' });
  assert.equal(first.suggestedTools[0], 'search_codebase_fast');
  assert.match(first.guidance, /broad_discovery/);

  const afterOutline = advisor.advise({
    lastToolName: 'read_file',
    lastToolResult: { path: 'src/auth.ts', symbols: [{ name: 'authenticate', qualifiedName: 'Auth.authenticate' }] },
  });
  assert.equal(afterOutline.suggestedTools[0], 'get_symbol_context_360');
  assert.match(afterOutline.guidance, /Auth\.authenticate/);
});

test('mode resolver and telemetry expose adoption, fallback, cycles, and transitions', () => {
  assert.equal(resolveReliableToolOrchestrationMode('SHADOW'), 'shadow');
  assert.equal(resolveReliableToolOrchestrationMode('unexpected'), 'off');
  assert.equal(resolveReliableToolOrchestrationMode(''), 'shadow');
  const telemetry = new ReliableToolOrchestrationTelemetry();
  const discovery = decideReliableToolRoute({ userRequest: 'find parser' });
  telemetry.recordDecision(discovery);
  telemetry.recordExecution(discovery, 'search_codebase_fast', {});
  const ready = decideReliableToolRoute({ lastToolName: 'read_file', lastToolResult: { symbol: 'parse', path: 'src/parser.ts' } });
  telemetry.recordDecision(ready);
  telemetry.recordExecution(ready, 'read_file', {});
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.decisions, 2);
  assert.equal(snapshot.followed, 1);
  assert.equal(snapshot.invalidCycles, 1);
  assert.equal(snapshot.transitionCounts['broad_discovery->ready_for_mutation'], 1);
});

test('context 360 resolves qualified class methods and isolates workspace services', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-context-360-'));
  const firstRoot = path.join(temporaryRoot, 'first');
  const secondRoot = path.join(temporaryRoot, 'second');
  await fs.mkdir(path.join(firstRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(secondRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(firstRoot, 'src', 'service.ts'), [
    'export class Alpha {',
    '  /** Runs alpha. */',
    '  run(value: string): string { return value; }',
    '}',
    'export class Other { run(): number { return 1; } }',
    'export const alphaResult = new Alpha().run("ok");',
    'export const otherResult = new Other().run();',
  ].join('\n'));
  await fs.writeFile(path.join(secondRoot, 'src', 'service.ts'), 'export class Beta {\n  run(): number { return 2; }\n}\n');

  try {
    const firstWorkspace = new Workspace(firstRoot);
    const secondWorkspace = new Workspace(secondRoot);
    const typescript = new TypeScriptService(firstWorkspace);
    const inspected = typescript.inspectSymbol('src/service.ts', 'Alpha.run');
    assert.equal(inspected.found, true);
    assert.equal(inspected.kind, 'method');
    assert.equal(inspected.isExported, true);
    assert.match(inspected.typeSignature || '', /string/);
    const qualifiedReferences = typescript.findReferencesAt(
      'src/service.ts',
      inspected.line || 1,
      inspected.character || 1,
    );
    assert.ok(qualifiedReferences.some((reference) => reference.preview.includes('new Alpha().run')));
    assert.equal(qualifiedReferences.some((reference) => reference.preview.includes('new Other().run')), false);

    const intelligence = new CodebaseIntelligenceService(firstWorkspace);
    const context = intelligence.getSymbolContext360('Alpha.run', 'src/service.ts');
    assert.equal(context.kind, 'method');
    assert.equal(context.file, 'src/service.ts');
    assert.match(context.docComment || '', /Runs alpha/);
    assert.ok(context.referencingFiles.includes('src/service.ts'));

    const tool = createGetSymbolContext360Tool();
    const firstResult = await tool.execute({ symbol: 'Alpha.run', path: 'src/service.ts' }, firstWorkspace);
    const secondResult = await tool.execute({ symbol: 'Beta.run', path: 'src/service.ts' }, secondWorkspace);
    assert.equal(firstResult.context360?.file, 'src/service.ts');
    assert.equal(firstResult.context360?.kind, 'method');
    assert.equal(secondResult.context360?.file, 'src/service.ts');
    assert.equal(secondResult.context360?.kind, 'method');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('trajectory-aware cycle detection breaks repeated 3x tool loops and ping-pong oscillation', () => {
  // 3x search loop
  const repeated = decideReliableToolRoute({
    trajectory: [
      { toolName: 'search_codebase_fast' },
      { toolName: 'search_codebase_fast' },
      { toolName: 'search_codebase_fast' },
    ],
  });
  assert.equal(repeated.stage, 'cycle_break');
  assert.equal(repeated.cycleDetected, true);
  assert.equal(repeated.selectedTool, 'get_symbol_context_360');
  assert.match(repeated.guidance, /CYCLE BREAK/i);

  // Ping-pong oscillation: A -> B -> A -> B
  const oscillation = decideReliableToolRoute({
    trajectory: [
      { toolName: 'search_codebase_fast' },
      { toolName: 'read_compressed_code' },
      { toolName: 'search_codebase_fast' },
      { toolName: 'read_compressed_code' },
    ],
  });
  assert.equal(oscillation.stage, 'cycle_break');
  assert.equal(oscillation.cycleDetected, true);
});

test('Repoformer abstention gate locks broad discovery tools when evidence is sufficient', () => {
  const allTools = [
    { name: 'search_codebase_fast' },
    { name: 'read_compressed_code' },
    { name: 'get_symbol_context_360' },
    { name: 'read_file' },
    { name: 'replace_text' },
  ];
  const abstained = decideReliableToolRoute({
    evidenceSufficient: true,
    visibleToolNames: allTools.map((t) => t.name),
  });
  assert.equal(abstained.stage, 'ready_for_mutation');
  assert.equal(abstained.abstainRetrieval, true);
  assert.match(abstained.guidance, /Repoformer Abstention/i);
  const filtered = applyReliableToolRouteToDeclarations(allTools, abstained, 'enforce');
  assert.equal(filtered.some((t) => t.name === 'search_codebase_fast'), false);
  assert.equal(filtered.some((t) => t.name === 'read_compressed_code'), false);
  assert.equal(filtered.some((t) => t.name === 'replace_text'), true);
});
