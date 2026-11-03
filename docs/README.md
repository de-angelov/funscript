# Documentation map

## Current, verified documentation

Authors should use the [language syntax guide](syntax.md) as the current reference for
syntax accepted by the compiler. It describes implemented behavior and labels future
notes **Planned**, so they are not mistaken for syntax currently accepted by the compiler. The
[generated language catalogue](reference/language.md) serves LSP hover documentation and
is generated from the LSP documentation source; it is a concise, implementation-derived
catalogue rather than an independent syntax specification.

- [CLI reference](reference/cli.md) — generated from `src/cli/commands.ts`.
- [Package API](reference/api.md) — generated from `package.json` exports.
- [Language syntax guide](syntax.md) — implemented syntax reference for the current compiler.
- [Numeric comparison contributor walkthrough](language-change-journey.md) — implementation guide for contributors; `syntax.md` remains the authoritative language reference.
- [Language catalogue](reference/language.md) — generated LSP catalogue for hover help.
- [Runnable example inventory](reference/examples.md) — generated from applications built by `npm run test:examples`.
- [CI and release operations](ci-release.md) — operational workflow.
- [Tooling](tooling.md) and [toolchain](toolchain.md) — supported integration guidance.

## Proposals and historical reference

The remaining documents record design exploration, audits, or earlier language proposals. They
are useful context, but they are not the current implementation contract and their code fragments
are not validated as runnable examples. When they disagree with the current documentation, the
current verified documentation wins.

- `proposal.md`, `pit-of-success.md`, `rejected-syntax.md`
- `DOGFOODING.md`, `llm-first-audit.md`, `design-effect-comparison-functions.md`, `ast-spec.md`
- [TypeScript schema conversion decision survey](design-typescript-schema.md) — a proposal brief for a possible feature, not implemented behavior.
