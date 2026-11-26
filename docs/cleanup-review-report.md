# Funscript cleanup review report

Date: 2026-11-26

## Scope and outcome

The review traced redundant code, compatibility paths, package entry points, tests,
and CI. The cleanup is present in the working tree and has not been committed.

- Fixed builds with `noDeepDestructure: true`: the internally injected option is
  no longer treated as a file path. Added CLI regression coverage.
- Removed CLI flag handling that public argument validation could never reach,
  while retaining the corresponding supported project configuration options.
- Removed unused trailing-binding AST metadata, two unused pipeline catalog
  constants, and unused internal parameters.
- Consolidated identical pipeline conformance fixture directories while retaining
  both test suites and their distinct assertions.
- Moved the editor-only `vscode-languageclient` root dependency to development
  dependencies. The VS Code extension keeps its own dependency declaration.
- Added example application integration tests to CI and removed an unused release
  workflow OIDC permission. Updated the related documentation.
- Updated stale example and timing-sensitive LSP test assertions.

## Breaking changes and migration

- Use `Effect.catch` or bare `catch` in place of `catchAll`, and
  `Effect.forkChild` or bare `forkChild` in place of the obsolete Effect `fork`
  spelling. Removed spellings produce diagnostics suggesting the replacement.
  Locally defined pipeline functions with those names remain supported.
- Replace the legacy `|> js` Effect runner with `|> runPromise`. Other `js`
  interop syntax remains supported.
- Eight duplicate package subpaths were removed. Their replacements are listed in
  [Package entry point migration](package-entrypoint-migration.md).
- The publicly exported parser AST no longer includes the unused optional
  `isTrailingBinding` field. External AST consumers should remove reliance on it.

These changes require an appropriate breaking release and communication to any
external consumers, despite the repository's pre-1.0 compatibility policy.

## Verification

- Passed: `npm run build`, `npm run lint`, `npm run fmt:ts:check`,
  `npm run fmt:check`, `npm run docs:check`, and the packed-package smoke test
  (`npm run package:check`, outside the sandbox).
- Passed: TypeScript checking with `--noUnusedLocals --noUnusedParameters`.
- Passed: focused compiler, pipeline catalog, LSP, reference documentation,
  package entry point, Zod interop, CLI configuration, parser, imported schema,
  and conformance tests. The REST example integration passed outside the sandbox;
  example application builds and SQLite compilation passed.
- A sandboxed full `npm test` run finished with 1,388 passed, one skipped, and
  58 failed. Several failures explicitly reported `spawnSync ... EPERM`; many
  other subprocess tests produced empty output or timed out under concurrent
  load. These results do not establish that all failures have the same cause.
- A full Vitest rerun outside the sandbox with two workers was still running when
  this report was written. Its final result is not yet available. The previously
  failing LSP suite passed in that rerun.
- The SQLite runtime test is skipped on the local Node 20 installation. A Node 24
  Vitest run returned empty CLI output although the same CLI command worked
  directly. CI uses Node 22.19, which was not available for local verification.

## Follow-up

Check the final outside-sandbox full-suite result and run the complete example
suite on the CI-supported Node version. Investigate any failures that persist
without sandbox process restrictions or excessive parallel load. Review the
breaking migration before publishing a release.
