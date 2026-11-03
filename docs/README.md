# Documentation map

## Current, verified documentation

The [language syntax guide](syntax.md) mixes descriptions of syntax accepted by the
current compiler with explicitly marked **Planned** material. Check those labels before
treating a section as implemented behavior. The [generated language catalogue](reference/language.md)
is the editor documentation reference: it is generated from the LSP documentation source
and supplies language-server hover help.

- [CLI reference](reference/cli.md) — generated from `src/cli/commands.ts`.
- [Package API](reference/api.md) — generated from `package.json` exports.
- [Language syntax guide](syntax.md) — guide to implemented syntax and clearly marked planned material.
- [Numeric comparison contributor walkthrough](language-change-journey.md) — implementation guide for contributors; `syntax.md` remains the authoritative language reference.
- [Language catalogue](reference/language.md) — generated editor reference and LSP hover catalogue.
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
