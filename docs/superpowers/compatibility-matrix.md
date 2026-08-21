# Superpowers Compatibility Matrix

| Skill ID | Version | Status | Required Capabilities | Approval Gate |
|---|---|---|---|---|
| `using-superpowers` | 1.0.0 | ✅ Full | `filesystem.read`, `plan.update` | No |
| `brainstorming` | 1.0.0 | ✅ Full | `filesystem.read`, `plan.update` | No |
| `writing-plans` | 1.0.0 | ✅ Full | `plan.update`, `filesystem.read` | No |
| `using-git-worktrees` | 1.0.0 | ✅ Full | `worktree.create`, `worktree.list`, `worktree.remove` | No |
| `test-driven-development` | 1.0.0 | ✅ Full | `filesystem.read`, `filesystem.edit`, `shell.verify` | Enforced Verification |
| `subagent-driven-development` | 1.0.0 | ✅ Full | `agent.spawn`, `agent.wait`, `agent.review` | Review Gate |
| `requesting-code-review` | 1.0.0 | ✅ Full | `git.diff`, `review.request` | No |
| `finishing-a-development-branch` | 1.0.0 | ✅ Full | `git.status`, `git.commit`, `worktree.remove`, `shell.verify` | Commit Approval |

## Supported Superpowers Tools vs Native Capabilities

| Codex / Superpowers Concept | Native CodingAssistant Mapping | Safety Policy |
|---|---|---|
| `git worktree add/remove` | `create_worktree`, `remove_worktree` | Path contained to `.codingagent/worktrees` |
| `spawn_subagent` | `spawn_agent` | Clean context, timeout bounded |
| `wait_subagent` | `wait_agent` | Synchronous event-driven, zero polling |
| `request_review` | `request_review` | Spec & Quality verdict required |
| `submit_review` | `submit_review` | Durable audit log in session |
| `request_approval` | `request_approval` | Operator confirmation checkpoint |
