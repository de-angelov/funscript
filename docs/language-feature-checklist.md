# Language feature checklist

Use this checklist for new syntax and changes to existing language behavior.
See [language change journey](language-change-journey.md) for the implementation map.

- [ ] Describe the user-visible behavior, including important boundaries and error cases.
- [ ] Update the relevant lexer, parser, AST, compiler, emitter, formatter, and editor tooling where applicable.
- [ ] Add a complete, representative `.fun` or `.funx` example under `tests/fixtures/language-contracts/`.
- [ ] Add an entry in `tests/fixtures/language-contracts/catalog.json` with a unique ID, title, description, example file, relevant lexer token values, and runtime behavior expectations. The contract test must compile and execute the example and assert its result.
- [ ] For a token already in `legacyTokens`, remove it from that list when the contract covers it. Do not add new public syntax to the legacy baseline. A contract's listed tokens must actually occur in its example.
- [ ] Add focused tests for behavior the example cannot cover, such as invalid inputs, diagnostics, formatting, type checking, and source locations. Existing tokens can acquire new behavior without triggering the token inventory check, so add or update a contract for semantic changes too.
- [ ] Update the syntax guide and editor hover metadata when their descriptions change. The generated [tested examples](reference/tested-examples.md) use the exact source from the contract; do not edit that page directly.
- [ ] Run `npm run docs:generate`, `npm run docs:check`, and `npx vitest run tests/language-contracts.test.ts tests/reference-docs.test.ts`; run any other tests relevant to the feature.
- [ ] Review the generated reference and verify `git diff --check` passes.

The token gate identifies newly introduced token values, but cannot identify every feature or semantic change. The legacy list is an incomplete migration baseline, not a coverage percentage. Code review must check that changes using existing syntax also have appropriate examples and tests.
