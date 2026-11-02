# Documentation map

## Current, verified documentation

The [syntax guide](syntax.md) describes the current language syntax. Generated language
and reference pages are implementation-derived catalogues; they summarize the released
toolchain rather than define syntax independently.

- [CLI reference](reference/cli.md) — generated from `src/cli/commands.ts`.
- [Package API](reference/api.md) — generated from `package.json` exports.
- [Language catalogue](reference/language.md) — generated from the LSP documentation source.
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
