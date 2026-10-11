# Ponytail Refactoring & Simplification for `AgentLoop`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate bloat, hand-rolled helpers, speculative duplication, and dead wrappers in `src/agent/agent-loop.ts` to dramatically reduce line count and cognitive complexity.

**Architecture:** Refactor `src/agent/agent-loop.ts` following Ponytail simplicity principles: replace redundant wrapper functions with direct imports, shrink verbose ranking algorithms into compact lookup tables, deduplicate boilerplate methods, and streamline repeated session persistence logic while maintaining 100% test compatibility.

**Tech Stack:** TypeScript, Node.js (`node:test`, `node:assert/strict`)

**Spec:** [docs/superpowers/plans/2026-10-11-ponytail-agent-loop-refactor.md](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/docs/superpowers/plans/2026-10-11-ponytail-agent-loop-refactor.md)

## Global Constraints

- Preserve 100% backward compatibility for all public APIs (`AgentLoop.run`, `AgentLoop.rollback`, `AgentLoop.setWorkspace`, `AgentLoop.setLLM`).
- Retain all existing test suites passing (`src/agent/agent-loop-bug-fixes.test.ts`, `src/agent/request-analysis.test.ts`, `src/agent/extracted-modules.test.ts`).
- No external runtime dependencies introduced; rely strictly on standard JavaScript / Node.js platform features.
- Zero functional regression in tool execution, rollback, and session telemetry.

## Review Focus

1. Verify `isScratchPath` handles all path types previously accepted by `isScratchFilePath`.
2. Verify `hypothesisBlastRadiusRisk` returns identical priority values for all permutations (`CRITICAL` -> `R5`, `HIGH` -> `R3`, `MEDIUM` -> `R2`, `LOW` -> `R1`, default -> `R0`).
3. Verify `ensureGameTools()` correctly registers Unity game tools in both constructor initialization and `setWorkspace()`.
4. Ensure `envFeatureEnabled` and `envFiniteNumber` replacements handle missing and invalid environment variables gracefully without throwing.
5. Verify `persistSession(session)` deduplication does not drop session persistence at turn boundary checkpoints.

---

### Task 1: Eliminate Redundant Wrappers & Hand-Rolled Parsers (`delete` & `native`)

**Files:**
- Modify: `src/agent/agent-loop.ts:125-156`
- Test: `src/agent/ponytail-refactor.test.ts`

**Interfaces:**
- Consumes: `isScratchPath` from `../skills/verification-policy.js`
- Produces: Direct usage of `isScratchPath` inside `agent-loop.ts`, compact environment readers

- [ ] **Step 1: Write the failing test**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { isScratchFilePath } from './agent-loop.js';

test('isScratchFilePath aliases isScratchPath correctly', () => {
  assert.equal(isScratchFilePath('.minus/scratch/test.ts'), true);
  assert.equal(isScratchFilePath('src/index.ts'), false);
});
```

- [ ] **Step 2: Run test to verify it fails/passes baseline**

Run: `npx tsx --test src/agent/ponytail-refactor.test.ts`
Expected: PASS baseline test

- [ ] **Step 3: Replace wrapper calls with direct `isScratchPath` & inline env helpers**

In `src/agent/agent-loop.ts`:
- Replace calls to `isScratchFilePath(p)` with `isScratchPath(p)` across lines 3744, 4062, 4427.
- Keep `export const isScratchFilePath = isScratchPath;` as a single-line re-export for backward compatibility.
- Replace hand-rolled `envFiniteNumber(name)` with standard `Number(process.env[name]) || undefined`.
- Simplify `envFeatureEnabled(name, defaultValue)` to standard 3-line check.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/agent/ponytail-refactor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts src/agent/ponytail-refactor.test.ts
git commit -m "refactor(agent): eliminate isScratchFilePath wrapper and simplify env helpers"
```

---

### Task 2: Shrink `hypothesisBlastRadiusRisk` to Lookup Map (`shrink` & `stdlib`)

**Files:**
- Modify: `src/agent/agent-loop.ts:158-170`
- Test: `src/agent/ponytail-refactor.test.ts`

**Interfaces:**
- Consumes: `hypotheses: Array<{ blastRadius?: string }>`
- Produces: `'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | undefined`

- [ ] **Step 1: Write unit tests covering all risk ranking cases**

```typescript
test('hypothesisBlastRadiusRisk ranks highest risk correctly', () => {
  assert.equal(hypothesisBlastRadiusRisk([{ blastRadius: 'LOW' }, { blastRadius: 'CRITICAL' }]), 'R5');
  assert.equal(hypothesisBlastRadiusRisk([{ blastRadius: 'MEDIUM' }, { blastRadius: 'HIGH' }]), 'R3');
  assert.equal(hypothesisBlastRadiusRisk([{ blastRadius: 'UNKNOWN' }]), 'R0');
  assert.equal(hypothesisBlastRadiusRisk([]), undefined);
});
```

- [ ] **Step 2: Run test to verify coverage**

Run: `npx tsx --test src/agent/ponytail-refactor.test.ts`
Expected: PASS or FAIL if unexported

- [ ] **Step 3: Refactor `hypothesisBlastRadiusRisk` into compact 5-line lookup table**

Replace the 13-line mapping and sorting logic with a static object lookup:
```typescript
const RISK_MAP: Record<string, 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5'> = {
  CRITICAL: 'R5',
  HIGH: 'R3',
  MEDIUM: 'R2',
  LOW: 'R1',
};

export function hypothesisBlastRadiusRisk(
  hypotheses: Array<{ blastRadius?: string }>,
): 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | undefined {
  if (hypotheses.length === 0) return undefined;
  const risks = hypotheses.map(h => RISK_MAP[h.blastRadius || ''] || 'R0');
  return risks.sort().reverse()[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/agent/ponytail-refactor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts src/agent/ponytail-refactor.test.ts
git commit -m "refactor(agent): shrink hypothesisBlastRadiusRisk to compact lookup table"
```

---

### Task 3: Deduplicate Game Tools Registration Boilerplate (`delete` & `DRY`)

**Files:**
- Modify: `src/agent/agent-loop.ts:560-567, 591-598`
- Test: `src/agent/agent-loop-bug-fixes.test.ts`

**Interfaces:**
- Consumes: `this.toolRegistry`, `detectPromptContext`, `this._workspace`
- Produces: Private method `private registerGameToolsIfApplicable(workspace: Workspace): void`

- [ ] **Step 1: Write test verifying workspace game tool registration**

```typescript
test('registerGameToolsIfApplicable triggers without throwing', () => {
  // Verifies constructor and setWorkspace don't error on workspace game tools
});
```

- [ ] **Step 2: Run regression test suite**

Run: `npx tsx --test src/agent/agent-loop-bug-fixes.test.ts`
Expected: PASS

- [ ] **Step 3: Extract duplicate block to private helper**

In `AgentLoop`:
```typescript
private registerGameToolsIfApplicable(workspace: Workspace): void {
  if (typeof (this.toolRegistry as any).registerGameTools === 'function') {
    try {
      if (detectPromptContext(workspace).isUnity) {
        (this.toolRegistry as any).registerGameTools().catch(() => {});
      }
    } catch { }
  }
}
```
Replace duplicate blocks in constructor and `setWorkspace(workspace)` with `this.registerGameToolsIfApplicable(this._workspace)`.

- [ ] **Step 4: Run regression tests to verify cleanliness**

Run: `npx tsx --test src/agent/agent-loop-bug-fixes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "refactor(agent): extract registerGameToolsIfApplicable helper"
```

---

### Task 4: Streamline Session Persistence (`shrink` & `yagni`)

**Files:**
- Modify: `src/agent/agent-loop.ts`
- Test: `src/agent/agent-loop-bug-fixes.test.ts`

**Interfaces:**
- Consumes: `Session`, `this.sessionPersistence`
- Produces: Cleaned up persistence calls without defensive duplicate saves in non-terminal steps

- [ ] **Step 1: Audit all 47 call-sites of `await this.persistSession(session)`**

Identify duplicate contiguous `await this.persistSession(session)` calls where no mutations occurred between them.

- [ ] **Step 2: Run baseline bug fixes tests**

Run: `npx tsx --test src/agent/agent-loop-bug-fixes.test.ts`
Expected: PASS

- [ ] **Step 3: Consolidate consecutive persistence calls**

Remove redundant double-persists (e.g., right before return when already persisted after tool execution).

- [ ] **Step 4: Run test suite to verify session persistence invariants remain intact**

Run: `npx tsx --test src/agent/agent-loop-bug-fixes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "refactor(agent): consolidate redundant session persistence invocations"
```

---

### Task 5: Final Whole-Suite Verification (`verification`)

**Files:**
- Test: Entire project test suite & build

- [ ] **Step 1: Run full unit test suite**

Run: `npx tsx --test src/agent/ponytail-refactor.test.ts src/agent/request-analysis.test.ts src/agent/extracted-modules.test.ts src/agent/agent-loop-bug-fixes.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`
Expected: Clean build (`tsc` exits with 0)

- [ ] **Step 3: Run GitNexus graph change check**

Run: `detect_changes({scope: "all"})`
Expected: `risk_level: low`, zero broken affected processes
