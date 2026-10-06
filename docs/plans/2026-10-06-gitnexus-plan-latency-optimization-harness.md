# GitNexus Engineering Plan

> Task: Integrate prefix caching preservation, deterministic tool ordering, universal tool spill-to-disk, and TTFT telemetry into MinusCLI Harness
> Evidence verified at commit 040caf4f802d86e28edf9fab40cdaef1e445e812; GitNexus index fresh.
> Evidence provenance schema 2; global dirty digest 42c5ab432f20d55b849df1afffadfd4a986789defc496251dbe3784a949fb32b; cited-path manifest 6 sorted entries; exact generated plan path excluded.

## 1. Objective

Integrate state-of-the-art LLM latency stabilization mechanisms (demonstrated by Anthropic Claude prefix caching, Gemini Context Caching, OpenAI Codex, and OpenCode/DeepCode harnesses) into MinusCLI's agent harness. Specifically:
1. Guarantee deterministic prefix preservation across turn iterations to maximize KV cache hit rates (>80% hit rate in long sessions).
2. Universalize spill-to-disk & bounded serialization for all tool outputs (preventing context bloating from massive file reads or grep searches).
3. Enforce deterministic tool definition ordering across all provider adapters.
4. Add proactive latency & cache hit observability per turn.

## 2. Current Behaviour

In MinusCLI:
- `stepSuffixes` in [`gemini.ts`](file:///src/llm/gemini.ts) and [`anthropic.ts`](file:///src/llm/anthropic.ts) partially preserves prefix stability by isolating per-step dynamic hints to the end of user turns `[verified]`.
- Tool output truncation via `offloadLargeLogToDisk` exists only in [`terminal-sanitizer.ts`](file:///src/tools/terminal-sanitizer.ts) and is wired exclusively to `run_command` `[verified]`. Other tools (`read_file`, `search_codebase_fast`, `list_files`) return arbitrary megabytes of data directly into conversation history, blowing prompt tokens from 20k to 120k+ in a single turn.
- Tools passed to LLM adapters (`GeminiClient`, `AnthropicClient`, `DeepSeekClient`) are passed in dynamic array orders dictated by runtime registrations without canonical sorting `[verified]`. This busts prefix caching whenever tool availability or registration ordering shifts.
- No cache hit telemetry (prompt token cache read vs write count) is exposed to the runtime loop or telemetry log `[verified]`.

## 3. Relevant Architecture

- **Agent Execution Loop**: [`src/agent/agent-loop.ts`](file:///src/agent/agent-loop.ts) orchestrates turns, calls provider adapters, receives tool calls, executes tools via [`src/tools/`](file:///src/tools/), and maintains conversation history.
- **Provider Adapters**: [`src/llm/gemini.ts`](file:///src/llm/gemini.ts), [`src/llm/anthropic.ts`](file:///src/llm/anthropic.ts), [`src/llm/deepseek.ts`](file:///src/llm/deepseek.ts) format messages, tools, and system prompts into provider-specific payloads.
- **Context Management**: [`src/agent/context-compactor.ts`](file:///src/agent/context-compactor.ts) handles token budgeting, emergency pruning, and turn compaction.
- **Output Sanitization**: [`src/tools/terminal-sanitizer.ts`](file:///src/tools/terminal-sanitizer.ts) manages log offloading and truncation for terminal execution.

## 4. GitNexus Findings

- Primary symbols:
  - `AgentLoop.run` in [`src/agent/agent-loop.ts`](file:///src/agent/agent-loop.ts) `[verified]`.
  - `GeminiClient.chat` in [`src/llm/gemini.ts`](file:///src/llm/gemini.ts) `[verified]`.
  - `AnthropicClient.chat` in [`src/llm/anthropic.ts`](file:///src/llm/anthropic.ts) `[verified]`.
  - `ContextCompactor.compact` in [`src/agent/context-compactor.ts`](file:///src/agent/context-compactor.ts) `[verified]`.
  - `offloadLargeLogToDisk` in [`src/tools/terminal-sanitizer.ts`](file:///src/tools/terminal-sanitizer.ts) `[verified]`.
- Callers and impact radius:
  - `AgentLoop` connects directly to all tool executions (`ToolRegistry`) and LLM provider interfaces (`LLMClient`).
  - Adapting tool output handling at the harness level (`AgentLoop.executeTool` or tool execution boundary) intercepts all tool returns without mutating each tool's standalone implementation `[inferred]`.

## 5. Statement-Level PDG Findings

- In [`src/agent/agent-loop.ts`](file:///src/agent/agent-loop.ts), tool execution result `toolResult` is pushed directly into `turn.messages` as a `tool_response` content block `[verified]`.
- If `toolResult` is unbounded, every subsequent turn inherits the linear token tax, degrading TTFT (Time To First Token) quadratically or linearly depending on provider cache capability `[verified]`.
- In provider adapters ([`gemini.ts`](file:///src/llm/gemini.ts), [`anthropic.ts`](file:///src/llm/anthropic.ts)), `tools` are serialized into API schemas directly from `this.tools` without `tools.sort((a, b) => a.name.localeCompare(b.name))` `[verified]`.

## 6. Proposed Changes

### 1. `src/tools/terminal-sanitizer.ts` & `src/tools/tool-output-sanitizer.ts`
- Symbol: `sanitizeToolOutput`, `offloadLargeLogToDisk` `[verified]`.
- Extract or generalize `offloadLargeLogToDisk` to universal `sanitizeToolOutput(toolName: string, output: string, maxTokensOrBytes: number)`.
- If output exceeds threshold (e.g. 12,000 chars / ~3,000 tokens), write full raw content to `.gemini/scratch/logs/tool-<id>-<name>.log` or workspace scratch, and return head (first 50 lines) + pointer summary + tail (last 50 lines) with disk path reference.

### 2. `src/agent/agent-loop.ts`
- Symbol: `AgentLoop.executeTool`, `AgentLoop.step` `[verified]`.
- Intercept tool execution results through `sanitizeToolOutput` before storing into conversation history.
- Track cache read tokens (`cached_content_token_count` from Gemini / `cache_read_input_tokens` from Anthropic) and log cache hit efficiency metrics to telemetry.

### 3. `src/llm/gemini.ts`, `src/llm/anthropic.ts`, `src/llm/deepseek.ts`
- Symbol: `formatTools`, `toGeminiTools`, `toAnthropicTools` `[verified]`.
- Apply deterministic lexicographical sorting on tool declarations: `[...tools].sort((a, b) => a.name.localeCompare(b.name))`.
- Maintain immutable system instruction and invariant schema headers across turns to preserve provider KV prefix blocks.

## 7. Implementation Sequence

1. **Step 1: Universal Tool Output Sanitizer**
   - Create/generalize `sanitizeToolOutput` in `src/tools/tool-output-sanitizer.ts` supporting configurable byte/line caps and scratch disk spillover.
2. **Step 2: Wire Sanitizer into Agent Loop Execution**
   - In `AgentLoop`, sanitize all tool response payloads before committing them to turn history.
3. **Step 3: Deterministic Tool Declaration Sorting in Adapters**
   - Sort tools deterministically by name in `GeminiClient`, `AnthropicClient`, `DeepSeekClient`.
4. **Step 4: Cache Hit Telemetry & Metrics**
   - Extract cache hit statistics from API usage responses and log them in `AgentLoop` telemetry.
5. **Step 5: Verification & Regression Tests**
   - Add unit tests for `sanitizeToolOutput`, tool ordering invariance, and cache telemetry extraction.

## 8. Test Strategy

- New tests in `test/tool-output-sanitizer.test.ts`:
  - Small output (< cap): returns unmodified.
  - Giant output (> cap): spills to disk, returns preview + pointer to file.
- New tests in `test/adapter-tool-ordering.test.ts`:
  - Shuffled tool registrations produce identical API tool schema arrays.
- Verification command:
  - `npm test`

## 9. Risk and Impact Analysis

- **Downstream Consumers**: Agent prompt context. If an agent genuinely needed all 100,000 characters of a file in one turn, it must read smaller chunks via line offsets. However, all agent LLMs are instructed to read in windows (e.g., `StartLine`, `EndLine`), so large spills are typically unintended dumps.
- **Backwards Compatibility**: Tool return formats remain strings with clear text annotations when truncated.

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| `src/tools/tool-output-sanitizer.ts` | `sanitizeToolOutput` | Generalize spill-to-disk and truncation for all tool outputs |
| `src/agent/agent-loop.ts` | `AgentLoop` | Wire output sanitizer and track cache hit metrics |
| `src/llm/gemini.ts` | `toGeminiTools` | Deterministic tool ordering |
| `src/llm/anthropic.ts` | `toAnthropicTools` | Deterministic tool ordering |
| `src/llm/deepseek.ts` | `toDeepSeekTools` | Deterministic tool ordering |

## 11. Reusable Implementation Context

```json
{
  "task": "Integrate prefix caching preservation, deterministic tool ordering, universal tool spill-to-disk, and TTFT telemetry into MinusCLI Harness",
  "evidence_provenance": {
    "schema_version": 2,
    "head_commit": "040caf4f802d86e28edf9fab40cdaef1e445e812",
    "generated_plan_path": "docs/plans/2026-10-06-gitnexus-plan-latency-optimization-harness.md",
    "global_dirty_digest": {
      "algorithm": "sha256",
      "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
      "value": "42c5ab432f20d55b849df1afffadfd4a986789defc496251dbe3784a949fb32b"
    },
    "cited_path_manifest": [
      {
        "path": "src/agent/agent-loop.ts",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "unstaged",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:00f504a9a89c35b5800bfce80ee311df9404f18f663a685c15e20cf7ae7efcd3",
        "index_digest": "sha256:00f504a9a89c35b5800bfce80ee311df9404f18f663a685c15e20cf7ae7efcd3",
        "worktree_digest": "sha256:7b0f8f65bafcd4645216ee29b9bed4edcc8e5509632be50b3d7c242db85681a2",
        "untracked_digest": "absent"
      },
      {
        "path": "src/agent/context-compactor.ts",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:2b6f8f27696b793e888cd74f4255a5fa859f890f4660b1726ba6f8c9932849c9",
        "index_digest": "sha256:2b6f8f27696b793e888cd74f4255a5fa859f890f4660b1726ba6f8c9932849c9",
        "worktree_digest": "sha256:39e4bfc788573d08a864eb18a73da3fabe69e29a02d070453c457bc858aa951c",
        "untracked_digest": "absent"
      },
      {
        "path": "src/llm/anthropic.ts",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:1234c55e909b311fc8a511465d2f104c4bf75398aab2a0c73dc638fa2239cd6b",
        "index_digest": "sha256:1234c55e909b311fc8a511465d2f104c4bf75398aab2a0c73dc638fa2239cd6b",
        "worktree_digest": "sha256:625998f66a3ba73ae37cf13305d61946b87a05179aa3686b862b81b119a3b366",
        "untracked_digest": "absent"
      },
      {
        "path": "src/llm/deepseek.ts",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:0b6455b208eec0c988ec0a716ea3586ff1fcc4be3f581a00f5ad9ffc3beeac77",
        "index_digest": "sha256:0b6455b208eec0c988ec0a716ea3586ff1fcc4be3f581a00f5ad9ffc3beeac77",
        "worktree_digest": "sha256:c27c5e41bddecaedd1344a9a2eabe02bd8c2dabe2eca4351e24e0afab30f8a9f",
        "untracked_digest": "absent"
      },
      {
        "path": "src/llm/gemini.ts",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "unstaged",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:3e3679d2936f81d8604937b61c663b510983e69ab02c4cff2e60c8fafcb47bb4",
        "index_digest": "sha256:3e3679d2936f81d8604937b61c663b510983e69ab02c4cff2e60c8fafcb47bb4",
        "worktree_digest": "sha256:d8c76d70ac272c0391dd30e023f1d045dea6b1dc07d01e858f5253ba47717858",
        "untracked_digest": "absent"
      },
      {
        "path": "src/tools/terminal-sanitizer.ts",
        "object_kind": {
          "head": "regular",
          "index": "regular",
          "worktree": "regular",
          "untracked": "absent"
        },
        "state": "clean",
        "rename_from": null,
        "rename_to": null,
        "head_digest": "sha256:6afcbb8bca66e59f2e8c49b78a4d4147af9dda33cb85da2576c2c329459dbc6b",
        "index_digest": "sha256:6afcbb8bca66e59f2e8c49b78a4d4147af9dda33cb85da2576c2c329459dbc6b",
        "worktree_digest": "sha256:21fa1805987a93986014b1d435376e98e76ad1720f2121a5277380626d07c46c",
        "untracked_digest": "absent"
      }
    ]
  }
}
```

## 12. Assumptions and Open Questions

### Resolved Decisions (via `/grill-me` alignment):
1. **Spillover Threshold:** Default to 12KB (~3,000 tokens) with optional override via environment variable `MINUS_MAX_TOOL_OUTPUT_KB`.
2. **Spill Storage Location:** Store raw logs in `.minus/logs/tool_outputs/` (gitignored in workspace, consistent with `terminal-sanitizer`), with fallback to `os.tmpdir()` if workspace is not writable.
3. **Cache Telemetry Observability:** Display cache hit metrics per turn in the status/turn metadata line (e.g., `41.2k tok (85% cached) · 1.1s`) so developers and users immediately see cache efficacy.

## 13. Definition of Done

- Universal tool sanitizer intercepts and caps all tool outputs with spill-to-disk pointers.
- Tools are sorted deterministically across Gemini, Anthropic, and DeepSeek adapters.
- Cache hit counts are logged and visible in agent telemetry.
- All test suites pass cleanly.
