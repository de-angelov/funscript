# Backlog

## Awaiting Human Input


## Product Decisions

- UI runtime: **Solid only**. Do not evaluate or plan a React alternative.
- Second `.funx` showcase: deferred; do not spend further Team Lead tokens on it until requested.
- Tooling rule: reuse the TypeScript ecosystem first (TypeScript compiler/language-service APIs, `vscode-languageserver`, Vite, Vitest, Prettier-compatible interfaces, and established npm packages). New custom infrastructure needs a written reason why an existing tool cannot provide the capability.

## Team Lead Directive — Language Direction Cleanup

The language direction is Effect-oriented comparison functions; arrows retain their existing yield/return meaning. Do not add relational-operator syntax. Remove cancelled tasks and stale dependencies from the board. This is a board-only triage pass: do not modify product code. Afterward, resume triage of the remaining blocked tasks.

## Team Lead Directive — Post-Merge Grooming

Slopboss now refreshes `origin/main` before reconciliation. On the next grooming pass, use the freshly verified merge state to archive work already landed on main, remove its completed dependencies, keep only genuine verification failures blocked, and group the remaining backlog into the smallest ready, non-overlapping implementation tasks. Do not invent features or modify product code in this pass.

## Team Lead Directive — TASK-046 Unblock

TASK-046 is sample-only work and must not absorb compiler/emitter changes. Rebase its branch on current `origin/main` (which includes the callable tagged-error constructor), rerun its focused sample check, then classify any residual failures by owner: generated Effect import deduplication belongs with TASK-034; Mutative recipe typing belongs with TASK-040. Update TASK-046 to depend on only the still-real blockers and assign/release those existing tasks in dependency order. Do not create duplicate compiler tasks or modify product code in this triage pass.

## Next Team Lead Action

TASK-052 is complete. Resolve the recorded TASK-037 triage blocker before starting TASK-040; then follow the dependency order recorded in TASKS.md. Keep dependent tasks unassigned until their blockers are resolved.

## On Hold (Dogfooding Backup)

The dogfooding application tasks have been placed on hold and moved to backup (`BACKUP_DOGFOODING_TASKS.md`) while strictness, compiler type-checking gating, and runtime boundary validation are established.

- **TASK-028**: Real-World HTTP Microservice & REST Server Application (`programs/08-rest-api-server.fun`)
- **TASK-029**: SQLite Database & Repository Layer Application (`programs/09-sqlite-repository.fun`)

## Backlog

### VS Code Extension Product Experience

Task ID: TASK-058
Category: AFK
Owner: Unassigned
Branch: agent/1/task-058-vscode-product-experience
Status: Backlog
Dependencies: TASK-054, TASK-055, TASK-056, TASK-057
Blocking tasks: TASK-054, TASK-055, TASK-056, TASK-057

Objective: Turn the thin VS Code launcher into a polished FunScript editing experience.

Scope:
- Expose commands for check current file, format current file, restart language server, and open generated TypeScript.
- Add extension settings for server path and trace logging, plus clear setup/error messaging when the CLI is unavailable.
- Register recommended editor behavior: format on save, code actions, symbol navigation, and status/progress feedback for language-server readiness.
- Add user snippets for function declarations, Effect blocks, schemas, tagged unions, and typed holes.
- Write extension smoke tests around command registration and server configuration.

Out of Scope:
- Supporting non-VS-Code editors in this task.

Acceptance Criteria:
- A new user can install the extension, open a `.fun` file, and receive diagnostics, completion, formatting, navigation, and clear setup feedback.
- Extension commands fail gracefully when the FunScript CLI is missing.

Verification:
`npm run build && npx vitest run tests/lsp.test.ts --reporter=basic --no-color`

### Format canonical arrow syntax in showcase examples

Task ID: TASK-075
Category: AFK
Owner: Unassigned
Branch: agent/1/task-075-formatter-arrow-syntax
Status: Backlog
Dependencies: none
Blocking tasks: none

Objective: Make the formatter preserve the canonical => function syntax used by the migrated showcase examples. Scope: Update formatter emission and focused formatter coverage so canonical => arrows stay canonical; ensure the four showcase examples format cleanly. Out of Scope: Broad formatter redesign or unrelated legacy formatting failures. Acceptance Criteria: Formatting the canonical showcase examples does not rewrite => arrows to legacy -> syntax, and focused formatter/example verification passes. Verification: npx vitest run tests/formatter.test.ts tests/examples.test.ts --reporter=basic --no-color; npm run fmt:check.

### Add Type-Directed Abstract Function Resolution

Task ID: TASK-076
Category: AFK
Owner: Unassigned
Branch: none
Status: Backlog
Dependencies: none
Blocking tasks: none

Objective: Let FunScript resolve unqualified abstract functions from the type of the current pipeline value, reducing repetitive module qualification while preserving explicit and predictable function selection.

Scope:
- Implement pipeline resolution for abstract functions based on the static type entering each stage and the inferred type produced by the preceding stage. For example, (c: HttpClient) |> Afn |> Bfn resolves Afn and Bfn from the HTTP client abstraction and chains their result types.
- Apply the same mechanism to typed comparisons, including score |> lessThan(deadline), resolving against the static type of score and lowering supported types to matching Effect 4 APIs such as Number.isLessThan and DateTime.isLessThan.
- Define an explicit, deterministic association between types/abstractions and their exported functions. Handle missing, incompatible, or ambiguous matches with clear source-mapped diagnostics; preserve Module.function qualification as an escape hatch.
- Specify direct-call and pipeline argument ordering and ensure inferred output types feed resolution of subsequent stages.
- Update the grammar/resolution design, canonical syntax docs, examples, and agent instructions for the supported shorthand.

Out of Scope:
- Reintroducing relational operator syntax such as <, <=, >, or >=.
- Inventing new ordering semantics or changing Effect comparison behavior.
- Guessing function ownership from unrelated modules or silently resolving ambiguous functions.

Acceptance Criteria:
- (c: HttpClient) |> Afn |> Bfn resolves each function from the current abstraction and feeds each inferred result type into the next stage.
- score |> lessThan(deadline) resolves and lowers to the equivalent Effect 4 comparison; supported ordered types use their matching comparison functions and custom ordering is explicit.
- Direct and pipeline calls preserve argument order and inferred output types.
- Missing, incompatible, and ambiguous resolutions produce source-mapped diagnostics; explicit Module.function calls remain available.
- Formatter output, syntax reference, examples, and LLM-facing agent instructions consistently document the feature.

Regression tests:
- Compiler/emitter: numeric and date comparisons lower to the correct Effect 4 module member with the piped value in the correct argument position.
- Compiler/emitter: a custom `HttpClient` abstraction resolves two successive bare stages, and the first stage's output type selects the second stage's module.
- Type checker: overloaded/pipeable functions resolve only when their data-last signature accepts the current value; an incompatible input fails with a source-mapped diagnostic.
- Name resolution: local and explicitly imported functions shadow shorthand; ambiguous companion matches diagnose and qualified calls still compile.
- Pipeline semantics: direct and piped forms agree on argument order and result type, including calls with explicit arguments.
- LSP/formatter: resolved references and formatted short-form pipelines remain stable, and diagnostics point to the unresolved stage.

Verification:
Run focused abstract-function resolution compiler/type-checker, formatter, and LSP checks, then the repository verification workflow. Record exact commands and results in task notes.
