# FunScript tooling

This page describes how to use the published CLI in a project. The command surface is
generated directly from code in the [CLI reference](reference/cli.md). Project scaffolding
and Vite/Vitest wrappers are planned, not part of the current command surface.
Use the package manager and ecosystem tools directly when you need those features.

## Supported CLI commands

`funscript --help` and the generated [CLI reference](reference/cli.md) are the source of
truth for command syntax.

The CLI does not currently provide `new`, `dev`, `preview`, `test`, `add`, or `doctor`.
For project creation, create ordinary `package.json`, `tsconfig.json`, and tool config files
using the relevant ecosystem tool. Use Vite for web development and builds, Vitest for
JavaScript/TypeScript tests, and npm, pnpm, or Bun to manage dependencies. These tools do not
automatically discover `.fun` tests or start through a FunScript wrapper.

## Minimal command-line project

In FunScript source, use brace-delimited `effect { ... }` as the canonical form for Effect sequencing. The existing
indentation-based `effect` block remains compatible syntax; both forms compile through
the same `Effect.gen` support.

Install FunScript and the runtime libraries your source imports in a normal Node project.
Add scripts that point to files or directories explicitly:

```json
{
  "type": "module",
  "scripts": {
    "check": "funscript check src",
    "format": "funscript fmt src/main.fun",
    "format:check": "funscript fmt src/main.fun --check",
    "run": "funscript run src/main.fun",
    "build": "funscript build src/main.fun --outDir dist",
    "dev": "vite",
    "test": "vitest run"
  }
}
```

A basic workflow is `npm run check`, `npm run format`, `npm run run`, `npm run dev`,
`npm run build`, and `npm test`. The compiler's formatter accepts `.fun` source files.
Vite and Vitest run from the project's own configuration and scripts; configure the
FunScript Vite plugin if the app imports `.fun` modules. Vitest tests are JavaScript or
TypeScript tests; `.fun` test discovery is not implemented. For output beyond compiling
FunScript files to TypeScript, configure Vite or another standard bundler directly.

The CLI command surface is intentionally small and composable. It does not create a
proprietary project layout or package format.

## Package scripts in this repository

The repository's own scripts are defined in `package.json`: `build`, `benchmark`, `test`,
`test:examples`, `test:watch`, `fmt`, `fmt:check`, `prettier:check`, `docs:generate`,
`docs:check`, `verify`, and `pr:check`. They are repository scripts,
not additional `funscript` CLI commands.

## Language compatibility policy

Under the human-approved language compatibility policy (TASK-102), FunScript adopts a **Strict Zero-Alias Policy**. Because FunScript is in early active development with zero external production consumers, obsolete constructs and historical shims are removed immediately rather than maintained across deprecation windows or hidden behind edition flags. See [Language and ecosystem compatibility policy](compatibility.md) for the full policy specification.

The policy governs three key evolutionary areas:

### 1. Effect aliases

Obsolete Effect compatibility aliases are avoided to remain synchronized with upstream Effect v4 public exports. FunScript enforces canonical names (such as `forkChild` instead of obsolete `fork`). A single audited transitional alias (`catchAll` mapping to `catch`) remains temporarily available in `EFFECT_PIPELINE_COMPATIBILITY_ALIASES` for compatibility, but canonical Effect v4 names should always be preferred.

```funscript
# Audited compatibility alias (compiles to Effect.catch; slated for removal):
export recover = task |> catchAll((err) => Effect.succeed("fallback"))

# Canonical Effect operation:
export recover = task |> catch((err) => Effect.succeed("fallback"))
```

### 2. Breaking syntax changes

Outdated syntax and deprecated grammar constructs are statically rejected with actionable error diagnostics citing the canonical form, rather than supported through multi-release deprecation warnings or language edition configurations.

For example, function blocks and effect blocks enforce the explicit return invariant (`=> value`). Trailing bare expressions without `=>` are rejected by the parser:

```funscript
# Outdated syntax (rejected by parser):
sum = (a: Number, b: Number) => {
  a + b
}

# Canonical syntax with explicit return:
sum = (a: Number, b: Number) => {
  => a + b
}
```

### 3. Newly ambiguous pipeline operations

FunScript disallows heuristic guessing, fallback priority, or companion precedence orders. If an untyped or unproven receiver type causes a bare pipeline stage to match multiple candidate companion modules in the catalog (such as `map` existing in `Array`, `Effect`, and `Option`), the compiler raises a compile-time `PipelineResolutionError` requiring explicit qualification.

```funscript
# Ambiguous bare call without a proven receiver type (rejected at compile time):
# Error: map is ambiguous for this pipeline; write Array.map(...) or Option.map(...)
export process = (data) => data |> map((x) => x + 1)

# Canonical disambiguated call with explicit companion qualification:
export process = (data) => data |> Array.map((x) => x + 1)
```

## Explicit-return migration decision

Under the human-approved decision for TASK-104 and TASK-166, FunScript has **declined automatic CLI codemod commands** (such as `funscript migrate`) that perform unattended rewrites. Instead, the language provides compiler diagnostics alongside a safe programmatic migration utility in `src/tooling/migrate.ts`.

### Decision rationale and compatibility policy

In alignment with FunScript's [Strict Zero-Alias compatibility policy](#language-compatibility-policy):
- FunScript is in early active development with zero external production consumers.
- No automated CLI command (such as `funscript migrate`) performs automatic silent rewrites on build.
- Programmatic safe migration functions (`migrateSource`, `migrateFile`, `migrateFiles`, `formatMigrationReport`) are available in `src/tooling/migrate.ts` to convert unambiguous function blocks while leaving ambiguous constructs untouched for developer review.
- Codebases rely strictly on immediate, actionable compiler diagnostics (`ParseError: Function block must end with an explicit '=> returnValue'` and `ParseError: Effect block must end with an explicit '=> returnValue'`) to guide developers during manual updates.

### Ambiguous cases and safety risks

Automated mechanical insertion of `=>` was rejected because semantic equivalence cannot be proven safely across several syntactic contexts:

1. **Side effects vs. return values in function blocks**
   In multi-statement functions, a trailing expression may be executed purely for side effects with an intended `Unit` or `void` return:
   ```funscript
   # Ambiguous legacy block:
   saveState = (state: State) =>
     serialized = serialize(state)
     writeDisk(serialized)
   ```
   Mechanically rewriting the final line to `=> writeDisk(serialized)` alters the inferred return type and leaks internal state, breaking caller contracts when the author intended the return value to be discarded.

2. **Yield (`<-`) vs. discard (`_ <-`) vs. return (`=>`) in effect blocks**
   In FunScript `effect` blocks, returning an expression with `=>` does not execute or yield it; it returns the unyielded `Effect` generator:
   ```funscript
   # Ambiguous legacy effect block:
   program = effect {
     user <- fetchUser()
     Console.log("Done")
   }
   ```
   If a codemod mechanically prepends `=> Console.log("Done")`, `Console.log` is **never executed** at runtime, causing a silent defect. The developer's intent may instead have been:
   ```funscript
   program = effect {
     user <- fetchUser()
     _ <- Console.log("Done")
     => Unit
   }
   ```
   A mechanical migration tool cannot deduce whether an effect expression should be yielded, discarded, or returned.

3. **Trailing binding declarations**
   If a legacy block ends with an assignment such as `result = compute()`, prepending `=>` produces a syntax error (`=> result = compute()`). Synthesizing an additional statement (`result = compute()` followed by `=> result`) risks returning private state or dead assignments where `compute()` was only called for side effects.

4. **Syntactic exemptions and expression bodies**
   - Multi-statement function blocks ending in `match` or `effect` expressions are exempt from `=>` in the parser (for example, a trailing `match x ...` is accepted as the final block expression).
   - Single-expression lambdas (`sum = (a, b) => a + b`) are expression bodies and do not use `=>` in the body.
   Blind mechanical insertion risks corrupting valid syntax or introducing redundant tokens.

5. **Mechanical irreversibility**
   Because `=> expr` is identical for hand-authored code and migrated code, an automated transformation is mechanically irreversible. Version control (`git`) serves as the sole rollback mechanism for manual code updates.
