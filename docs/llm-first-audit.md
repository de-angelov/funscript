# LLM-first language and documentation audit

This audit records changes that reduce generated-code errors without changing the
language's behavior. The canonical authoring reference is `docs/syntax.md`; the CLI's
`funscript --help` and current compiler checks define the supported tool surface.

## Prioritized findings

### P0: Entry-point claims contradict the repository and CLI

The README described a future `packages/` layout and said the repository held only
design docs and examples, despite having a working compiler, CLI, formatter, Vite
plugin, LSP, and VS Code extension. A generated answer following that description could
send contributors looking for nonexistent package directories or assume implementation
work has not started.

Before: “The current repository contains the design docs and examples only.”

After: the README describes the actual `src/`, `editors/vscode/`, `tests/`, `docs/`, and
`examples/` directories and points to the implemented command list.

### P0: Featured examples teach a non-canonical function arrow

`examples/hello.fun`, `shapes.fun`, `todo-http.fun`, and `greeter-service.fun` use `->`;
the current reference and canonical examples use `=>`. The former Examples README
mentioned the canonical arrow but did not disclose that its featured code contradicted
it. LLMs commonly copy the nearest runnable example, so this is a direct syntax error
risk.

Before: “These files demonstrate FunScript features. The syntax reference uses `=>`.”

After: the examples index names the legacy spelling, tells authors to follow the syntax
reference, and gives check/format commands. Migrating the showcase programs is tracked
as a follow-up so a broad syntax rewrite can be verified independently.

### P1: Syntax reference and examples need a versioned consistency pass

The syntax reference is very large and documents compatibility forms alongside the
canonical forms. For example, it permits indentation-based effect blocks while
designating `effect { ... }` canonical. Combined with older example syntax, this creates
multiple plausible sources for generated code. Future updates should label compatibility
syntax directly at each entry and add a small canonical example set checked by the
compiler and formatter.

### P1: Separate authoring guidance from aspirational design

The proposal and pit-of-success document include planned or aspirational behavior, while
`docs/tooling.md` describes the implemented CLI. An LLM asked to implement a feature can
mistake a proposal table for an existing command or syntax guarantee. Preserve design
history, but mark each capability as implemented, planned, or rejected and link to the
implemented reference.

### P2: Reuse existing validation and editor tools

The project already relies on TypeScript for static checks, Prettier for formatting,
Vitest for tests, and the standard VS Code/LSP ecosystem. Keep these as the generated
code feedback loop instead of introducing a separate FunScript type checker or test
framework. The actionable guidance is `funscript check <file>`, `funscript fmt <file>
--check`, and then the project's normal TypeScript/Vitest commands. No new tooling is
recommended by this audit.

## Follow-up work

- **TASK-073 — Migrate canonical showcase examples**: update the four featured
  examples and index entries to current `=>` syntax; run their targeted example tests
  and formatter checks.
- **TASK-074 — Label implemented versus proposed language behavior**: audit `syntax.md`,
  `proposal.md`, and `pit-of-success.md` for stale or ambiguous status claims, add
  explicit status labels and cross-links, and record any behavior gaps as separate
  compiler tasks.

These follow-ups should preserve current compiler checks; examples must be corrected to
match the implementation rather than weakening checks to accept stale code.
