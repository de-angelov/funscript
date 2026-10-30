# FunScript tooling

This page describes the commands implemented by the published CLI. Project scaffolding
and Vite/Vitest wrappers are planned, not part of the current command surface.
Use the package manager and ecosystem tools directly when you need those features.

## Supported CLI commands

`funscript --help` is the source of truth for command syntax. The current commands are:

| Command | What it does |
| --- | --- |
| `funscript build <file.fun|file.funx...> [options]` | Compile source files to TypeScript/TSX. |
| `funscript emit <file.fun|file.funx> [options]` | Emit TypeScript/TSX for one source file. |
| `funscript check [file.fun|file.funx...]` | Type-check source files, or scan `src/` when no files are given. |
| `funscript run <file.fun|file.funx>` | Compile and execute a source file with Node. |
| `funscript fmt <file.fun...> [--check]` | Format source files, or report whether they need formatting. |
| `funscript repl` | Start the interactive REPL. |
| `funscript lsp [--stdio]` | Start the language server. |
| `funscript version` | Print the CLI version. |

The CLI does not currently provide `new`, `dev`, `preview`, `test`, `add`, or `doctor`.
For project creation, create ordinary `package.json`, `tsconfig.json`, and tool config files
using the relevant ecosystem tool. Use Vite for web development and builds, Vitest for
JavaScript/TypeScript tests, and npm, pnpm, or Bun to manage dependencies. These tools do not
automatically discover `.fun` tests or start through a FunScript wrapper.

## Minimal command-line project

In FunScript source, use `effect { ... }` for Effect sequencing. The existing
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
