# FunScript

> A compact, indentation-based language that compiles to readable TypeScript for the Effect ecosystem.

FunScript is a notation for building typed TypeScript programs with [Effect](https://effect.website),
[ts-pattern](https://github.com/gvergnaud/ts-pattern), and [Mutative](https://github.com/unadlib/mutative).
It keeps their semantics and emitted code visible, while making effects, schemas, pipelines, pattern
matching, and immutable updates less ceremonial.

**Status:** experimental compiler and tooling under active development.
**Files:** `.fun` and `.funx` · **CLI:** `funscript` · **Runtime:** no separate FunScript runtime.

## Why FunScript?

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) ->
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

That becomes ordinary TypeScript built on `Data.TaggedEnum`, `Schema`, and `ts-pattern`.
The output remains readable, debuggable, and portable: FunScript does not hide a custom runtime
or standard library behind the generated code.

## What works today

- Compile `.fun` and `.funx` files to TypeScript and TSX.
- Type-check source with source-mapped diagnostics.
- Format FunScript source and use the formatter through Prettier.
- Run programs locally through the CLI.
- Use schemas, tagged unions, pattern matching, pipelines, effects, JSX, services, and the LSP.
- Integrate through the Vite plugin and the VS Code extension.

The exact CLI surface is generated from the implementation: see the [CLI reference](docs/reference/cli.md).
Package entry points are likewise generated in the [API reference](docs/reference/api.md).

## Quick start from a checkout

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

Use `npm run docs:generate` after changing the CLI catalogue or package exports. CI runs
`npm run docs:check` and fails if generated references are stale.

## Core ideas

- **Effect-first:** `effect { ... }` turns `<-` bindings into `Effect.gen` sequencing.
- **Schemas and data:** one `schema` declaration covers records, refinements, tagged unions,
  and type aliases.
- **Expression-oriented control flow:** `match` is exhaustive branching; `when` is the guard.
- **Immutable by default:** use record spreads for updates and explicit `mut` blocks when a
  structural-sharing draft is the clearest tool.
- **Escape hatch, not a second language:** use explicit raw `ts` blocks when TypeScript is the
  right boundary.

For the exact grammar, constraints, and runtime-boundary rules, read the
[syntax reference](docs/syntax.md) and [pit of success guide](docs/pit-of-success.md).

## Examples

| Example                                                   | Demonstrates                                    |
| --------------------------------------------------------- | ----------------------------------------------- |
| [hello.fun](examples/hello.fun)                           | Bindings, interpolation, pipelines, and effects |
| [shapes.fun](examples/shapes.fun)                         | Tagged unions and exhaustive matching           |
| [todo-http.fun](examples/todo-http.fun)                   | Schemas, retries, layers, and effects           |
| [greeter-service.fun](examples/greeter-service.fun)       | Services and dependency injection               |
| [08-todo-dashboard.funx](examples/08-todo-dashboard.funx) | JSX and a reactive UI                           |

More complete applications live in [examples](examples/) and [programs](programs/).

## Development

```sh
npm ci
npm run build
npm run fmt:check
npm run prettier:check
npm test -- --reporter=basic
```

For the CI-equivalent local gate, run `npm run pr:check`. It builds, verifies generated docs,
checks formatting, and runs the test suite. The GitHub workflow uses the same order and rejects
stale generated references.

## Project map

```text
src/cli/          CLI commands and command catalogue
src/compiler/     Static checking and compilation
src/emitter/      TypeScript and TSX generation
src/formatter/    Formatter and Prettier plugin
src/lsp/          Language Server Protocol support
src/plugins/      Vite integration
editors/vscode/   VS Code extension
examples/         Small, readable language examples
programs/         Larger end-to-end programs
docs/             Language, tooling, and generated references
tests/            Compiler, CLI, formatter, LSP, and integration coverage
```

## Documentation

- [CLI reference](docs/reference/cli.md) — generated from the command catalogue.
- [Package entry points](docs/reference/api.md) — generated from `package.json` exports.
- [Tooling guide](docs/tooling.md) — use FunScript in a normal Node project.
- [Syntax reference](docs/syntax.md) — language rules and examples.
- [CI and release operations](docs/ci-release.md) — maintainer workflow.
- [Language proposal](docs/proposal.md) — rationale and longer-term design.

## Scope and non-goals

FunScript is not a replacement runtime, package manager, framework, or test runner. Use the
TypeScript ecosystem directly for those concerns: Effect for runtime services, Vite for web
development, Vitest for tests, and npm/pnpm/Bun for packages. The planned `new`, `dev`,
`preview`, `test`, `add`, and `doctor` CLI wrappers are not currently implemented.

## License

License selection is pending.
