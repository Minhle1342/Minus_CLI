# Citation-validated Repository Memory

Minus integrates AgentMemory as an optional semantic memory backend while keeping a local citation manifest as the authority for what may enter an LLM prompt.

## Data flow

1. Successful tool results are redacted, deduplicated, and appended to `.codingagent/repository-memory/observations.jsonl`.
2. Dream (`mistral/codestral-latest`) may promote patterns from durable session or Compose evidence.
3. A promoted or manually saved fact is accepted only when all citations can be replayed against the current repository.
4. Records are stored independently in `.codingagent/repository-memory/records.json` and optionally mirrored to AgentMemory.
5. Recall fuses local lexical rank with AgentMemory smart-search rank, then revalidates every local citation. Remote results without a matching local citation manifest are ignored.
6. Valid memories are injected into AgentLoop and used as additional query/file seeds for the graph-ranked repository map. Changed evidence marks a record `stale` and removes it from normal recall.

Supported citations are:

- `file`: workspace-safe path plus a SHA-256 hash, optionally for a line range.
- `session-event`: session id and event sequence, with optional event/tool/outcome constraints.
- `commit`: a Git commit object verified with `git cat-file` without a shell.
- `compose`: a completed Compose id, optionally locked to its spec hash.

## AgentMemory connection

Run AgentMemory separately and configure:

```env
AGENTMEMORY_URL=http://127.0.0.1:8000
AGENTMEMORY_SECRET=
```

If the endpoint is absent, unhealthy, or times out, local save/validation/recall continues normally. The bridge uses `POST /agentmemory/remember`, `POST /agentmemory/smart-search`, and `GET /agentmemory/health`.

## Agent tools

- `save_repository_memory`: saves a fact only with valid citations.
- `recall_repository_memory`: retrieves and revalidates relevant facts.
- `verify_repository_memory`: audits every citation for one record.

The older project/session/goal memory remains available for compatibility. Repository memory is a separate layer with a stricter admission and recall policy.
