---
title: Overview
description: What FunScript is, what it can do today, how the repository is organized, and how to get started.
---

FunScript is a compact, indentation-based language that compiles to readable TypeScript for the
[Effect](https://effect.website) v4 ecosystem. It is a notation for building typed programs with
Effect, [ts-pattern](https://github.com/gvergnaud/ts-pattern), and
[Mutative](https://github.com/unadlib/mutative): it keeps their semantics and the emitted code
visible, while making effects, schemas, pipelines, pattern matching, and immutable updates less
ceremonial.

FunScript is not a replacement runtime, package manager, framework, or test runner. The generated
code is ordinary TypeScript that still uses Effect, Vite, Vitest, and npm/pnpm/Bun directly.

**Status:** experimental compiler and tooling under active development.

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

That source compiles to TypeScript built on `Data.TaggedEnum`, `Schema`, and `ts-pattern`. There is
no hidden custom runtime or standard library behind the output, so it stays readable, debuggable,
and portable.

## Core ideas

- **Effect-first:** `effect { ... }` turns `<-` bindings into `Effect.gen` sequencing.
- **Schemas and data:** one `schema` declaration covers records, refinements, tagged unions, and
  type aliases.
- **Expression-oriented control flow:** `match` is exhaustive branching; `when` is the guard.
- **Immutable by default:** use record spreads for updates and explicit `mut` blocks when a
  structural-sharing draft is the clearest tool.
- **Escape hatch, not a second language:** use raw `ts { ... }` blocks when TypeScript is the right
  boundary, and `as { ... }` blocks for AssemblyScript/WebAssembly kernels.

## What works today

- Compile `.fun` and `.funx` sources to TypeScript and TSX.
- Type-check sources with source-mapped diagnostics, including `--json` and `--sarif` output.
- Format FunScript source and use the formatter through Prettier.
- Run programs locally through the CLI, bundling reachable local imports.
- Use schemas, tagged unions, pattern matching, pipelines, effects, JSX, and services.
- Integrate through the Vite plugin, esbuild and Bun plugins, and the VS Code extension.
- Enforce project policies such as `noTs`, `effectOnly`, and `barePipelines` with
  `funscript.config.fun`.
- Embed high-performance WebAssembly kernels written in AssemblyScript with typed call, `.effect`,
  `.raw`, and `.scoped` companions.

The command surface is small and composable: `check`, `fmt`, `build`, `run`, `emit`, `tsc`,
`pipeline-style`, and `doctor`. There are no `dev`, `preview`, `add`, or `test` wrappers; use Vite,
Vitest, and your package manager for those concerns. See the [tooling guide](tooling.md) and the
generated `docs/reference/cli.md` for exact syntax.

## Architecture

```text
src/cli/          CLI commands and command catalogue
src/compiler/     Static checking and compilation
src/emitter/      TypeScript and TSX generation
src/formatter/    Formatter and Prettier plugin
src/lsp/          Language Server Protocol support
src/plugins/      Vite integration
editors/vscode/   VS Code extension
examples/         Runnable examples, showcases, and applications
docs/             Language, tooling, and generated references
tests/            Compiler, CLI, formatter, LSP, and integration coverage
```

Documentation lives in `docs/`: `docs/syntax.md` is authoritative for language rules,
`docs/tooling.md` covers project usage, and `docs/reference/` holds generated CLI, API, language,
and example references. Run `npm run docs:generate` after changing the CLI catalogue or package
exports; CI runs `npm run docs:check` and fails on stale references.

## Getting started

### From a checkout

```sh
git clone https://github.com/de-angelov/funscript.git
cd funscript
npm ci
npm run build

# Inspect the commands compiled from the current source.
node dist/cli/index.js --help

# Run a small example.
node dist/cli/index.js run examples/hello.fun
```

### In a Node project

Install FunScript plus the runtime libraries your source imports, then point scripts at explicit
files or directories:

```json
{
  "type": "module",
  "scripts": {
    "check": "funscript check src",
    "format": "funscript fmt src --check",
    "run": "funscript run src/main.fun",
    "build": "funscript build src/main.fun",
    "dev": "vite",
    "test": "vitest run"
  }
}
```

A typical loop is `check`, `format`, `run`, `dev`, `build`, and `test`. Add the Vite plugin when the
app imports `.fun` modules:

```ts
import { defineConfig } from "vite";
import { funscript } from "funscript/vite";

export default defineConfig({
  plugins: [funscript()],
});
```

For framework tooling that runs outside Vite, enable `types: { include: ["app"] }` in the plugin and
add the generated `.funscript/types` directory to your `rootDirs`; see the tooling guide for details.

### Next steps

- Read the [syntax guide](syntax.md) for implemented language rules.
- Read the [tooling guide](tooling.md) for the CLI, editor, and build integrations.
- Review the [compatibility policy](compatibility.md) before relying on a construct.
- Browse `examples/` for runnable programs, from `hello.fun` to REST services and JSX apps.
