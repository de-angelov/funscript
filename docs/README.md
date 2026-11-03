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

## Proposals and historical reference

The remaining documents record design exploration, audits, or earlier language proposals. They
are useful context, but they are not the current implementation contract and their code fragments
are not validated as runnable examples. When they disagree with the current documentation, the
current verified documentation wins.

- `proposal.md`, `pit-of-success.md`, `rejected-syntax.md`
- `DOGFOODING.md`, `llm-first-audit.md`, `design-effect-comparison-functions.md`, `ast-spec.md`
- [TypeScript schema conversion decision survey](design-typescript-schema.md) — a proposal brief for a possible feature, not implemented behavior.
