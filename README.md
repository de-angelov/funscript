# FunScript

> A small, indentation-based functional language that compiles to readable TypeScript for the
> [Effect](https://effect.website) + [ts-pattern](https://github.com/gvergnaud/ts-pattern) + [Mutative](https://github.com/unadlib/mutative) ecosystem.

**Status:** compiler and tooling in development
**Working name:** FunScript · **File extension:** `.fun` / `.funx` · **CLI:** `funscript`
**Target:** Effect 3.x · ts-pattern 5.x · Mutative 1.x · TypeScript 5.6+
**Standard library:** Effect TS — there is no separate FunScript standard library

## The pitch

Effect, ts-pattern, and Mutative give TypeScript an excellent foundation: typed effects,
dependency injection, runtime schema validation, structured concurrency, exhaustive pattern
matching, and fast structural-sharing immutable updates. Using them day to day, however,
involves a lot of ceremony:

- `Effect.gen(function* () { const x = yield* ... })`
- `match(value).with(...).with(...).exhaustive()`
- `create(state, (draft) => { draft.a.b = ... })` or deeply nested object spreads
- `pipe(value, ...)` or deeply nested calls
- `Context.Tag` / tag / layer boilerplate
- duplicate `Schema.Struct` validators and TypeScript `type` declarations
- tagged-union constructors and type declarations

FunScript is a _notation_ for that stack. It keeps Effect's semantics and ts-pattern's
exhaustiveness, removes the ceremony, and compiles to TypeScript you can still read,
debug, and eject from.

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

```ts
export type Shape = Data.TaggedEnum<{
  Circle: { readonly radius: number };
  Rect: { readonly width: number; readonly height: number };
}>;
const $Shape = Data.taggedEnum<Shape>();

export const Circle = (radius: number): Shape => $Shape.Circle({ radius });
export const Rect = (width: number, height: number): Shape =>
  $Shape.Rect({ width, height });

export const area = (shape: Shape) =>
  match(shape)
    .with({ _tag: "Circle" }, ({ radius: r }) => Math.PI * r * r)
    .with({ _tag: "Rect" }, ({ width: w, height: h }) => w * h)
    .exhaustive();
```

## Design in one paragraph

FunScript is CoffeeScript's calm surface plus F#'s expression-oriented toolbox, aimed at a
TypeScript backend. Bindings and data are deeply immutable by default, with shallow and
deep dot-path record spreads (`{ ...user, age: 37, address.city: "Paris" }`) and explicit
copy-on-write mutable bindings (`mut draft = user` / `|> mut (draft) => ...`) that compile
to Mutative's structural-sharing `create(...)`. A single `schema` keyword declares record
schemas, refinements, tagged unions (`| Circle(radius: Number)`), and compile-time type
aliases; functions return their last expression, pipelines are the default composition,
`match` handles exhaustive branching and `when` handles conditional execution, and `effect` blocks turn
`<-` into `yield*`. There is no FunScript runtime and no separate standard library:
**Effect TS is the standard library**. The generated code imports `effect`, `ts-pattern`,
and `mutative` directly, and TypeScript remains the type checker.

Write Effect sequencing with the canonical brace-delimited form, `effect { ... }`. The
existing indentation-based `effect` block remains compatible syntax.

## Effect-first, one way per job

Idiomatic Effect is the only easily supported way to write FunScript. There is one effect
model, one error model, one dependency model, one unified `schema` declaration (covering
Effect `Schema` structs, refinements, `Data.TaggedEnum` tagged unions, and TS aliases), one
data manipulation story (deeply immutable values updated via `{ ...x, a.b: 1 }` or
Mutative-backed `mut` drafts, and `Effect.Ref` for shared/concurrent state), one iteration
story, `match` for branching and `when` for guards, and one function form (`=>`).

The parser rejects the JavaScript/TypeScript habits that would create a second way:
`let`/`var`, reassigning immutable bindings, loops, `return`, classes/`new`, `throw`/`try`,
`async`/`await`, authored `Promise`, `null`, `undefined`, explicit `any`,
`if`/`else`/`switch`/ternary (use `match` or `when`), `function`,
semicolons, and the symbol spellings `&&`/`||`/`!`. Raw TypeScript is the
single, visible escape hatch.

## Static checks and external data

`funscript run` and `funscript build` check emitted TypeScript before execution
or output. Type errors stop the command with a non-zero exit and source-mapped
code frames. `--no-check` skips that static gate for prototyping.

Inside FunScript, the compiler enforces types. At external boundaries, validate
HTTP JSON, CLI input, file contents, and database rows with Effect Schema before
using them. `export js` wrappers validate annotated arguments from JavaScript;
schema constructors validate payloads at runtime. Skipping static checks does
not skip those validators. See the [strictness contract](docs/syntax.md#123-static-guarantees-and-runtime-boundaries).

Types use PascalCase (`String`, `Number`, `Boolean`, `Unknown`); native TypeScript
spelling stays in emitted output or `ts "..."` escapes. Functions use
`name = (params) => ...`; `fn` and `function` are rejected.

## Toolchain

The CLI currently supports `build`, `emit`, `check`, `run`, `fmt`, `repl`, `lsp`, and
`version`. `funscript --help` shows the installed command syntax. Project scaffolding and
`dev`, `preview`, `test`, `add`, and `doctor` wrappers are planned, not implemented.
Use standard project files and ecosystem tools directly: Vite for web development/builds,
Vitest for JavaScript/TypeScript tests, and npm, pnpm, or Bun for dependencies.

```text
funscript build <file.fun|file.funx...>
funscript emit <file.fun|file.funx>
funscript check [file.fun|file.funx...]
funscript run <file.fun|file.funx>
funscript fmt <file.fun...> [--check]
funscript repl
funscript lsp [--stdio]
funscript version
```

See [docs/tooling.md](docs/tooling.md) for a minimal project workflow and supported
alternatives. There is no FunScript runtime and no separate FunScript standard library;
**Effect TS is the standard library**.

For checkout-based CLI setup and status, see [the optional toolchain helper](docs/toolchain.md).

## Documents

- **[docs/proposal.md](docs/proposal.md)** — the full language proposal: motivation,
  syntax tour, compilation model, tooling, roadmap, risks, and open questions.
- **[docs/syntax.md](docs/syntax.md)** — the working syntax reference, cheat sheet,
  grammar sketch, and syntax review decisions.
- **[docs/pit-of-success.md](docs/pit-of-success.md)** — how the grammar and toolchain
  make the safe path the default, and where the guardrails stop.
- **[docs/tooling.md](docs/tooling.md)** — supported CLI commands and a minimal workflow
  using standard project tools such as Vite and Vitest.
- **[docs/rejected-syntax.md](docs/rejected-syntax.md)** — the one-way surface: what the
  parser rejects, why, and the Effect-first replacement.

## Examples

- [examples/hello.fun](examples/hello.fun) — bindings, interpolation, pipelines, Effect.
- [examples/shapes.fun](examples/shapes.fun) — tagged unions, guards, exhaustive matching.
- [examples/todo-http.fun](examples/todo-http.fun) — effect blocks, Schema, retry, layers.
- [examples/greeter-service.fun](examples/greeter-service.fun) — services, dependency injection.

## Planned repository layout

```
packages/
  compiler/         # lexer, parser, AST, emitter; the source-to-source core
  vite-plugin/      # @funscript/vite, the default build/dev integration
  formatter/        # canonical formatter
  cli/              # funscript build / emit / check / fmt / run / repl / lsp
  language-server/  # LSP built on the TypeScript language service
  vscode/           # editor integration
tests/
  golden/           # .fun to .ts snapshots
  runtime/          # compiled examples executed with Vitest
```

The current repository contains the design docs and examples only.

## Working name

**FunScript** — functional notation over TypeScript. Published packages live under
`@funscript/*` with `.fun` source files and the `funscript` CLI.

## License

Not chosen yet.
