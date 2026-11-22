# FunScript tooling review: what to improve next

**Status:** Review snapshot, not an implementation contract. The recommendations below describe
gaps and candidate work; they do not define current language or CLI behavior.

**Reviewed:** `/root/funscript` at commit `348d686` (package `0.2.3`), 2026-11-22.

**Scope:** Project workflow, CLI, formatter, diagnostics, LSP, documentation generation,
incremental builds, and developer onboarding. Language semantics and runtime behavior are out of
scope except where they affect tooling.

**Secondary checkout:** `/root/funscript-pipeline` is a shallow clone at `887868a`, five commits
behind the main checkout, with an uncommitted `src/tooling/pipeline-style.ts`. It is not a separate
project. If it is intentional, convert it to a Git worktree; otherwise remove it to avoid reviewing
or building stale code.

---

## Executive summary

FunScript's **language tooling is already strong**. The compiler has spans, source maps, stable
diagnostic codes, explanations, and suggested fixes. The LSP covers diagnostics, hover,
completion, definition, references, rename, and formatting. The formatter has a Prettier plugin.
Project policies (`noTs`, `noGlobalThis`, `noOptional`, `barePipelines`, `effectOnly`) are ahead
of most young languages. Incremental watch builds, benchmarks, conformance tests, and a package
smoke test are in place.

The weak layer is **project tooling**. Today `funscript` is a file-oriented compiler CLI. Elixir
and Gleam are project-oriented toolchains: they scaffold, format, test, document, and build a
project as a unit. FunScript already documents the right target in
[`pit-of-success.md`](pit-of-success.md) §3 and [`proposal.md`](proposal.md) §7: `new`, `dev`,
`build`, `preview`, `test`, `check`, `fmt`, `run`, `add`, and `doctor`. Finishing that design is
the highest-leverage work.

The most urgent fixes are not new language features. They are:

1. Make `build` and `run` understand the local module graph.
2. Preserve relative output paths and fail on collisions.
3. Make version, help, and flag parsing a single contract.
4. Load one project config from every entry point.
5. Make diagnostics consumable by CI (`--json`, `--sarif`, `--warnings-as-errors`, `--explain`).
6. Add project-wide `fmt`, `doctor`, and `clean`.
7. Add `new` and `test`, the two biggest onboarding gaps.

---

## What is already strong

- **Compiler diagnostics:** `TypeCheckDiagnostic` carries `diagnosticCode`, `explanation`,
  `suggestedAction`, `category`, `code`, and a source frame. The diagnostics table in
  [`syntax.md`](syntax.md) documents many `FS_*` codes.
- **Source maps and spans:** every AST node carries a span, and emitted TypeScript is mapped back
  to `.fun`/`.funx` for diagnostics and stack traces.
- **LSP:** diagnostics, hover, completion, definition, references, prepare-rename, rename,
  document/workspace symbols, formatting, and two pipeline-style code actions.
- **Formatter:** canonical printer plus a Prettier plugin; format-on-save defaults in the VS Code
  extension.
- **Project policies:** `funscript.config.fun` supports `noTs`, `noGlobalThis`, `noOptional`,
  `barePipelines`, `effectOnly`, and formatter width/indent settings.
- **Incremental builds:** `funscript build --watch` uses an `IncrementalBuildSession`, package
  fingerprints, and dependency keys.
- **Verification:** conformance/golden fixtures, example-app builds, language-contract tests,
  generated reference docs, a CI gate, and a packed-consumer smoke test.
- **Real consumers:** `country-rank2` uses the Vite plugin and `funscript tsc` in a React Router
  app; `slopboss2` uses `funscript check`, `funscript build`, and `funscript.json` entry modules.

This foundation is better than most young languages have. The recommendations below are about
finishing the toolchain, not repairing the compiler.

---

## P0 — correctness and trust

### 1. `build` and `run` do not understand the module graph

**Evidence.** `check` follows local imports through `collectCliFiles`
(`src/cli/typecheck.ts`), but `build` and `run` do not.

```sh
# src/lib.fun is imported by src/main.fun, but only main.ts is emitted.
funscript build src/main.fun --outDir out
# ✓ Built out/main.ts

# run copies only the entry file into .funscript-cache.
funscript run src/main.fun
# ERR_MODULE_NOT_FOUND ... .funscript-cache/lib.js
```

**Why it matters.** A project tool must compile the project graph. `gleam build` and `mix compile`
do this. FunScript's current behavior works only for single-file programs or for directory builds
that happen to include every local file.

**Recommendation.**

- Reuse `collectCliFiles` (or a shared graph collector) in `build` and `run`.
- Emit every reachable `.fun`/`.funx` file, not just the entry file.
- For `run`, use the Vite/Bun loader or bundle with esbuild into a temporary directory with source
  maps, so relative imports resolve.
- Pass program arguments after `--`: `funscript run src/main.fun -- arg1 arg2`.

### 2. `--outDir` flattens paths and silently overwrites

**Evidence.** `src/cli/index.ts` computes `path.basename(filePath, path.extname(filePath))`, so
two files with the same basename collide.

```sh
funscript build src/a/main.fun src/b/main.fun --outDir out --no-check
# ✓ Built out/main.ts
# ✓ Built out/main.ts   # second silently wins
```

**Why it matters.** Real layouts have `src/cli/main.fun` and `src/orchestrator/main.fun`. Flattening
also makes consumer layouts like `slopboss2`'s `src/cli` + `src/orchestrator` imports
unrepresentable in `dist/`. Watch mode already detects collisions (`src/cli/build-watch.ts`);
non-watch mode should behave the same way.

**Recommendation.**

- Compute output paths relative to a source root: `src/a/main.fun` → `dist/a/main.ts`.
- Detect duplicate destinations before writing and fail with the list of conflicting inputs.
- Align watch mode and one-shot builds on the same layout function.

### 3. Inconsistent output defaults

**Evidence.** Non-watch `build` writes `.ts` next to `.fun`; watch mode defaults to `dist/`
(`src/cli/index.ts`). The design docs say output is `dist/`.

**Why it matters.** Generated TypeScript in the source tree pollutes the repository, can be picked
up by `--no-ts` audits, and differs between `build` and `build --watch`.

**Recommendation.** Default one-shot `build` to `dist/`; keep `emit` as the file-level
stdout/next-to-source command. If backward compatibility matters, add `--outDir .` explicitly.

### 4. Version, help, and flags are not a single contract

**Evidence.**

```sh
funscript --version
# funscript 0.1.0        # package.json is 0.2.3

funscript help fmt
# prints global help, not fmt help

funscript check file.fun --json
# --json is silently ignored
```

The hardcoded `0.1.0` appears in `src/cli/index.ts`, `src/cli/repl.ts`, and `src/lsp/server.ts`.
Flag parsing is ad hoc: unknown flags are sometimes ignored (`check`) and sometimes treated as file
paths (`build`).

**Why it matters.** A toolchain should have one source of truth for its version, help text, and
flags. Elixir/Mix and Gleam expose a typed command surface; FunScript should too.

**Recommendation.**

- Generate a version constant from `package.json` at build time, or read it once at runtime.
- Put flag specifications in `src/cli/commands.ts` next to `CLI_COMMANDS`, and parse once.
- Support `funscript help <command>` and `funscript <command> --help`.
- Reject unknown flags with a non-zero exit code and a suggestion.
- Support `--` to separate command flags from program arguments.

### 5. Project config is split and not applied everywhere

**Evidence.** There are two config surfaces:

- `funscript.config.fun` for policies and formatting (`src/compiler/project-config.ts`).
- `funscript.json` for `entry` modules (`src/compiler/check.ts`).

`docs/tooling.md` documents only the first. It also states that `tsc`, the REPL, and the language
server do not load project policy. Consumer `slopboss2` already uses `funscript.json` for entry
modules.

**Why it matters.** The editor, CLI, and CI can disagree about `noTs`/`effectOnly`, which undermines
the "same errors everywhere" guarantee that Elixir/Gleam users expect.

**Recommendation.**

- Merge `entry` into `funscript.config.fun` (or support both through one validated schema and
  deprecate `funscript.json`).
- Load the config from every entry point: `check`, `build`, `emit`, `run`, `tsc`, the REPL, and the
  LSP.
- Add project metadata needed by the toolchain: `source`, `outDir`, `entry`, `test`, `docs`,
  `include`, `exclude`.
- Validate a FunScript compiler version range at startup, analogous to `gleam.toml`'s compiler
  requirement or `mix.exs`'s Elixir requirement.
- Reload config when `funscript.config.fun` changes in the editor.

### 6. Diagnostics are rich but not CI-native

**Evidence.** `TypeCheckDiagnostic` already has `diagnosticCode`, `explanation`,
`suggestedAction`, `category`, and `frame`, but the CLI prints only `formattedOutput`. Warnings are
counted and `success` is `errorCount === 0`, so warnings never fail `check`.

**Why it matters.** CI, code scanning, and editors need machine-readable output. Elixir and Gleam
treat compiler warnings as first-class and make them actionable in CI.

**Recommendation.**

- Add `funscript check --json` with a stable schema:
  `{ file, line, column, endLine, endColumn, severity, code, message, explanation, help }`.
- Add `--sarif` for GitHub code scanning and other CI consumers.
- Add `--warnings-as-errors` and `--max-warnings N`.
- Add `--explain FS_NESTED_EFFECT` backed by a generated diagnostics registry.
- Add `--quiet`, `--no-color`, and `NO_COLOR` support.

---

## P1 — onboarding and the daily loop

### 7. No scaffolding

`funscript new` and `funscript init` are missing. This is the biggest onboarding gap versus
`mix new` and `gleam new`.

**Recommendation.**

- `funscript new <name>` with templates for an app, a library, and a CLI.
- Generate a normal project: `package.json`, `tsconfig.json` (strict), `vite.config.ts` with the
  FunScript plugin, `funscript.config.fun`, `src/main.fun`, `tests/main.test.fun`, `.gitignore`,
  README, and a CI workflow.
- Include a passing test and a `main` that works with `funscript run`/`funscript dev`.
- `funscript init` adds the same integration to an existing project without overwriting files;
  require `--force` for replacements.

### 8. No first-class test story

There is no `funscript test`, no `*.test.fun` discovery, and no doctests. Elixir's `mix test` and
`doctest`, and Gleam's `gleam test`, make testing part of the language workflow.

**Recommendation.**

- Add `funscript test` as a thin wrapper around Vitest using the same Vite plugin as the app.
- Discover `**/*.test.fun` and `**/*.test.funx`.
- Publish a `funscript/vitest` preset so projects can run Vitest directly.
- Pass through Vitest flags: `--run`, `--watch`, `--coverage`, `--update`, filters.
- Typecheck tests by default; `--no-check` skips.
- Add doctests: extract fenced `funscript` examples from `///` documentation and run them with
  `--doctest`.

### 9. `fmt` is not project-wide

`funscript fmt examples` fails with `EISDIR`; there is no `--stdin` or `--diff`; and
`package.json`'s `fmt:check` hardcodes every file.

**Recommendation.**

- Accept files, directories, and globs.
- Add `--check`, `--diff`, `--stdin`, and `--stdin-filepath`.
- Exclude `node_modules`, `.git`, build output, and generated type views.
- Replace the hardcoded `fmt:check` list with `funscript fmt --check src examples tests` (after
  directory support).
- Decide whether the formatter remains configurable. The design docs say "no config"; the current
  implementation supports `indentSize` and `lineWidth`. Either remove the config or document the
  deviation as intentional.

### 10. No `doctor` or `clean`

**Recommendation.**

- `funscript doctor` checks Node/package-manager versions, `type: module`, Effect/TypeScript
  versions, tsconfig strictness and module resolution, Vite plugin registration, config validity,
  duplicate `.fun`/`.funx` stems, stale `.funscript/types`, and missing dependencies.
- Support `--json` for automation and exit non-zero on errors.
- `funscript clean` removes `.funscript`, `.funscript-cache`, and configured build output. Never
  delete source.

### 11. `build`, `dev`, `preview`, and `add` are misaligned with the design docs

The proposal says `funscript build` is a Vite production build, and `dev`/`preview` are Vite
delegates. Today `build` is really "emit TypeScript."

**Recommendation.**

- `emit` — file-level TypeScript output (current behavior).
- `build` — `check` plus Vite production build; `--target node` for Node/library mode.
- `dev` — Vite dev server plus a typecheck watcher.
- `preview` — Vite preview.
- `add` — delegate to npm/pnpm/Bun; no new registry or lockfile.

This is the Go/Gleam-style "one command per concern" design already described in
[`pit-of-success.md`](pit-of-success.md) §3.2–3.6.

---

## P2 — ecosystem polish

### 12. LSP quick fixes and richer language features

Today code actions are only "Format document" and pipeline-style conversion
(`src/lsp/server.ts`). Add:

- Diagnostic-driven quick fixes: wrap in `mut`, add `<-`, bound concurrency, add missing import,
  remove unused import, organize imports.
- `textDocument/signatureHelp` for functions and pipeline stages.
- Inlay hints for inferred types.
- Folding ranges, selection ranges, document highlights, and semantic tokens.
- Incremental text sync instead of full-document sync.
- Config reload when `funscript.config.fun` changes.
- `workspace/executeCommand` for editor commands such as check-file and format-file.

### 13. User-facing documentation generation

`docs:generate` builds internal reference pages only. There is no `funscript docs` for library
authors.

**Recommendation.**

- `funscript docs` renders Markdown/HTML from `///` comments, exports, and examples.
- `funscript docs --check` fails on undocumented public exports.
- Generate `docs/reference/diagnostics.md` from the diagnostic registry.
- Link diagnostic codes in CLI output to their explanations.
- Run doctests in CI.

This is the ExDoc / `gleam docs build` equivalent.

### 14. Persistent incremental cache and faster watch

Watch mode reuses an `IncrementalBuildSession`, but one-shot `check`/`build` do not reuse a cache.
Pipeline checks can take roughly a second per file because of the TypeScript context.

**Recommendation.**

- Add a persistent cache keyed by source hash, tsconfig, package fingerprint, and compiler version.
- Reuse the TypeScript program/context across files in one invocation.
- Replace the 2-second polling loop with `fs.watch`/chokidar plus a polling fallback.
- Aim for sub-100 ms no-op checks and sub-200 ms watch rebuilds on small projects.

### 15. Unify typechecking

Consumer `country-rank2` uses `funscript tsc` because React Router type generation matters; other
users use `funscript check`. These are two paths that can disagree.

**Recommendation.**

- Make `funscript check` use the generated type view when the project config requires it, or
- Add `funscript tsc --watch` with continuous diagnostic mapping.
- Document clearly when to use `check` versus `tsc`, and make the LSP use the same engine.

### 16. Internal tooling

- Extract command implementations from the 560-line `src/cli/index.ts` into typed
  `src/cli/commands/<name>.ts` modules with a shared `Command` interface.
- Replace the multiple ad-hoc AST walkers in `check.ts`, `idiomatic.ts`, and `emitter.ts` with a
  shared typed visitor.
- Add property-based parser/formatter round-trip tests.
- Add shell completions (bash, zsh, fish, PowerShell) generated from the command catalogue.
- Add editor setup docs for Neovim, Helix, Emacs, and Zed; consider a tree-sitter grammar.

---

## Practices to copy from Elixir and Gleam

| Concern   | Elixir / Mix                          | Gleam                       | FunScript recommendation                      |
| --------- | ------------------------------------- | --------------------------- | --------------------------------------------- |
| Scaffold  | `mix new`                             | `gleam new`                 | `funscript new` and `init`                    |
| Format    | `mix format --check-formatted`, stdin | project-wide `gleam format` | project-wide `fmt`, `--stdin`, `--diff`       |
| Test      | `mix test`, `doctest`                 | `gleam test`                | `funscript test` plus doctests                |
| Typecheck | `mix compile --warnings-as-errors`    | compiler warnings           | `check --warnings-as-errors`, JSON/SARIF      |
| Docs      | `mix docs` / ExDoc                    | `gleam docs build`          | `funscript docs` from `///`                   |
| REPL      | `iex -S mix`                          | Gleam REPL                  | project-aware `repl` with `:doc` and `:type`  |
| Lint/fix  | Credo, `mix xref`, Dialyzer           | `gleam fix`                 | `funscript lint`/`fix`, `--explain`           |
| Config    | `mix.exs`, `.formatter.exs`           | `gleam.toml`                | one `funscript.config.fun`, loaded everywhere |
| Deps      | Hex, `mix deps`                       | `gleam add`, `gleam deps`   | delegate to npm; `doctor` validates           |
| Release   | `mix release`                         | `gleam export`              | Vite/`build --target node`, package check     |

### What not to copy

- Do not build a package registry or a new lockfile format. npm/pnpm/Bun is the ecosystem.
- Do not build a separate test framework. Wrap Vitest.
- Do not add a runtime. Emitted TypeScript is the product.
- Do not add a Mix-style arbitrary task framework. Keep the CLI small and composable.
- Do not add more formatter configuration unless there is a demonstrated need.

---

## Suggested roadmap

### First slice (P0)

1. Version, help, and flag contract.
2. Graph-aware `build` with relative output paths, collision detection, and `dist/` default.
3. Graph-aware `run` with a loader or bundler and `--` argument passthrough.
4. Project-wide `fmt` with `--check`, `--stdin`, and `--diff`; replace the hardcoded `fmt:check`.
5. `check --json`, `--sarif`, `--warnings-as-errors`, and `--explain`.
6. `doctor` and `clean`.

**Acceptance criteria.**

- `funscript build src` emits `dist/**` preserving directory structure; no silent collisions;
  imports resolve.
- `funscript run src/main.fun -- arg` works across local modules.
- `funscript fmt --check .` works in CI.
- `funscript check --json` emits valid JSON; `--warnings-as-errors` fails on warnings.
- `funscript --version` matches `package.json`; `funscript help fmt` shows `fmt` help.
- `funscript doctor` catches a missing Vite plugin or config mismatch.

### Next milestone (P1)

7. `funscript new` and `init`.
8. `funscript test` with `.fun` discovery and doctests.
9. `dev`, `preview`, `build`, and `add` aligned with the Vite-first design.
10. Config unification and LSP/REPL/`tsc` parity.

### Later (P2)

11. LSP quick fixes and richer language features.
12. `funscript docs` and diagnostics documentation.
13. Persistent incremental cache and faster watch.
14. Typechecking unification and internal CLI/AST tooling.

---

## Appendix: consumer observations

- `slopboss2` uses `funscript.json` for `entry` modules and a custom purity script. Its build
  lists three files explicitly and flattens them into `dist/`, which cannot represent its
  `src/cli` + `src/orchestrator` imports. This is a concrete case for graph-aware builds and
  preserved output paths.
- `country-rank2` uses the Vite plugin and `funscript tsc` in a React Router app. It has a custom
  `scripts/check-idiomatic-funscript.mjs` because it needs a fast, lexer-only idiomatic audit
  separate from full typechecking. This is a case for a standalone `funscript lint` with rule
  selection and `--json`.
- Both consumers work around missing project commands with npm scripts and custom files. A
  first-class project CLI would remove that duplication.

---

## Related documents

- [`pit-of-success.md`](pit-of-success.md) §3 — the intended Go-like developer experience.
- [`proposal.md`](proposal.md) §7 — the original tooling design and defaults.
- [`tooling.md`](tooling.md) — current CLI usage and policies.
- [`toolchain.md`](toolchain.md) — optional developer toolchain helper and benchmarks.
- [`syntax.md`](syntax.md) — authoritative language reference and diagnostics table.
