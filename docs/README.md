# Documentation map

## Current, verified documentation

The [language syntax guide](syntax.md) is the authoritative reference for language rules
implemented by the current compiler. It also includes explicitly marked **Planned** material;
those sections describe future work, not accepted syntax. The [generated language catalogue](reference/language.md)
is the catalogue of editor hover documentation, generated from `src/lsp/docs.ts` and used
by the language server. It complements the syntax guide; it does not define implemented
language rules.

- [CLI reference](reference/cli.md) — generated from `src/cli/commands.ts`.
- [Package API](reference/api.md) — generated from `package.json` exports.
- [Language syntax guide](syntax.md) — authoritative guide to implemented syntax, with clearly marked planned material.
- [Numeric comparison contributor walkthrough](language-change-journey.md) — implementation guide for contributors; `syntax.md` remains the authoritative language reference.
- [Language catalogue](reference/language.md) — generated from the LSP documentation source and used for editor hover help.
- [Runnable example inventory](reference/examples.md) — generated from applications built by `npm run test:examples`.
- [CI and release operations](ci-release.md) — operational workflow.
- [Tooling](tooling.md) and [toolchain](toolchain.md) — supported integration guidance.
- [Language compatibility policy](compatibility.md) — adopted Strict Zero-Alias compatibility policy for Effect aliases, breaking syntax, and pipeline ambiguity.

## Authoritative sources and drift maintenance

To prevent documentation drift, documentation facts are categorized into generated references, automated code-asserted facts, and intentionally manual guidance:

| Documentation Section | Category | Authoritative Source | Automated Drift Protection |
| --- | --- | --- | --- |
| CLI commands & flags (`docs/reference/cli.md`) | Generated | `src/cli/commands.ts` (`CLI_COMMANDS`) | `npm run docs:check`, `tests/cli-help.test.ts` |
| Package entry points (`docs/reference/api.md`) | Generated | `package.json` (`exports`) | `npm run docs:check`, `tests/reference-docs.test.ts` |
| Hover language catalogue (`docs/reference/language.md`) | Generated | `src/lsp/docs.ts` (`DOC_CATALOG`) | `npm run docs:check`, `tests/lsp-docs.test.ts` |
| Example inventory (`docs/reference/examples.md`, `README.md`) | Generated | `examples/`, `programs/` files | `npm run docs:check`, `npm run test:examples` |
| Project facts (`README.md`) | Generated | `package.json` (`version`, `dependencies.effect`) | `npm run docs:check` |
| Lexer keywords (`docs/syntax.md#15-keywords`) | Code-asserted | `src/lexer/tokens.ts` (`KEYWORDS`) | `tests/reference-docs.test.ts`, `tests/lsp-docs.test.ts` |
| Pipeline companions (`docs/syntax.md#51`, `docs/compatibility.md#4`) | Code-asserted | `src/emitter/pipeline-catalog.ts` (`PIPELINE_COMPANION_CATALOG`) | `tests/reference-docs.test.ts` |
| Repository scripts (`docs/tooling.md#package-scripts`) | Code-asserted | `package.json` (`scripts`) | `tests/reference-docs.test.ts` |
| Language semantics & grammar (`docs/syntax.md`) | Manual | Verified compiler tests in `tests/` | Manual review / test suite |
| Compatibility & deprecation policy (`docs/compatibility.md`) | Manual | Human project decisions (TASK-102, TASK-104) | Manual review / Strict Zero-Alias invariant |
| Migration tooling (`docs/tooling.md#explicit-return-migration-decision`) | Manual | `src/tooling/migrate.ts` | Tested in `tests/migrate.test.ts` |
| Toolchain helper instructions (`docs/toolchain.md`) | Manual | `scripts/toolchain.{sh,ps1}` | Tested in `tests/toolchain.test.ts` |
| Benchmark baseline numbers (`docs/toolchain.md`) | Manual | Reference host runs (`AMD Ryzen AI 7 350`) | Host-dependent informational baselines |

### Maintenance workflow

1. When adding or altering CLI commands, update `src/cli/commands.ts`.
2. When adding or altering hover documentation, update `src/lsp/docs.ts`.
3. When adding runnable examples in `examples/` or `programs/`, or updating package metadata, run `npm run docs:generate`.
4. Run `npm run docs:check` to verify that generated documentation matches current code before committing.
5. Automated test suites (`tests/reference-docs.test.ts`, `tests/cli-help.test.ts`, `tests/lsp-docs.test.ts`) assert keyword counts, companion module names, and package scripts.

## Proposals and historical reference

The remaining documents record design exploration, audits, or earlier language proposals. They
are useful context, but they are not the current implementation contract and their code fragments
are not validated as runnable examples. When they disagree with the current documentation, the
current verified documentation wins.

- `proposal.md`, `pit-of-success.md`, `rejected-syntax.md`
- `DOGFOODING.md`, `llm-first-audit.md`, `design-effect-comparison-functions.md`, `ast-spec.md`
- [TypeScript schema conversion decision survey](design-typescript-schema.md) — historical decision brief preceding the implemented imported TypeScript schemas in [syntax.md](syntax.md#84-imported-typescript-schemas-schema-name--from-tstype).
