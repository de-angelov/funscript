# FunScript

> A compact, indentation-based language that compiles to readable TypeScript for the Effect v4 ecosystem.

FunScript is a notation for building typed TypeScript programs with [Effect](https://effect.website),
[ts-pattern](https://github.com/gvergnaud/ts-pattern), and [Mutative](https://github.com/unadlib/mutative).
It keeps their semantics and emitted code visible, while making effects, schemas, pipelines, pattern
matching, and immutable updates less ceremonial.

**Status:** experimental compiler and tooling under active development.

<!-- GENERATED: project-facts -->
## Generated project facts

- Package: `funscript` `0.1.0`
- Runtime: Effect `^4.1.1`
- Source extensions: `.fun`, `.funx`
- Runnable checked examples: 20

The exact command surface is generated from the implementation in the [CLI reference](docs/reference/cli.md). The language catalogue used by editor hover help is generated in the [language reference](docs/reference/language.md).
<!-- /GENERATED: project-facts -->

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

For the current, verified contract and runnable source examples, read the
[documentation map](docs/README.md).

## Examples

<!-- GENERATED: example-inventory -->
| [`examples/08-todo-dashboard.funx`](examples/08-todo-dashboard.funx) | `FunScript JSX` |
| [`examples/github-api-client.fun`](examples/github-api-client.fun) | `FunScript` |
| [`examples/greeter-service.fun`](examples/greeter-service.fun) | `FunScript` |
| [`examples/hello.fun`](examples/hello.fun) | `FunScript` |
| [`examples/markdown-task-manager.fun`](examples/markdown-task-manager.fun) | `FunScript` |
| [`examples/order-fulfillment.fun`](examples/order-fulfillment.fun) | `FunScript` |
| [`examples/reactive-widget.funx`](examples/reactive-widget.funx) | `FunScript JSX` |
| [`examples/shapes.fun`](examples/shapes.fun) | `FunScript` |
| [`examples/solid-demo/domain.fun`](examples/solid-demo/domain.fun) | `FunScript` |
| [`examples/solid-demo/solid-in-funscript.fun`](examples/solid-demo/solid-in-funscript.fun) | `FunScript` |
| [`examples/todo-http.fun`](examples/todo-http.fun) | `FunScript` |
| [`programs/01-fibonacci.fun`](programs/01-fibonacci.fun) | `FunScript` |
| [`programs/02-bank-account.fun`](programs/02-bank-account.fun) | `FunScript` |
| [`programs/03-todo-service.fun`](programs/03-todo-service.fun) | `FunScript` |
| [`programs/04-js-ts-interop.fun`](programs/04-js-ts-interop.fun) | `FunScript` |
| [`programs/04-order-fulfillment.fun`](programs/04-order-fulfillment.fun) | `FunScript` |
| [`programs/05-github-api-client.fun`](programs/05-github-api-client.fun) | `FunScript` |
| [`programs/06-markdown-task-manager.fun`](programs/06-markdown-task-manager.fun) | `FunScript` |
| [`programs/07-reactive-widget.funx`](programs/07-reactive-widget.funx) | `FunScript JSX` |
| [`programs/08-todo-dashboard.funx`](programs/08-todo-dashboard.funx) | `FunScript JSX` |
<!-- /GENERATED: example-inventory -->

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
- [Language reference](docs/reference/language.md) — generated from the LSP hover catalogue.
- [Example inventory](docs/reference/examples.md) — generated from the runnable example tree.
- [Documentation map](docs/README.md) — separates current verified docs from proposals/history.
- [Tooling guide](docs/tooling.md) — use FunScript in a normal Node project.
- [CI and release operations](docs/ci-release.md) — maintainer workflow.

## Scope and non-goals

FunScript is not a replacement runtime, package manager, framework, or test runner. Use the
TypeScript ecosystem directly for those concerns: Effect for runtime services, Vite for web
development, Vitest for tests, and npm/pnpm/Bun for packages. The planned `new`, `dev`,
`preview`, `test`, `add`, and `doctor` CLI wrappers are not currently implemented.

## License

License selection is pending.
