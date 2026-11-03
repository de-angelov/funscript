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

The repository's own scripts are defined in `package.json`: `build`, `test`, `test:watch`,
`fmt`, `fmt:check`, `prettier:check`, `verify`, and `pr:check`. They are repository scripts,
not additional `funscript` CLI commands.

## Language compatibility policy

Under the human-approved language compatibility policy (TASK-102), FunScript adopts a **Strict Zero-Alias Policy**. Because FunScript is in early active development with zero external production consumers, obsolete constructs and historical shims are removed immediately rather than maintained across deprecation windows or hidden behind edition flags.

The policy governs three key evolutionary areas:

### 1. Effect aliases

Historical and obsolete Effect compatibility aliases (such as `catchAll` in favor of `catch`, or `fork` in favor of `forkChild`) are removed immediately to remain 100% synchronized with upstream Effect v4 public exports. There is no multi-release retention window or warning-only phase for obsolete aliases.

```funscript
# Obsolete Effect alias (rejected at compile time):
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
