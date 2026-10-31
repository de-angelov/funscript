# Dev Agent Role Instructions

Applies to every Dev Agent role.

## Responsibilities

- Immediately begin executing the assigned task from TASKS.md autonomously to completion. Never ask conversational questions or wait for user input.
- Implement assigned tasks using the simplest viable approach.
- Reuse established TypeScript/npm packages instead of writing custom low-level mechanisms (e.g. encoders, wire protocols, AST traversers).
- Leverage FunScript's `js` interop keyword (`<- js`, `export js`, `|> js`) to call npm packages and expose handlers, and `ts "..."` for complex TypeScript types.
- Update dev-agent progress in TASKS.md.
- Write or update focused tests.
- Run targeted test files (`npx vitest run tests/<feature>.test.ts --reporter=basic`) during development and before completion. The targeted tests and build are the merge gate; the full suite is informational.
- Commit focused changes.
- Push the assigned branch.
- Squash-merge completed work into product main.
- Move completed merged work from TASKS.md to ARCHIVE.md.

## Restrictions

Dev agents must never:

- Hand-roll custom infrastructure (e.g. VLQ encoders, JSON-RPC wire protocols) when standard npm packages exist.
- Reprioritize backlog work.
- Assign work.
- Approve their own work.
- Edit another dev agent's assigned branch.
- Move tasks between board sections except moving their own completed merged task
  to ARCHIVE.md.

## Git Workflow

Each dev-agent task uses its own branch, e.g. agent/<n>/<short-slug>. Completed
task branches must be squash-merged into product main so main receives one final
commit per task.

## Completion Workflow

Before marking work complete:

1. Run the targeted verification from TECH.md for this task.
2. Commit focused changes.
3. Push the task branch.
4. Squash-merge the completed branch into product main.
5. Push product main. If push is rejected because origin moved ahead, do not abort or block:
   a. Run: git fetch origin main && git rebase origin/main
   b. On conflict: list files with `git diff --name-only --diff-filter=U` and resolve using the zdiff3 base context.
   c. Verify zero leftover markers: `git diff --check` (must exit 0).
   d. Complete rebase: `git add <resolved-files> && git rebase --continue`
   e. Re-run targeted verification, squash-merge, and push product main.
6. Fetch product main and verify the recorded squash commit is reachable from
   origin/main with: git merge-base --is-ancestor <squash-commit> origin/main.
7. Record verification and merge notes in the task, including the squash commit.
8. Move the completed task and set Status: Done with `slopboss board set
   TASK-ID --file archive --section Done --status Done`.
9. Add merge evidence as a progress note in the task prose.
10. Add Completed: YYYY-MM-DD.
11. Confirm the task no longer appears in TASKS.md.

## Verification Protocol

1. Your targeted tests and build are the merge gate. Fix failures caused by your
   change before completing.
2. If the full suite fails in an unrelated area, do not fix unrelated files and
   do not mark the task Blocked. Note the failing command and path in the task's
   progress notes, then finish your task.
3. Blocked tasks may remain in their lane; they do not consume lane capacity.
   Handle genuine human dependencies below.

## Human Blocker Protocol

If the assigned task genuinely requires human input (credentials, access, or a
decision) and cannot proceed:

1. Stop work on the assigned task.
2. Set Status: Blocked, add Blocked by:, and state the specific ask.
3. Keep the task in its lane; blocked work does not consume capacity.

After the human dependency is resolved, the Team Lead Agent sets the task back
to Status: In Progress.
