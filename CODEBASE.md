# FunScript Codebase Guide (for hand editing)

This document is a practical map of the `funscript` repository so you can navigate and edit the
compiler, tooling, and tests by hand. It complements (does not replace) `docs/syntax.md`
(language contract) and `docs/README.md` (documentation map).

Repository root: `/home/dangelov/funscript` (current working branch `feat/record-interop`).

---

## 1. What FunScript is

FunScript is a small, indentation-based language that compiles to readable TypeScript for the
Effect v4 + ts-pattern + Mutative ecosystem. There is no custom runtime: generated code uses
ordinary `effect`, `ts-pattern`, and `mutative` APIs. Source extensions are `.fun` and `.funx`
(JSX). The compiler is written in TypeScript, runs on Node, and ships as `dist/cli/index.js`.

Core idea: **one notation per job**. The compiler pipeline is:

```
source (.fun/.funx)
  -> Lexer (src/lexer/lexer.ts)          -> tokens
  ->Parser (src/parser/parser.ts)       -> AST (src/ast/types.ts)
  -> semantic passes (src/compiler/*)    -> augmented AST / companion facts
  -> Emitter (src/emitter/emitter.ts)   -> TypeScript/TSX string
  -> applyJsInteropNullability (...)    -> final TypeScript
  -> source map (magic-string)
```

Type-checking of generated TypeScript happens separately via `src/compiler/check.ts` (tsc API)
and powers `funscript check`, `funscript build`, and `funscript run`.

---

## 2. Repository layout

```
funscript/
  package.json            scripts, exports, deps
  tsconfig.json           src -> dist (NodeNext, strict)
  vitest.config.ts
  src/
    index.ts              public package exports
    ast/types.ts          AST node interfaces (631 lines)
    errors.ts             FunScriptError base
    compiler.ts           compileString / checkString orchestrators
    compiler/             semantic passes + TS context
    lexer/                tokenizer (indentation, JSX)
    parser/               recursive-descent parser
    emitter/              TS/TSX codegen + pipeline catalog + imports
    formatter/            pretty printer + prettier plugin
    lsp/                  language server, hover, completion, definition
    plugins/              Vite plugin, type-view
    cli/                  CLI commands, help catalogue, repl, tsc wrapper
    tooling/              migrate, idiomatic audit
  tests/                  vitest suites + fixtures
  examples/               runnable .fun/.funx examples
  docs/                   language + tooling + generated reference
  editors/vscode/         VS Code extension (separate tsconfig)
  scripts/                build helpers, doc generation, pr validation
  dist/                   compiled output (tsc)
```

Generated references live under `docs/reference/` and are produced from code:
- `docs/reference/cli.md` from `src/cli/commands.ts` (`CLI_COMMANDS`)
- `docs/reference/language.md` from `src/lsp/docs.ts` (`DOC_CATALOG`)
- `docs/reference/api.md` from `package.json` exports
- `docs/reference/examples.md` from `examples/`

Run `npm run docs:generate` after changing those sources; CI runs `npm run docs:check`.

---

## 3. Build, test, run

```sh
npm ci
npm run build          # tsc (src) + tsc (editors/vscode)
npm test               # vitest run
npm run pr:check       # full CI gate (build + docs + fmt + prettier + tests)
npm run docs:generate  # regenerate reference docs
npm run docs:check     # verify generated docs
```

CLI during development:

```sh
node dist/cli/index.js --help
node dist/cli/index.js run examples/hello.fun
node dist/cli/index.js check examples/shapes.fun
node dist/cli/index.js fmt examples/hello.fun
node dist/cli/index.js emit examples/hello.fun
```

Always rebuild (`npm run build`) before running the CLI after editing `src/`, because the CLI
loads from `dist/`. Tests use vitest with TypeScript transform, so they run against `src/`
directly.

---

## 4. Core data model: AST (`src/ast/types.ts`)

Everything is a tagged union via `kind: "..."`. Top-level declarations:

```ts
TopLevelDeclaration =
  ImportDeclaration | ExportDeclaration | ExportDefaultDeclaration |
  SchemaDeclaration | ErrorDeclaration | ServiceDeclaration |
  BindingDeclaration | TsEscapeDeclaration | WhenStatement
```

Key expression nodes: `PipelineExpression`, `BinaryExpression`, `UnaryExpression`,
`CallExpression`, `MemberExpression`, `IndexExpression`, `RecordExpression`, `ArrayExpression`,
`FunctionExpression`, `MutBlockExpression`, `MatchExpression`, `EffectBlockExpression`,
`JSXElement`, `JsExpression`, `TsEscapeExpression`, literals, identifiers.

Type nodes: `TypeReferenceNode`, `FunctionTypeNode`, `EffectTypeNode`, `RecordTypeNode`,
`ArrayTypeNode`, `UnionTypeNode`, `LiteralTypeNode`, `TsEscapeTypeNode`.

Every node carries `span: Span` (`{ start, end }` with 1-indexed line/column and 0-indexed
offset). Spans are essential for diagnostics and source maps; preserve them when adding nodes.

---

## 5. Lexer (`src/lexer/lexer.ts`, `src/lexer/tokens.ts`)

- Indentation-based: emits `INDENT`/`DEDENT`/`NEWLINE` tokens; tracks `indentStack`.
- Paren/bracket/brace depths suppress layout tokens inside expressions.
- JSX mode for `.funx` (`isFunx`), with a `jsxStack`.
- Keywords in `KEYWORDS` map; banned words/symbols in `BANNED_KEYWORDS`/`BANNED_SYMBOLS`
  produce helpful errors.
- To add a keyword: add to `TokenType` enum, `KEYWORDS`, and update docs/tests that assert
  keyword counts (`tests/reference-docs.test.ts`, `tests/lsp-docs.test.ts`).

---

## 6. Parser (`src/parser/parser.ts`, 2746 lines)

Recursive descent. Entry: `parse()` -> `Program`. Public: `parseExpression()`. Errors collected
in `diagnostics` (parser recovery).

Precedence chain (low to high): pipeline -> logical or -> logical and -> equality -> comparison
-> additive -> multiplicative -> exponent -> unary -> postfix -> primary. Match/when/effect/mut
handled in primary and statement contexts.

When adding syntax:
1. Add AST node interface in `src/ast/types.ts`.
2. Add parsing in the appropriate `parse*` method.
3. Add emitter case.
4. Add formatter case (`src/formatter/index.ts`).
5. Add LSP docs/hover if user-facing (`src/lsp/docs.ts`).
6. Add tests.

---

## 7. Compiler orchestration (`src/compiler.ts`)

`compileString(source, filename, options)`:
1. `new Lexer(...).tokenize()`
2. `new Parser(...).parse()`
3. Build `TypeScriptCompilationContext` (if not provided).
4. Resolve imported record functions/contracts, package record contracts.
5. `validateNumericComparisons(ast, source, context, ...)`
6. `inferPipelineCompanions(ast, context, ...)` -> map of source offset -> companion module.
7. `resolveImportedSchemas(ast, source, context)`
8. `new Emitter(ast, undefined, { pipelineCompanions, importedSchemas, importedRecordFunctions, importedRecordContracts, isJsx }).emit()`
9. `applyJsInteropNullability(typescript, context)`
10. Source map via magic-string.

`checkString` only lexes+parses (no emit). Type-checking of generated TS is in `check.ts`.

Cross-module analysis uses `options.virtualSources: Map<absPath, source>` and `sourcePath`.

---

## 8. Semantic passes (`src/compiler/`)

| File | Role |
| --- | --- |
| `typescript-context.ts` | Reuses a ts.CompilerHost/Program across passes for one file. |
| `numeric-comparisons.ts` | Marks `__funscriptNumericOperand(...)` wrappers, checks via tsc that both operands are numbers; throws `NumericComparisonError` with span. |
| `pipeline-companions.ts` | Marks `__funscriptPipelineSource(id, value)`, runs tsc to infer the source type, maps to companion module (Array/Effect/Option/...). |
| `js-interop-nullability.ts` | Resolves awaited TS type of `__funscriptJs` calls to set nullable flag. |
| `imported-schemas.ts` | Resolves `schema X = from ts<T>` from imported TS types. |
| `imported-record-functions.ts` | Tracks functions with optional-record params across modules. |
| `package-record-contracts.ts` | Resolves record contracts from package `.d.ts`. |
| `record-contracts.ts` | `isRecordContract`: a record with callable/Effect fields is a compile-time contract, not a codec. |
| `check.ts` | tsc-based type checking + source-map location remapping. |

These passes work by emitting *marked* code (identity wrappers) and asking TypeScript for types,
then feeding facts back into the real emitter. This is a key pattern: **probe with tsc, emit for real**.

---

## 9. Emitter (`src/emitter/emitter.ts`, 1738 lines)

`Emitter.emit()`:
- Validates record contracts (throws if used outside direct function params).
- Emits top-level declarations.
- Generates header imports based on `effectImports`, `needsTsPattern`, `needsMutative`, etc.
- Tracks `userEffectBindings` / `effectModuleBindings` so it doesn't duplicate user imports.

`EmitterOptions` controls markers (`markPipelineSources`, `markNumericComparisonOperands`,
`allowAmbiguousPipeline`), companion facts, imported schemas/contracts, `isJsx`.

Pipeline emission (`emitPipelineExpression`) is the most intricate: resolves companion module
(Array/Effect/Option/Result/Chunk/Schedule/Layer/Stream/Schema/Number/String/...) and rewrites
`x |> f` into `pipe(x, ...)` with companion-qualified calls. Catalog in
`src/emitter/pipeline-catalog.ts` (`PIPELINE_COMPANION_CATALOG`, `pipelineCompanionCandidates`).

Service declarations emit `Context.Tag` + Layer wiring. Error declarations emit tagged errors.

When editing emitter, keep `effectImports` additions consistent: generated Effect combinators
must be added to the set or they won't be imported.

---

## 10. Formatter (`src/formatter/`)

- `index.ts`: `format(source, { filename })` parses AST and reprints.
- `prettier.ts`: prettier plugin entry (exported as `./prettier`).
- `operator-precedence.ts`: precedence tables shared with formatting.

The formatter must be updated for any new AST node or it will crash on round-trip. Tests:
`tests/formatter.test.ts`, fixtures `tests/fixtures/formatter/`.

---

## 11. LSP (`src/lsp/`)

- `server.ts`: `FunScriptLspServer`, diagnostics, formatting, completions, hover, definition.
- `docs.ts`: `DOC_CATALOG` (hover docs) — generated into `docs/reference/language.md`.
- `completion.ts`, `hover.ts`, `definition.ts`, `navigation.ts`.
- `index.ts`: exports `startLspServer`.

LSP uses the same lexer/parser/compiler. Diagnostics come from `funscript check` logic mapped
to source positions.

---

## 12. CLI (`src/cli/`)

- `commands.ts`: `CLI_COMMANDS` (single source for help + generated docs). Edit here to add
  commands.
- `index.ts`: command dispatch and implementations (`buildCommand`, `runCommand`, etc.).
- `typecheck.ts`: `checkCliFiles` (uses tsc).
- `tsc.ts`: `runTsc` wrapper with type-view diagnostics mapping.
- `repl.ts`: interactive REPL.

Commands: build, emit, check, tsc, run, repl, lsp, fmt, version, help.

---

## 13. Plugins (`src/plugins/`)

- `vite.ts`: Vite transform plugin for `.fun`/`.funx`.
- `type-view.ts`: maps generated TS diagnostics back to FunScript for `funscript tsc`.

---

## 14. Tooling (`src/tooling/`)

- `migrate.ts`: legacy syntax migration helpers (tested in `tests/migrate.test.ts`).
- `idiomatic.ts`: `auditIdiomaticFunScript` used by `funscript check --idiomatic`.

---

## 15. Testing

Vitest. Suites by area: lexer, parser, compiler, emitter, formatter, lsp, cli, integration.
Conformance tests (`tests/conformance.test.ts`) compare `.fun`/`.funx` inputs to `.expected.ts`
/ `.expected.error` golden files under `tests/fixtures/conformance/`.

When changing behavior:
- Update or add golden files carefully (they are the spec).
- Run `npm test`.
- For formatting, `npm run fmt:check` and `npm run prettier:check`.

Example-app build tests (`tests/example-apps-build.test.ts`) compile everything under
`examples/`; these catch regressions in real programs.

---

## 16. Common edit recipes

**Add a new keyword/operator**
1. `src/lexer/tokens.ts`: `TokenType`, `KEYWORDS` (and `BANNED_*` if retiring).
2. `src/lexer/lexer.ts`: tokenization if multi-char.
3. `src/parser/parser.ts`: parse at correct precedence.
4. `src/ast/types.ts`: AST node if needed.
5. `src/emitter/emitter.ts`: emit.
6. `src/formatter/index.ts`: print.
7. `src/lsp/docs.ts`: hover doc.
8. Tests + `npm run docs:generate`.

**Add a new top-level declaration**
1. AST: `TopLevelDeclaration` union + interface.
2. Parser: `parseTopLevelDeclaration`.
3. Emitter: `emitTopLevelDeclaration` case.
4. Formatter: top-level printing.
5. Compiler passes if semantic facts needed.
6. Tests/goldens.

**Add a new expression**
1. AST interface + `Expression` union.
2. Parser precedence placement.
3. Emitter case.
4. Formatter case.
5. LSP docs.
6. Tests.

**Change pipeline companion resolution**
- `src/emitter/pipeline-catalog.ts` for catalog lists.
- `src/compiler/pipeline-companions.ts` for type inference.
- Tests: `tests/pipeline-catalog.test.ts`, `tests/conformance-pipeline.test.ts`.

**Change numeric comparison rules**
- `src/compiler/numeric-comparisons.ts`.
- Docs `docs/syntax.md` section 4.2.

**Add a CLI command**
- `src/cli/commands.ts` `CLI_COMMANDS`.
- `src/cli/index.ts` dispatch + implementation.
- Regenerate docs.

**Add an LSP feature**
- `src/lsp/*.ts`; wire in `server.ts`.

---

## 17. Conventions and pitfalls

- **Rebuild before CLI testing**: CLI reads `dist/`. Tests read `src/` via vitest.
- **Spans**: every AST node needs a `span`; diagnostics/source maps depend on it.
- **Effect imports**: generated combinators must be added to `effectImports` set or missing
  imports in output.
- **JSX**: `.funx` sets `isJsx`/`isFunx`; emitter uses generic-comma differences and
  `JsxEmit.Preserve`.
- **Indentation**: lexer uses 2-space indentation; tabs are rejected.
- **No `let`/`var`/`const`/`function`/`class`/`if`/`for`/etc.**: banned keywords; use
  FunScript constructs. See `BANNED_KEYWORDS`.
- **Record contracts**: records with callable/Effect fields are compile-time only and only
  allowed as direct function parameters.
- **Generated docs**: do not hand-edit `docs/reference/*`; regenerate.
- **Source maps**: `compileString` builds maps per-declaration via magic-string; keep declaration
  spans accurate.
- **Cross-module**: use `virtualSources` + `sourcePath` for multi-file analysis; check
  `imported-schemas`/`imported-record-functions`.

---

## 18. Key files quick reference

| Task | File |
| --- | --- |
| AST definitions | `src/ast/types.ts` |
| Tokens/keywords | `src/lexer/tokens.ts` |
| Lexer | `src/lexer/lexer.ts` |
| Parser | `src/parser/parser.ts` |
| Compile orchestrator | `src/compiler.ts` |
| Type checker | `src/compiler/check.ts` |
| TS context | `src/compiler/typescript-context.ts` |
| Emitter | `src/emitter/emitter.ts` |
| Pipeline catalog | `src/emitter/pipeline-catalog.ts` |
| Imports helper | `src/emitter/imports.ts` |
| Formatter | `src/formatter/index.ts` |
| Prettier plugin | `src/formatter/prettier.ts` |
| LSP server | `src/lsp/server.ts` |
| LSP docs | `src/lsp/docs.ts` |
| CLI | `src/cli/index.ts`, `src/cli/commands.ts` |
| Vite plugin | `src/plugins/vite.ts` |
| Public exports | `src/index.ts` |
| Errors | `src/errors.ts` |

---

## 19. Where to look when debugging

- Parse errors: `Parser.diagnostics`, `tests/parser*.test.ts`, `tests/parser-recovery.test.ts`.
- Type errors in generated TS: `check.ts` mapping; inspect generated TS via `funscript emit`.
- Pipeline companion mis-resolution: run with `markPipelineSources` (see pipeline-companions pass)
  and inspect tsc type.
- Source map issues: `tests/sourcemap.test.ts`, `tests/tsc-mapping.test.ts`.
- Formatter crashes: run `funscript fmt` on the file; check new AST node handling.

---

## 20. Further reading

- `docs/syntax.md` — authoritative language syntax.
- `docs/README.md` — documentation map.
- `docs/compatibility.md` — compatibility/deprecation policy.
- `docs/ci-release.md` — CI and release.
- `docs/tooling.md`, `docs/toolchain.md` — integration.
- `grammar.ebnf` — formal grammar.
- `docs/ast-spec.md`, `docs/proposal.md` — design history.

---

*This guide is maintained by hand. Update it when you add modules or change the pipeline.*
