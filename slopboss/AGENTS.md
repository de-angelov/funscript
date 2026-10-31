# AI Development Workflow

Common rules for all roles in this workflow.

## Repository Boundaries

- The orchestrator repository owns orchestration, logs, workflow instructions,
  and the coordination files below.
- The product repository is checked out separately under workspaces/repo-tl and
  workspaces/repo-agent-1..N.
- Inspect product work in the product workspace. Do not infer product merge,
  verification, or completion status from the orchestrator repository's history.

## Coordination Files

- BACKLOG.md: pending unassigned work.
- TASKS.md: live execution lanes only.
- ARCHIVE.md: completed work history.
- AGENTS.md: common workflow rules.
- DEV_AGENT.md: dev agent role rules.
- TEAM_LEAD_AGENT.md: team lead agent role rules.
- TECH.md: product technical standards and verification.
- CONFIG.md: slopboss configuration (base branch, etc.).

## Roles

Each agent session has exactly one active role selected by the orchestrator:

- Team Lead Agent
- Dev Agent 1
- Dev Agent 2

Do not change roles unless explicitly instructed.

## Task Format

Task metadata must use strict plaintext line prefixes. Do not use Markdown
bolding for metadata keys.

    ### Task Title Here

    Task ID: SHORT-01
    Owner: Dev Agent 1
    Branch: agent/1/branch-name
    Status: In Progress
    Blocked by: TASK-ID when Status is Blocked

    [Task scope, body, and progress notes go here]

Track meaningful project work only. Do not track formatting changes, temporary
debugging, exploratory edits, or routine commands.

## Board Lifecycle

    BACKLOG.md -> TASKS.md active lane -> ARCHIVE.md

- Pending assignable backlog tasks must use Status: Backlog. "Ready" is a
  readiness concept, not a valid backlog Status value.
- Backlog work becomes active when the Team Lead Agent moves it from BACKLOG.md
  into a dev-agent lane in TASKS.md.
- A dev-agent lane may contain at most one In Progress task. Blocked or rejected
  tasks in the lane do not count as active work and do not consume capacity; a
  lane with no In Progress task is available for new work.
- Verification failures outside the assigned task do not make that task Blocked.
  Note the failing command and path in the task, then continue. Blocked is
  reserved for genuine human input; record Blocked by: when a blocker exists.
- Completed tasks move to ARCHIVE.md with Status: Done and Completed: YYYY-MM-DD.
- Do not report a task as completed while it remains in TASKS.md.

## Structured Board Updates

Board lifecycle metadata is machine-owned. Before changing a task's owner,
status, category, dependencies, blocker, or location, inspect it with
`slopboss board get TASK-ID`; use `slopboss board set` for that change rather
than editing metadata lines by hand. The command returns JSON for exact,
machine-readable confirmation. Keep task objective, scope, acceptance criteria,
verification evidence, and progress notes as readable Markdown. A move must
specify both `--file` (`backlog`, `tasks`, or `archive`) and `--section`.

## Workspace Isolation

- Team Lead Agent workspace: workspaces/repo-tl
- Dev Agent 1 workspace: workspaces/repo-agent-1
- Dev Agent 2 workspace: workspaces/repo-agent-2

Development and merges occur only inside dev-agent workspaces. The Team Lead
Agent uses its workspace for planning and coordination checks only.

## Conflict Prevention

Assign non-overlapping work whenever practical. Separate work by foundations,
features, routes, services, and directories.

If another active task owns required files:

1. Stop immediately.
2. Document the dependency.
3. Request Team Lead Agent coordination.

## Instruction Priority

Instructions apply in this order:

1. User instructions
2. Core Principle: TypeScript Ecosystem Reuse & Simpler Implementation
3. Repository-specific instructions
4. AGENTS.md
5. Role-specific instructions
6. TECH.md
7. General engineering best practices

## Core Engineering Principle: Leverage Ecosystem & Keep It Simple

- Always look for existing npm packages in the TypeScript ecosystem before writing custom code.
- Never hand-roll custom infrastructure (e.g. VLQ encoders, custom JSON-RPC transports, doc engines).
- Prioritize simple, lean, readable solutions over deep bespoke architectures.
- Group related work into cohesive features rather than fractured micro-tasks.
