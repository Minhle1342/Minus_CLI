# Multi-Agent Integration & Optimization Implementation Plan

## Overview
Transform hierarchical `SubagentManager` delegation into a decoupled Peer-to-Peer Multi-Agent system with a central Orchestrator, Event Bus, Shared Context (OCC), and Coordinated Multi-Agent Performance Optimization (`agent-orchestration-multi-agent-optimize`).

## Atomic Tasks

### Phase 1: Foundation (Orchestration & Discovery)
- [x] Task 1.1: Initialize `AgentOrchestrator` service with multi-factor workload balancing.
- [x] Task 1.2: Extend `AgentRegistry` for capability advertisement, metadata, and task workload tracking.

### Phase 2: Communication Infrastructure
- [x] Task 2.1: Create `AgentEventBus` for agent-to-agent messaging with topic wildcards and ring buffer history.

### Phase 3: Context & Synchronization
- [x] Task 3.1: Implement `SharedContextService` multi-tiered key-value store.
- [x] Task 3.2: Implement basic optimistic concurrency control based on existing file hashes (OCC) for shared data.

### Phase 4: Benchmark Subagents & Tooling Integration
- [x] Task 4.1: Register 5 Top-Benchmark specialized subagents into `AgentRegistry` (`src/agent/benchmark-agents.ts`).
- [x] Task 4.2: Add `allocate_agent_task` tool with priority, cost-efficiency, and memoization options.
- [x] Task 4.3: Add CLI `/agents` and `/explore agents` monitoring commands.

### Phase 5: Multi-Agent Performance Optimization
- [x] Task 5.1: Performance Profiling & Bottleneck Tracking (`AgentPerformanceTracker`).
- [x] Task 5.2: Workload Distribution & Dynamic Weighted Scoring in `AgentOrchestrator`.
- [x] Task 5.3: Cost-Aware Routing (`preferCostEfficient`) & Result Memoization cache.
- [x] Task 5.4: Comprehensive Integration & Optimization Testing (Section 42, 43, 44 in `src/test-suite.ts`).
