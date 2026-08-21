# Superpowers Integration Guide

## 1. Overview

This document details the architectural integration of **Superpowers** (`obra/superpowers`) methodology into the Coding Assistant.

Unlike conventional implementations that attempt to translate raw markdown instructions into executable LLM tools, our architecture establishes a clean separation of concerns:

- **Skills as Contextual Instructions:** Markdown skills are discovered, validated, and injected into the system prompt deterministically by the `SkillActivator`.
- **Capabilities as Explicit Adapters:** All actions named or requested by skills are mapped to formal, policy-checked entries in the `CapabilityCatalog`.
- **Safety & Review Gates:** Mutating operations require worktree isolation, approval checkpoints, spec-compliance reviews, and automated verification before final completion.

---

## 2. Core Components

### 2.1 Skill Registry & Loader (`src/skills/`)
- **`SkillLoader`**: Safely parses YAML frontmatter from `SKILL.md` files without using `eval()`, validates path traversal constraints, and computes content SHA-256 hashes.
- **`SkillRegistry`**: Manages installed skills, checks for duplicate IDs, and queries skills by tags, intents, or capabilities.
- **`SkillActivator`**: Deterministically evaluates active skills per turn, resolving dependency chains (`requires`) and mutual exclusivity (`conflicts`).

### 2.2 Capability Catalog & Policy (`src/capabilities/`)
- **`CapabilityCatalog`**: Central registry of operations declaring category, side-effect scope, reversibility, retryability, and approval requirements.
- **`CapabilityPolicy`**: Enforces runtime security boundaries, blocking unapproved mutations in read-only scopes and triggering operator approval for high-risk actions.

### 2.3 Worktrees & Isolation (`src/workspace/worktree-manager.ts`)
- Provides safe, sandboxed Git worktree creation under `.codingagent/worktrees/` to prevent contamination of the main branch during feature development.

### 2.4 Subagent Lifecycle & Review Gates (`src/agent/`)
- **`SubagentManager`**: Supports clean-context subagent spawning (`spawn_agent`), synchronous non-polling wait (`wait_agent`), cancellation, and recovery across restarts.
- **`ReviewManager`**: Enforces spec-compliance and architecture/quality reviews before marking tasks completed.
- **`VerificationPolicy`**: Enforces the *verification-before-completion* contract, preventing premature final answers if code modifications have not passed automated test suites.

---

## 3. Operator CLI Diagnostics

| Command | Purpose |
|---|---|
| `/skills` | List all installed and active Superpowers skills |
| `/skills inspect <id>` | View manifest, requirements, hash, and path for a skill |
| `/capabilities` | Inspect declared system capabilities and safety policies |
| `/approvals` | View pending operator approval requests |
| `/approvals approve <id>` | Grant operator approval for a pending action |
| `/approvals reject <id>` | Reject a pending action with a reason |
