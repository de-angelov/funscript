# FunScript — language design and roadmap

**Draft 0.1 · October 2026**

> FunScript is a small, indentation-based language that compiles to readable TypeScript for
> the Effect + ts-pattern + Mutative ecosystem.

**Working name:** FunScript
**File extension:** `.fun`
**CLI:** `funscript`
**Target runtime:** Node.js 20+, Bun, Deno, browsers (where Effect runs)
**Target libraries:** Effect 3.x, ts-pattern 5.x, Mutative 1.x
**Standard library:** Effect TS (there is no separate FunScript standard library)
**Type checker:** TypeScript 5.6+

**Companion documents:** [syntax.md](syntax.md) · [pit-of-success.md](pit-of-success.md) ·
[tooling.md](tooling.md) · [rejected-syntax.md](rejected-syntax.md)

**Status:** Mixed: current behavior and design rationale are labeled **Implemented**;
future work is labeled **Planned**. This document is not the accepted-syntax reference:
use [syntax.md](syntax.md) for syntax supported by the current compiler. Compatibility
forms are identified as such in that reference.

---

## Current strictness contract

The implementation targets the Effect 3.x and TypeScript 5.6+ dependencies in
`package.json`. Examples use PascalCase FunScript types and unified `=>` arrows;
functions are immutable bindings (`name = (params) => ...`), with `() =>` for no
arguments. `fn` and `function` are not function declaration forms.

Static checking protects calls inside FunScript. `run` and `build` gate on that
check and exit non-zero on errors; `--no-check` is an explicit prototyping escape.
Foreign values still require runtime validation: `export js` validates annotated
parameters, schema constructors validate their inputs, and HTTP/CLI/file/database
adapters decode `Unknown` with `Schema.decodeUnknown`, `Schema.decodeUnknownEither`,
or `Schema.decodeUnknownSync`. Static aliases and raw `ts` types do not create
validators. See [syntax.md](syntax.md#123-static-guarantees-and-runtime-boundaries)
and [tooling.md](tooling.md).

Sections labeled **Planned** describe tooling or integrations that are not part of the
current implementation. Unlabeled language examples describe the current design contract;
check [syntax.md](syntax.md) for the implemented forms.

## 1. The itch

Effect and ts-pattern are excellent libraries. They give TypeScript a coherent effect
system, typed dependency injection, structured concurrency, schema validation, and
exhaustive structural pattern matching. The problem is not what they do. The problem is
how much syntax it takes to say it.

A small but realistic Effect program looks like this:

```ts
import { Context, Effect, Layer, Schema } from "effect";
import { match } from "ts-pattern";

type User = { readonly id: string; readonly name: string };

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String,
}) {}

class UserRepo extends Context.Tag("app/UserRepo")<
  UserRepo,
  {
    readonly find: (id: string) => Effect.Effect<User, NotFound>;
  }
>() {}

const UserRepoLive = Layer.succeed(UserRepo, {
  find: (id) =>
    id === "1"
      ? Effect.succeed({ id, name: "Ada" })
      : Effect.fail(new NotFound({ id })),
});

const program = Effect.gen(function* () {
  const repo = yield* UserRepo;
  const user = yield* repo.find("1");
  return user.name;
}).pipe(Effect.provide(UserRepoLive));

const result = await Effect.runPromise(program);
```

That is not bad code. It is explicit, type-safe, and composable. But the ratio of
intent to ceremony is poor, and the ceremony repeats in every file:

- `Effect.gen(function* () { ... yield* ... })` for every effectful sequence.
- `match(value).with(...).with(...).exhaustive()` for every decision.
- `Context.Tag` plus a tag string plus a payload interface for every service.
- `Schema.TaggedError` plus a payload schema plus `new` for every typed error.
- `pipe(...)` or nested calls for every transformation chain.
- Type annotations repeated in both the service declaration and its implementation.

FunScript removes the notation, not the semantics.

```funscript
import { Effect, Layer } from "effect"

schema User = {
  id: String
  name: String
}

error NotFound(id: String)

service UserRepo
  find: (id: String) => Effect<User, NotFound>

UserRepoLive = Layer.succeed(UserRepo, {
  find: (id) =>
    match
      | id == "1" => Effect.succeed({ id, name: "Ada" })
      | _ => Effect.fail(NotFound(id))
})

export main =
  effect {
    user <- UserRepo.find("1")
    user.name
  }
  |> Effect.provide(UserRepoLive)
```

The second version is not a different language runtime. It is a different surface for the
same program. The compiler emits TypeScript that uses the same libraries, the same types,
and the same runtime.

---

## 2. What FunScript is

FunScript is a **source-to-source language**:

- It compiles `.fun` files to `.ts` files.
- The generated TypeScript imports `effect` and `ts-pattern` directly.
- TypeScript checks the generated code.
- `tsc` (or the user's bundler) produces the final JavaScript.
- There is no FunScript VM, no FunScript runtime, and no separate FunScript standard library:
  **Effect TS is the standard library.**

FunScript is best understood as **a notation for a particular TypeScript stack**. It is
opinionated about that stack: Effect for effects and dependency injection, ts-pattern for
matching, TypeScript for types. It is not trying to be a general-purpose language that
happens to target JavaScript.

The surface is deliberately narrower than TypeScript. Idiomatic Effect is the only
easily supported way to sequence effects, model errors, inject dependencies, hold state,
run concurrent work, iterate, and represent absence. The parser rejects the JavaScript
and TypeScript habits that would create a second way: mutable bindings, loops, classes,
`new`, `throw`/`try`, `async`/`await`, `null`, explicit `any`, `switch`, ternary,
`function`, and the symbol spellings of booleans and equality. Raw TypeScript is the one
explicit escape hatch.

The design target is simple:

> If you removed FunScript tomorrow, the emitted TypeScript should be code you are happy to
> maintain by hand.

That constraint drives almost every decision in this document.

---

## 3. Goals

### Must have

1. **A small surface.** A readable core that fits in one sitting. New syntax must earn
   its place by removing real ceremony.
2. **Readable output.** Generated TypeScript keeps names, structure, and comments. It is
   formatted, not minified or macro-expanded into an unreadable mess.
3. **Effect-native semantics.** Effect's typed errors, requirements, interruption,
   concurrency, and resource safety are preserved exactly.
4. **Exhaustive matching by default.** A `match` without a wildcard is checked for
   exhaustiveness at compile time by ts-pattern + TypeScript.
5. **Pipeline-first composition.** Data flows left to right. The Effect ecosystem's
   data-last functions are the primary target.
6. **Borrowed types.** Types are TypeScript's. FunScript does not invent a new type system,
   type checker, or inference algorithm.
7. **Zero runtime.** No helper package is required at runtime beyond `effect` and
   `ts-pattern`.
8. **First-class interop.** Any npm package and any TypeScript type must be usable. Raw
   JavaScript/TypeScript is available through the single backtick escape hatch, without a
   FunScript-specific wrapper.
9. **Useful errors.** Parser errors point at the right token. Type errors point back to
   `.fun` source, not only to generated TypeScript.
10. **Ejectability.** A user can stop using FunScript, keep the emitted TypeScript, and
    continue with the normal Effect toolchain.
11. **Effect-first, one way per job.** Idiomatic Effect is the only easily supported
    programming model. The surface rejects the JavaScript/TypeScript features that
    undermine it (mutable bindings, loops, classes/`new`, `throw`/`try`, `async`/`await`,
    `null`, explicit `any`, `switch`, ternary, `function`, multiple object forms). There
    is one loop story, one function form, one error model, one state model, one
    concurrency model, and one way to create each kind of data.
12. **A Go-like, batteries-included toolchain.** One `funscript` command for
    new/dev/build/preview/test/check/fmt/run, with Vite as the default build/dev engine,
    Vitest as the test runner, `tsc` as the type checker, a canonical formatter, and an
    LSP. Zero config for the default path.

### Should have

- A canonical formatter with no configuration.
- A watch mode and a fast incremental build.
- An LSP that uses the TypeScript language service under the hood.
- Source maps from `.fun` to `.js`.
- A playground that compiles in the browser.
- Good diagnostics for common Effect mistakes (forgetting `<-`, non-exhaustive match,
  missing layer, a banned JS habit).

### Non-goals

- **No own type system.** FunScript will not implement Hindley–Milner inference, row types,
  or a separate checker. TypeScript is the checker.
- **No own runtime or VM.** No bytecode, no interpreter, no garbage collector.
- **No OOP.** No classes, inheritance, `this`, `super`, prototypes, or `new` in the
  language. Data + functions + services cover the same ground. `interface`, `enum`,
  `namespace`, and `data` are not FunScript declarations; use `schema` and modules.
- **No general JavaScript/TypeScript surface.** The compiler rejects `let`/`var`,
  unannotated reassignment, loops, `throw`/`try`/`catch`, `return`, `async`/`await`,
  `Promise` as a FunScript-authored effect type, `null`, `undefined`, explicit `any`, `switch`,
  ternary, `function`, runtime `typeof`/`instanceof`/`in`/`delete`/`eval`, semicolons, and
  the symbol spellings `&&`/`||`/`!`. Raw TypeScript is the only escape hatch.
- **Native JSX through `.funx`.** Components emit standard TSX for downstream frameworks.
- **No macros or metaprogramming in V1.** Raw TypeScript is the escape hatch.
- **No async/await syntax.** Effect is the concurrency model. Promise interop goes
  through `Effect.tryPromise` and friends.
- **No separate standard library.** Effect TS _is_ the standard library. FunScript adds no
  runtime utilities, no collection types, no date library, and no HTTP layer of its own.
  Small helpers belong in user code or upstream in Effect.
- **No null or undefined literals.** Use `Option` (`Option.none()`, `Option.fromNullable`,
  `Option.getOrUndefined`) or `Effect.void`.
- **No cross-language targets.** TypeScript only. This is a feature, not a limitation.
- **No own package manager.** npm/pnpm/Bun manage packages; `funscript add` delegates.
- **No backwards-compatibility promises before 0.1.** The syntax is allowed to change.

---

## 4. Design principles

### 4.1 Sugar over semantics

FunScript does not add new evaluation rules. It adds notation for existing TypeScript and
Effect constructs. If a FunScript program cannot be explained by a straightforward TypeScript
translation, the feature is probably wrong.

### 4.2 The output is part of the product

The emitter is not a black box that produces "whatever works." Emitted TypeScript is
reviewed in golden tests, kept formatted, and treated as user-facing code. Comments,
names, and import structure survive compilation.

### 4.3 Schemas, tagged unions, and types are unified

Every annotation is TypeScript, and a single `schema` keyword handles data schemas, tagged
unions (`| Variant(...)`), and compile-time aliases. Data-shape `schema` declarations compile
directly to both an Effect `Schema` runtime validator and its static TypeScript type
(`typeof Name.Type`), while tagged-union `schema` declarations compile to `Data.TaggedEnum`,
positional constructors, and a companion `Schema.Union`. FunScript adds a handful of blessed
aliases for core Effect types (`Effect<A, E, R>`, `Option<A>`, `Either<A, E>`,
`Layer<A, E, R>`, `Stream<A, E, R>`, `Array<A>`) and built-in `Schema` scalars (`Int`,
`NonNegativeInt`, `NonEmptyString`, `UUID`, etc.), plus `|> Schema.*` refinement pipelines
in `schema` declarations. Non-data declarations (functions, `Effect`, `Layer`, `Stream`,
generics) emit pure TypeScript `type` aliases. There is no separate FunScript type checker
to disagree with `tsc`.

### 4.4 Effects are explicit in types, implicit in syntax

An effectful function still returns `Effect<A, E, R>`. The syntax makes sequencing
pleasant with `<-`, but it never hides the effect from the type system. There is no
implicit `await`, no colorless async, and no "just run it" magic in library code.

### 4.5 Matching is exhaustive by default

A `match` without `_` compiles to `.exhaustive()`. Adding `_` compiles to `.otherwise()`.
Forgetting a case is a type error, not a runtime surprise. This is one of the main reasons
to use ts-pattern in the first place, and FunScript should not make it optional by accident.

### 4.6 Pipelines are the default composition

The Effect ecosystem is designed around data-last functions. FunScript's `|>` makes those
chains read like F#:

```funscript
result =
  input
  |> parse
  |> validate
  |> Effect.map(normalize)
```

Pipelines are the canonical composition for data-last APIs. Ordinary and nested calls
remain the way to invoke functions that are not pipeline stages; the formatter does not
rewrite one form into the other.

### 4.7 No hidden runtime

Generated code imports only what it uses. The compiler may inject imports for lowering
(`pipe`, `match`, `Data`, `Context`, etc.), but it never injects a FunScript runtime, a
global registry, or a decorator shim. If a feature needs runtime support, it is out of
scope.

### 4.8 Interop is a feature

A language that cannot call the ecosystem is a toy. FunScript supports:

- Standard ES module imports.
- Any npm package with TypeScript types.
- Raw TypeScript via backtick blocks.
- TypeScript `type` aliases.
- Schema constructors for literal narrowing and tuples (Option C: no `as` keyword).

The escape hatch is deliberately boring. Interop is boundary code: adapt npm values into
Effect/Schema types and do not let `Promise`, `any`, classes, or `null` leak into the core
of a FunScript program. The compiler makes those leaks visible rather than invisible.

### 4.9 Small language, big ecosystem

FunScript should not grow a utility for every task. Arrays, strings, records, dates, HTTP,
SQL, and testing all come from Effect and the wider npm ecosystem. The language supplies
syntax, not libraries.

### 4.10 The pit of success

The obvious way to write a program should be the safe way. In FunScript that means:

- `match` is exhaustive unless `_` explicitly opts out;
- a non-final bare expression in an `effect` block is a syntax error, so an Effect
  cannot be silently created and never run;
- dependencies are services in Effect's `R` channel, not globals;
- errors are typed values, and there is no `throw`/`try`/`catch`;
- bindings and data fields are immutable (`readonly`) by default, with `{ ...user, a.b: 1 }`
  and explicit local `mut` + `=` for copy-on-write updates (via Mutative) and local
  synchronous mutation, and `Effect.Ref`/`Queue` for shared or concurrent state; there are
  no loops, pure iteration is Effect `Array`/`Record`, and effectful iteration is
  `Effect.forEach`;
- data-shape and tagged-union `schema` declarations compile directly to Effect `Schema`
  values plus static TypeScript types, so static types and runtime validators never drift
  apart;
- there is one function form (`=>`), one type/schema/tagged-union form (`schema`), one error
  form (`error`), one dependency form (`service` + `Layer`), and one concurrency model
  (Effect);
- there are no classes, `new`, `interface`, `enum`, `namespace`, or `data`;
- `null` and `undefined` are not expression literals; absence is `Option`;
- explicit `any` is rejected; boundaries use `Unknown` + `Schema.decodeUnknown(MyType)`;
- `as` is eliminated entirely; known values use validating schema constructors (`UUID("1")`, `Pair([1, "ok"])`);
- time and randomness are services (`Clock`, `DateTime`, `Random`), not `Date.now()` /
  `Math.random()`, so tests control them;
- configuration is typed `Config`, never `process.env`;
- effects are run once, in an `entry` module (`export main` + `runMain`), never in the
  middle of library code;
- the type checker is `tsc`, not a parallel FunScript checker;
- one formatter, one build, one test runner, one CLI.

These are not just language rules; they are enforced by the grammar, the emitter, and
`funscript check`. The full argument, including where the guardrails stop, is in
[pit-of-success.md](pit-of-success.md).

### 4.11 The narrow gate

A language is defined as much by what it rejects as by what it accepts. FunScript does not
expose general JavaScript/TypeScript programming and then ask for discipline; it removes
the second way from the grammar.

That means:

- **One loop story:** there are no loop statements or comprehensions. Pure iteration is
  an Effect `Array`/`Record`/`HashMap` pipeline; effectful iteration is `Effect.forEach`.
- **One function form:** `=>`. No `function`, `return`, method shorthand, class methods,
  default parameters, rest parameters, or unparenthesized `x =>`.
- **One object story per semantic job:** record literals and unified `schema` declarations
  for plain data schemas and tagged unions (`| Variant(...)`), `error` for typed errors,
  `service` + `Layer` for dependencies. No classes, `new`, `this`, prototypes,
  `interface`, `enum`, `namespace`, or separate `data` keyword.
- **Immutable-first, explicit-mutable state:** bindings are immutable (`const`) and
  fields are `readonly` by default; record spreads (`{ ...x, a.b: 1 }`) and local `mut`
  use copy-on-write (cannot cross closure boundaries); concurrent/shared state uses
  `Effect.Ref`.
- **One effect model:** Effect. No authored `Promise`, `async`/`await`, `throw`/`try`, or
  ad-hoc state. Promise interop is explicit at a boundary.
- **One safe absence story:** `Option`, not `null` or `undefined`; `Unknown` + `Schema`,
  not `any`.

The rejection table is in [rejected-syntax.md](rejected-syntax.md). The compiler is the
style guide; there is no lint configuration that can add a second dialect.

---

## 5. Language tour

The rest of this section is a working design, not a final grammar. Examples are chosen to
show the intended feel and the intended TypeScript output.

### 5.1 Bindings, explicit local `mut`, and functions

Bindings are immutable by default and compile to `const`. Local mutable bindings are
opted into explicitly with `mut` and updated with `=`.

```funscript
name = "Ada"
age = 36
user = { name, age }
count: Number = 0

{ name, age } = user
[first, ...rest] = items
```

Functions use CoffeeScript's arrow and return their last expression.

```funscript
add = (a: Number, b: Number) => a + b

identity = <A>(value: A) => A { => value }

greet = (name: String) =>
  trimmed = name |> String.trim()
  "Hello, {trimmed}!"

accumulate = (delta: Number) =>
  mut total = 0
  total = total + delta
  total

answer = () => 42
```

```ts
const add = (a: number, b: number) => a + b;

const identity = <A>(value: A): A => value;

const greet = (name: string) => {
  const trimmed = pipe(name, String.trim);
  return `Hello, ${trimmed}!`;
};

const accumulate = (delta: number) => {
  let total = 0;
  total = total + delta;
  return total;
};

const answer = () => 42;
```

Rules:

- Parameters may be annotated with TypeScript types and may use record/array
  destructuring. Optional generic type parameters `<A, B>` precede `(` and an optional
  return type follows `=>`, before the body: `(x: Number) => Number { => x }`.
- A function body is either an expression after `=>` or an indented block.
- Functions use `name = (params) => ...`. Neither `fn` nor `function` is supported; there is no second function keyword, method
  shorthand, or class method syntax. Object fields that hold functions use the same
  lambda.
- Zero-argument functions use `() => expression`; single-argument functions
  require parentheses `(x) =>` (`x =>` is rejected).
- The last expression of a block is returned; `=> expr` explicitly returns.
  Use `when (condition) => expr` for an early return and `match` for exhaustive branching.
- There are no default or rest parameters in V1. Use a record or `Option`.
- Without `mut`, `=` is always a new immutable binding. Local mutable bindings use
  `mut x = ...` (allowed only inside function bodies or `effect` blocks, never at module
  top-level) and are updated with `=`. A `mut` binding cannot be mutated across a closure
  boundary; shared or concurrent state uses `Effect.Ref`.
- There is no `new` and no class. Plain data and tagged unions use `type`; dependencies
  use `service`.
- A top-level binding is private unless prefixed with `export`.

```funscript
export greet = (name: String) => "Hello, {name}!"
```

### 5.2 Calls and pipelines

Calls use explicit parentheses. This keeps the grammar predictable and makes JavaScript
interop obvious.

```funscript
sum = add(1, 2)
trimmed = name |> String.trim()
```

Pipelines flow left to right:

```funscript
names =
  users
  |> Array.filter((u) => u.active)
  |> Array.map((u) => u.name)
  |> Array.join(", ")
```

```ts
const names = pipe(
  users,
  Array.filter((u) => u.active),
  Array.map((u) => u.name),
  Array.join(", "),
);
```

Semantics:

- `value |> f` means `f(value)`.
- `value |> f(a)` means `f(a)(value)` — for curried data-last functions (Effect's
  standard).
- `value |> f(a, _)` or `value |> f(_, b)` plugs the piped value into the `_` argument
  slot of an uncurried function (compiling to `f(a, value)` for a single stage or
  `(v) => f(a, v)` inside `pipe`). At most one `_` may appear as a direct argument of a
  `|>` call stage.
- A pipeline of two or more stages compiles to Effect's `pipe`.
- **Type-directed pipeline resolution:** Bare function calls in pipelines (`users |> filter(f) |> sortBy(key) |> take(5)`) auto-resolve against the companion module of the left-hand type (`effect/Array`), emitting `Array.filter`, `Array.sortBy`, etc., with zero visual repetition.
- There is no point-free `>>` composition operator: write `(x) => x |> f |> g` so
  TypeScript preserves full contextual type inference across stages.

This combines F# pipeline semantics for Effect's data-last APIs with ergonomic calling of
ordinary uncurried functions:

```funscript
score =
  rawScore
  |> parseScore
  |> clamp(0, 100, _)
  |> formatScore(_, "en-US")
```

### 5.3 Records, arrays, copy-on-write updates (Mutative), and iteration

```funscript
user = {
  name: "Ada"
  age: 36
  visits: 0
  address: { city: "London" }
}

older = {
  ...user
  age: user.age + 1
  address.city: "Paris"
}

visited =
  user
  |> mut (draft) =>
    draft.visits = draft.visits + 1
    draft.address.city = "Paris"

city = user.address?.city ?? "Unknown"

numbers = [1, 2, 3, 4]

squares =
  numbers
  |> Array.filter((n) => n > 0)
  |> Array.map((n) => n * n)
```

```ts
import { create } from "mutative";

const user = { name: "Ada", age: 36, visits: 0, address: { city: "London" } };
const older = create(user, (draft) => {
  draft.age = user.age + 1;
  draft.address.city = "Paris";
});
const visited = create(user, (draft) => {
  draft.visits = draft.visits + 1;
  draft.address.city = "Paris";
});
const city = user.address?.city ?? "unknown";
const numbers = [1, 2, 3, 4];

const squares = pipe(
  numbers,
  Array.filter((n) => n > 0),
  Array.map((n) => n * n),
);
```

Rules:

- Commas are optional when fields or elements are on separate lines; a newline at the
  top level of a record/array literal is a separator. The formatter inserts commas in the
  emitted TypeScript.
- All records, arrays, and Schema-backed `type` values are deeply `readonly` at rest.
- Shallow record spreads (`{ ...user, age: 37 }`) emit native JavaScript object spreads.
  When a record with a leading `...base` spread contains nested dot-path keys
  (`{ ...user, address.city: "Paris" }`), or when a `mut` binding / `|> mut (draft) => ...`
  pipeline stage mutates fields or arrays (`draft.visits = draft.visits + 1`,
  `draft.tags.push("x")`), the compiler lowers the update to Mutative's structural-sharing
  `create(...)`.
- There are no loops and no comprehensions. Pure iteration uses Effect's `Array`,
  `Record`, `HashMap`, `Chunk`, and `String` modules; effectful iteration uses
  `Effect.forEach`.
- There are no `for` statements, `while` statements, or mutable index loops.
- Shared or concurrent mutable state uses `Effect.Ref` or another Effect primitive.

### 5.4 Tagged-union `schema` declarations and pattern matching

A `schema` declaration whose right-hand side is a list of `| Variant(...)` clauses declares a
tagged union. It compiles to Effect's `Data.TaggedEnum` plus a companion `Schema.Union`,
giving structural equality, hashing, `_tag` discrimination, runtime Schema validation, and
a positional constructor for each variant.

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export schema Color =
  | Red
  | Green
  | Blue
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

export const Shape = Schema.Union(
  Schema.TaggedStruct("Circle", { radius: Schema.Number }),
  Schema.TaggedStruct("Rect", { width: Schema.Number, height: Schema.Number }),
);

export type Color = Data.TaggedEnum<{
  Red: {};
  Green: {};
  Blue: {};
}>;
const $Color = Data.taggedEnum<Color>();

export const Red: Color = $Color.Red();
export const Green: Color = $Color.Green();
export const Blue: Color = $Color.Blue();

export const Color = Schema.Union(
  Schema.TaggedStruct("Red", {}),
  Schema.TaggedStruct("Green", {}),
  Schema.TaggedStruct("Blue", {}),
);
```

Nullary variant constructors are values, not functions: write `Red`, not `Red()`.
Constructor names are unique across all tagged-union `schema` and `error` declarations in a
module; they share one value namespace. `_tag` is reserved. An exported tagged-union
`type` exports the type, the companion `Schema.Union` constant, and the variant
constructors; the generated `$<Name>` helper value is private. Use `Circle(...)`/`Red` in
FunScript, not `$Shape.Circle(...)`.

Matching uses `match` with indented arms:

```funscript
export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h

export describe = (shape: Shape) =>
  match shape
    | Circle(r) when r > 10 => "large circle ({r})"
    | Circle(r) => "circle ({r})"
    | Rect(w, h) => "rectangle {w}x{h}"
```

```ts
export const area = (shape: Shape) =>
  match(shape)
    .with({ _tag: "Circle" }, ({ radius: r }) => Math.PI * r * r)
    .with({ _tag: "Rect" }, ({ width: w, height: h }) => w * h)
    .exhaustive();

export const describe = (shape: Shape) =>
  match(shape)
    .with(
      { _tag: "Circle" },
      ({ radius: r }) => r > 10,
      ({ radius: r }) => `large circle (${r})`,
    )
    .with({ _tag: "Circle" }, ({ radius: r }) => `circle (${r})`)
    .with({ _tag: "Rect" }, ({ width: w, height: h }) => `rectangle ${w}x${h}`)
    .exhaustive();
```

Rules:

- `when` introduces a guard. Guards can use the bound names.
- `|> match` at the end of a pipeline matches the piped value directly without a temporary
  binding (`users |> Array.findFirst(...) |> match`).
- Multiple patterns sharing the same handler can be combined with `|` on one arm
  (`| Admin | Owner => true`), lowering to `.with(pat1, pat2, handler)` in `ts-pattern`.
- Constructor arguments in patterns map positionally to the declared field names via a
  lightweight constructor-header cache across the `.fun` module graph; nested literal or
  structural sub-patterns lower directly into the `.with(...)` pattern object.
- A `_` arm compiles to `.otherwise()` and makes the match non-exhaustive by design.
- Without `_`, the compiler emits `.exhaustive()`.
- Nested object and array patterns are supported:

```funscript
match event
  | { kind: "click", at: { x, y } } => "click at {x},{y}"
  | { kind: "key", key } => "key {key}"
  | [first, ...rest] => "first item {first}"
  | _ => "other"
```

- Built-in patterns for the core Effect types:

```funscript
match maybeUser
  | Some(user) => user.name
  | None => "anonymous"

match result
  | Right(value) => value
  | Left(error) => "failed: {error.message}"
```

`Some`/`None`, `Left`/`Right`, and `Success`/`Failure` are compiler-known patterns for
`Option`, `Either`, and `Exit`. They compile to structural `_tag` patterns, so they work
with Effect values and with ts-pattern's narrowing. User-defined constructors take
precedence if a name is shadowed.

Naming is part of the pattern grammar:

- lowercase pattern names bind (`user`, `x`);
- uppercase pattern names must resolve to a constructor or a compiler-known pattern
  (`Circle`, `Some`, `None`);
- `_` is the wildcard.

This removes the “is `foo` a binding or a nullary constructor?” ambiguity. `_tag` is
reserved as the discriminant for tagged-union `schema` and `error` declarations.

**V1 restriction:** tagged-union `schema` declarations are monomorphic. For generic shapes,
use TypeScript `type` aliases and Effect's own types. **Planned:** generic tagged unions.

### 5.5 Effects

The canonical brace-delimited `effect { ... }` expression compiles to `Effect.gen`.
`<-` is `yield*`; `_ <-` discards the result. The existing indentation-based form
remains compatible syntax and has the same semantics.

```funscript
export getUser = (id: String) =>
  effect {
    user <- UserRepo.find(id)
    org <- OrgRepo.find(user.orgId)
    { user, org }
  }
```

```ts
export const getUser = (id: string) =>
  Effect.gen(function* () {
    const user = yield* (yield* UserRepo).find(id);
    const org = yield* (yield* OrgRepo).find(user.orgId);
    return { user, org };
  });
```

Rules:

- Only `<-` executes an effect. A bare effect expression is just a value.
- **Direct service calls**: calling `UserRepo.find(id)` inside `effect` automatically desugars to fetching the service from context and tracking `UserRepo` in `R`. Binding the service explicitly (`repo <- UserRepo`) remains supported.
- Use `_ <-` when you want an effect to run but do not need its result.
- **Non-final bare expressions are a syntax error.** Every non-final statement must be a
  binding (`=` or `mut`), a local `mut` reassignment (`=`), an effect bind (`<-` or `_ <-`),
  or a `match` statement. This makes the classic `Effect.gen` mistake — creating an effect
  and never running it — impossible to write silently.
- The last expression is returned. A final binding or effect bind returns its value; a
  final `_ <-` returns `undefined` (`Effect<Void>`). There is no `return` keyword; early
  failure uses `_ <- Effect.fail(...)`.
- A final bare `Effect` value is returned as a value, not automatically yielded. The
  compiler's post-typecheck pass warns when an `effect` block returns a nested `Effect`,
  because that is almost always a missing `_ <-`.
- `match` statements inside an `effect` block are effect-statement contexts: their
  branches follow the same non-final rule, and effects inside them use `<-` or `_ <-`.
  Subjectless (boolean) `match` inside an `effect` block lowers to native JavaScript
  `if / else if / else` statements so `yield*` stays inside the generator; an effectful
  value `match` (where any arm uses `<-`) lowers each arm body to `Effect.gen` and yields
  the `match` result with `yield*`.
- `effect` blocks can appear anywhere an expression can, including pipeline stages and
  match arm bodies.
- There is no `async`/`await`, no Promise chain, and no `setTimeout`. Promise interop is
  explicit through `Effect.tryPromise` or an Effect platform module.
- A `try`/`catch` syntax is intentionally absent. Use `Effect.catchAll`,
  `Effect.catchTag`, `Effect.retry`, `Effect.timeout`, and the rest of the combinators.
  Errors are values in the `E` channel, not exceptions.

A more complete example using a `schema` declaration:

```funscript
import { Effect, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"

export schema Todo = {
  id: Int
  title: NonEmptyString
}

export fetchTodo = (id: Number) =>
  effect {
    response <- HttpClient.get("https://jsonplaceholder.typicode.com/todos/{id}")
    todo <- response |> HttpClientResponse.schemaBodyJson(Todo)
    { id: todo.id, title: todo.title }
  }
  |> Effect.retry(Schedule.exponential("100 millis"))
  |> Effect.provide(FetchHttpClient.layer)
```

The generated code is ordinary Effect code; `<-` does not add a runtime layer.

### 5.6 Typed errors

`error` declares a tagged error class (`Schema.TaggedError`), the Effect-idiomatic way to
model recoverable failures that are also runtime-validatable `Schema`s.

```funscript
export error NotFound(id: UUID)
export error ValidationFailed(field: String, message: NonEmptyString)
```

```ts
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.UUID,
}) {}

export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()(
  "ValidationFailed",
  {
    field: Schema.String,
    message: Schema.NonEmptyString,
  },
) {}
```

Construct with positional arguments; the compiler emits the payload object:

```funscript
Effect.fail(NotFound(id))
```

```ts
Effect.fail(new NotFound({ id }));
```

Handle errors with the normal combinators:

```funscript
export findUser = (id: String) =>
  effect {
    user <- UserRepo.find(id)
    user
  }
  |> Effect.catchTag("NotFound", (e) => Effect.succeed({ id: e.id, name: "anonymous" }))
```

When sequencing operations with different error types in an `effect` block, the error
channel `E` automatically accumulates their union (e.g., `NotFound | PaymentDeclined`),
and callers must handle them exhaustively. Unrecoverable defects can be stripped from `E`
via `|> orDie` (which auto-resolves to `Effect.orDie`).

A nullary error is constructed with `Boom()`. This differs from nullary tagged-union `schema`
variants, which are values (`Red`), because errors are Effect tagged error classes. In a
pattern, all nullary constructors are bare names (`Boom`, `Red`, `None`); only error
construction uses parentheses. Error constructor names share the value namespace with
tagged-union `schema` constructors; collisions are a compiler error.

This keeps stack traces, `_tag` discrimination, `catchTag`, and ts-pattern matching all
working, without the class-plus-payload boilerplate. There is no `throw`/`try`/`catch` in
the surface; recoverable failures are values in `E`.

### 5.7 Services and layers

A `service` declares a dependency as an Effect service class. The optional string sets
the context tag; the default is the service name. Layers are built directly with Effect's
`Layer.succeed`, `Layer.effect`, and `Layer.scoped` functions, passing an `effect` block
whenever a layer acquires dependencies with `<-`:

```funscript
import { Console, Effect, Layer } from "effect"

export service Greeter
  greet: (name: String) => Effect<String>

export GreeterLive =
  Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed("Hello, {name}!")
  })

export ConfigurableGreeterLive =
  Layer.effect(Greeter, effect {
    prefix <- PrefixConfig
    {
      greet: (name) => Effect.succeed("{prefix}, {name}!")
    }
  })

export main =
  effect {
    greeter <- Greeter
    message <- greeter.greet("Ada")
    _ <- Console.log(message)
    message
  }
  |> Effect.provide(GreeterLive)
```

```ts
import { Console, Context, Effect, Layer } from "effect";

export class Greeter extends Context.Tag("app/Greeter")<
  Greeter,
  {
    readonly greet: (name: string) => Effect.Effect<string>;
  }
>() {}

export const GreeterLive = Layer.succeed(Greeter, {
  greet: (name) => Effect.succeed(`Hello, ${name}!`),
});

export const ConfigurableGreeterLive = Layer.effect(
  Greeter,
  Effect.gen(function* () {
    const prefix = yield* PrefixConfig;
    return {
      greet: (name) => Effect.succeed(`${prefix}, ${name}!`),
    };
  }),
);

export const main = Effect.gen(function* () {
  const greeter = yield* Greeter;
  const message = yield* greeter.greet("Ada");
  yield* Console.log(message);
  return message;
}).pipe(Effect.provide(GreeterLive));
```

Design notes:

- Services are yielded like any other Effect service: `greeter <- Greeter`.
- Layers are ordinary values built with `Layer.succeed(Svc, { ... })`,
  `Layer.effect(Svc, effect ...)`, and `Layer.scoped(Svc, effect ...)`. Because `effect` is
  already an expression in FunScript, no extra `layer` keyword is needed and lifecycle
  semantics (`effect` vs `scoped`) remain explicit.
- Service method bodies are normal functions or `effect` blocks.

### 5.8 Modules and interop

FunScript uses ES module syntax:

```funscript
import { Effect, Console } from "effect"
import { UserRepo } from "./services/user-repo.fun"

export { Circle, Rect, Shape } from "./shapes.fun"
export greet = (name: String) => "Hello, {name}!"
```

Rules:

- `.fun` import specifiers are rewritten to `.js` in the emitted TypeScript. TypeScript
  resolves `.js` specifiers to `.ts` sources, so the same emitted code works for `tsc`,
  bundlers, and Node ESM.
- The compiler compiles the import graph (or the whole project in project mode).
- Any npm package can be imported directly. Its TypeScript types are used as-is.
- Top-level declarations are private unless exported. There is no auto-export.
- FunScript-authored modules use named exports only, written with the `export` prefix or
  barrel re-exports `export { ... } from "./mod.fun"`.
- Default exports (`export default`), local `export { ... }` lists without `from`,
  `require`, `module.exports`, and dynamic `import()` are not in the surface. Use raw
  TypeScript if you need them immediately.
- Named imports are canonical. Default and namespace imports are interop exceptions for
  external packages that require them; do not use them for FunScript modules.
- Import order is preserved. The formatter never reorders imports.

Raw TypeScript is available through backticks:

```funscript
legacy = `require("some-legacy-package")`
```

```ts
const legacy = require("some-legacy-package");
```

Backtick blocks are emitted verbatim and can contain expressions or statements. They are
the deliberate escape hatch for the 5% of code that does not fit the surface. CommonJS,
`new`, classes, explicit `any`, and `Promise` are allowed there because the escape hatch
is visible in review; they are not part of idiomatic FunScript.

### 5.9 Unified `schema`: Effect `Schema`, tagged unions, and TypeScript types

In FunScript, a single `schema` keyword handles all three forms: data shapes (compiling to **both**
an Effect `Schema` runtime validator and a static TypeScript `type`), tagged unions (`| Variant(...)`,
compiling to `Data.TaggedEnum`, positional constructors, and `Schema.Union`), and non-data
types (functions, `Effect`, `Layer`, `Stream`, generics, compiling to pure TypeScript `type`
aliases):

```funscript
export schema Username =
  String
  |> Schema.trimmed
  |> Schema.minLength(3)
  |> Schema.brand("Username")

export schema User = {
  id: UUID
  name: Username
  age: Int |> Schema.between(0, 150)
  role: "admin" | "member" = "member"
  bio: Option<NonEmptyString>
  visits: NonNegativeInt = 0
}

export schema Lookup = (id: UUID) => Effect<User, NotFound>
```

```ts
export const Username = pipe(
  Schema.String,
  Schema.trimmed(),
  Schema.minLength(3),
  Schema.brand("Username"),
);
export type Username = typeof Username.Type;

export const User = Schema.Struct({
  id: Schema.UUID,
  name: Username,
  age: pipe(Schema.Int, Schema.between(0, 150)),
  role: Schema.optionalWith(Schema.Literal("admin", "member"), {
    default: () => "member" as const,
  }),
  bio: Schema.OptionFromNullOr(Schema.NonEmptyString),
  visits: Schema.optionalWith(Schema.NonNegativeInt, {
    default: () => 0 as Schema.NonNegativeInt,
  }),
});
export type User = typeof User.Type;

export type Lookup = (id: Schema.UUID) => Effect.Effect<User, NotFound>;
```

The compiler understands and rewrites blessed Effect type aliases and built-in `Schema`
scalars wherever a type appears:

| FunScript                                                                  | Lowering                                     |
| -------------------------------------------------------------------------- | -------------------------------------------- |
| `Effect<A, E, R>`                                                          | `Effect.Effect<A, E, R>`                     |
| `Option<A>`                                                                | `Option.Option<A>`                           |
| `Either<A, E>`                                                             | `Either.Either<A, E>`                        |
| `Layer<A, E, R>`                                                           | `Layer.Layer<A, E, R>`                       |
| `Stream<A, E, R>`                                                          | `Stream.Stream<A, E, R>`                     |
| `Array<A>`                                                                 | `ReadonlyArray<A>` / `Schema.Array(...)`     |
| `Int`, `NonNegativeInt`, `Positive`, `NonNegative`, `Finite`, `JsonNumber` | `Schema.Int`, `Schema.NonNegativeInt`, etc.  |
| `NonEmptyString`, `Trimmed`, `UUID`, `ULID`, `DateTimeUtc`, `Duration`     | `Schema.NonEmptyString`, `Schema.UUID`, etc. |

Rules:

- Annotations on bindings and parameters are optional. Inference is TypeScript's
  inference.
- `strict` is the default for generated projects.
- Data-shape `schema` declarations emit both a `Schema` value and `type Name = typeof Name.Type`.
  There is no `?` operator on fields: absence is explicit `Option<T>` (`bio: Option<T>`),
  which lowers to `Schema.OptionFromNullOr(...)` to ensure `null` never leaks into business
  logic. Fields with defaults (`role: T = "member"`) lower to `Schema.optionalWith(..., { default: () => "member" })`.
  All fields are deeply `readonly` at rest; updates use `{ ...user, a.b: 1 }` or
  `mut draft = user` / `|> mut (draft) => ...` lowered to Mutative's `create(...)`.
- Tagged-union `type` declarations (`type Shape = | Circle(radius: Number) | Rect(...)`)
  generate `Data.TaggedEnum`, positional constructors, and a companion `Schema.Union`.
- Non-data `type` declarations (containing function arrows, generics, `Effect`, `Layer`,
  `Stream`, or services) emit compile-time TypeScript `type` aliases only.
- `error` declarations generate schema-backed tagged error classes (`Schema.TaggedError`).
- `???` (and `??? "label"`) is a typed hole: it lowers to a `Never`-typed throwing IIFE,
  inspects `checker.getContextualType(node)` and `checker.getSymbolsInScope(node)` to
  report the expected type and local bindings in scope, warns in `funscript dev` / `funscript check`,
  and is a hard error in `funscript build`.
- Every data-shape `schema` and built-in Schema scalar is a validating constructor:
  `UUID("1")`, `Age(36)`, `User({ ... })` lower to `Name.make(...)`, and literal arguments
  are validated at compile time (`Age(200)` is a compile error).
- There is no `as` keyword in FunScript (Option C). `x as T`, `as const`,
  `as unknown as T`, and `as any` are parser errors; use a schema constructor or
  `Schema.decodeUnknown(T)` instead.

```funscript
id = UUID("0b9e6c1e-5f6a-4c6e-9a43-0c2f3b1d9e7a")
pair = Pair([1, "ok"])
```

- Explicit `any` is a compiler error in FunScript-authored types. Use `Unknown` plus
  `Schema.decodeUnknown(MyType)` at boundaries; contain `any` from external packages in one
  adapter.
- `interface`, `enum`, `namespace`, `data`, and `declare` are not FunScript declarations. Use
  `type`, `error`, `service`, and ES modules. `.d.ts` files may use them.
- `null` and `undefined` are not FunScript expression literals. Use `Option`
  (`Option.none()`, `Option.fromNullable`, `Option.getOrUndefined`) or `Effect.void`.
- `type` is the single construct for data schemas, tagged unions, and type aliases; there
  is no interface-vs-type or data-vs-type choice.

### 5.10 Control flow

`match` is the **only** branching construct in FunScript — covering both structural pattern
matching (`match value`) and boolean conditionals (subjectless `match`). There are no
`if`, `then`, `else`, `switch`, or `? :` tokens.

Inline two-branch form:

```funscript
label = match | n > 0 => "positive" | _ => "negative"
```

Multi-branch block form:

```funscript
label =
  match
    | n > 0 => "positive"
    | n == 0 => "zero"
    | _ => "negative"
```

Subjectless `match` lowers directly to native JavaScript conditional expressions (`? :`) or
`if / else if / else` statements (with zero `ts-pattern` runtime overhead). In expression
position, a trailing `| _ =>` arm is required so a conditional expression never silently
evaluates to `undefined`; in statement position (such as a single-condition guard in an
`effect` or `mut` block), `| _ =>` may be omitted.

There are no loops and no comprehensions. There is one way per domain:

- pure collection transforms use Effect's `Array`, `Record`, `HashMap`, and `String`
  modules in data-last pipelines;
- effectful iteration uses `Effect.forEach`;
- recursion is available for algorithms that genuinely need it;
- mutable state uses `Effect.Ref` or another Effect primitive.

```funscript
squares =
  numbers
  |> Array.filter((n) => n > 0)
  |> Array.map((n) => n * n)

effect {
  users <- Effect.forEach(ids, (id) => UserRepo.find(id))
  users
}
```

This is a deliberate constraint. Loops are where imperative mutation and off-by-one
errors live, and JavaScript's `for`/`while`/`forEach` imperative smorgasbord is exactly
the kind of choice FunScript removes. Effect already has better tools for both pure and
effectful iteration.

### 5.11 The standard library is Effect

There is no separate FunScript standard library to learn, version, or port. **Effect TS is
the standard library.** The language supplies syntax for a handful of its core
abstractions and then gets out of the way.

That means FunScript programmers use the same modules as Effect programmers:

- **Core:** `Effect`, `Option`, `Either`, `Exit`, `Cause`, `Duration`, `Schedule`,
  `Fiber`, `Ref`, `Queue`, `PubSub`, `Stream`, `Sink`, `Schema`.
- **Collections and text:** `Array`, `Record`, `String`, `HashMap`, `HashSet`, `Chunk`.
- **Platform:** `effect/http`, `effect/sql`, `effect/rpc`, `effect/cluster`,
  `effect/process`, and the rest of the ecosystem.
- **Testing:** `effect/testing`, `@effect/vitest`, and Vitest.
- **Everything else:** any npm package, imported directly at a boundary.

Effect is the only effect model, not merely the default library. New FunScript code uses the
Effect equivalent instead of the JavaScript global or ad-hoc API:

| Instead of                | Use                                                      |
| ------------------------- | -------------------------------------------------------- |
| `console.log`             | `Console`                                                |
| `fetch`                   | `HttpClient`                                             |
| `process.env`             | `Config`                                                 |
| `setTimeout`              | `Effect.sleep` / `Schedule`                              |
| `Math.random`             | `Effect.Random`                                          |
| `Date` / `Date.now`       | `Clock` / `DateTime`                                     |
| `Number`                  | `Int` / `Float` / `Decimal`                              |
| `<`, `<=`, `>`, `>=`      | `Number.greaterThan`, `DateTime.greaterThan`, etc.       |
| `JSON.parse`              | `raw \|> Schema.decodeUnknown(Type)`                     |
| `Promise` / `async`       | `Effect`                                                 |
| `try` / `catch` / `throw` | `Effect.try`, `Effect.catch*`, `error`                   |
| `let` / mutation          | `mut` (local copy-on-write) or `Effect.Ref` (concurrent) |
| `for` / `while`           | Effect `Array`/`Record` pipelines or `Effect.forEach`    |
| `class` / `new`           | records, `type` (Schema + tagged unions), `service`      |
| JS `Map` / `Set`          | `HashMap` / `HashSet`                                    |
| `null` / `undefined`      | `Option`                                                 |
| `any`                     | `Unknown` + `Schema`                                     |

These APIs are available because npm is available, but they are interop, not the
supported programming model. The parser or `funscript check` rejects the surface forms; the
remaining globals are lint-level warnings.

FunScript's job is to make `Effect.gen`, `Context.Tag`, `Data.TaggedEnum`, `Schema`, and
ts-pattern pleasant to write. It does not wrap them, re-export them, or add a competing
API. If a utility is missing, the answer is a function in user code or an upstream
contribution to Effect — not a new FunScript module.

This is also why the language can stay small. The ecosystem is the library; the compiler
is only the notation.

### 5.12 Recommended stack (Effect v3)

FunScript currently depends on **Effect v3**. The integrations below describe the
proposed ecosystem stack; optional packages are not all installed by this repository:

| Need                                               | Package / module                                                                               | Replaces                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Effects, errors, DI, concurrency, streams, schemas | `effect` (core)                                                                                | Promises, zod, RxJS, p-limit, lodash, date-fns |
| Pattern matching                                   | `ts-pattern`                                                                                   | `switch` / `if` chains                         |
| Copy-on-write updates                              | `mutative`                                                                                     | Immer, hand-written nested spreads             |
| HTTP client & server                               | `@effect/platform` (`HttpClient`, `HttpRouter`)                                                | `fetch`, express, axios                        |
| Runtime per platform                               | `@effect/platform-node` / `-bun` / `-browser` (`NodeRuntime.runMain`, `FileSystem`, `Command`) | `fs`, `child_process`, `process.on("SIGINT")`  |
| SQL                                                | `@effect/sql` + `@effect/sql-pg` / `-sqlite-node` / `-mysql2`                                  | Prisma, Knex                                   |
| Typed RPC                                          | `@effect/rpc` (shares `schema` and `error` declarations with the client)                       | tRPC                                           |
| Observability                                      | `Effect.withSpan`, `Metric`, `@effect/opentelemetry`                                           | ad-hoc logging                                 |
| CLIs                                               | `@effect/cli`                                                                                  | commander, yargs                               |
| Testing                                            | `@effect/vitest` (`it.effect`, `TestClock`, seeded `Random`) + Vitest                          | plain Vitest, fake timers                      |
| Durable / distributed work                         | `@effect/cluster`, `@effect/workflow`                                                          | BullMQ, Temporal                               |
| LLM calls                                          | `@effect/ai`                                                                                   | ad-hoc SDK wrappers                            |

Concurrency deserves a note: Effect **fibers are goroutines** (green threads), `Queue` is a
channel, `Effect.race` is `select`, and `Effect.forEach(xs, f, { concurrency: n })` is a
worker pool / `errgroup` — but structured: a fiber is owned by its parent or a `Scope`,
interruption replaces `context.Context`, and a failing worker cancels its siblings. That is
why FunScript adds no `go`, `chan`, or `select` syntax (see [syntax.md §9.8](syntax.md)).

> Check optional package compatibility against the project's installed Effect version.
> These integrations do not introduce a separate FunScript runtime.

---

## 6. Compilation model

### 6.1 Pipeline

```text
 .fun source
      │
      ▼
   lexer            indentation-aware tokens; emits INDENT / DEDENT / NEWLINE
      │
      ▼
   parser           recursive descent + Pratt expressions; spans on every node
      │
      ▼
    AST             type (Schema / tagged union / alias), service, error, match, effect, pipelines, modules
      │
      ▼
  resolver          banned-surface checks, scopes, constructors + cross-file
                    constructor-header cache, imports, arity checks, export rules
      │
      ▼
   emitter          TypeScript + source map + injected imports
      │
      ▼
   tsc              type check (+ contextual type inspection for `???` holes),
                    emit .js and .d.ts
      │
      ▼
 Node / Bun / Deno / browser
```

### 6.2 What the compiler emits

The emitter targets:

- ES2022
- ESM
- `strict` TypeScript
- `moduleResolution: "NodeNext"` or `"Bundler"` (user's choice)

It emits one `.ts` file per `.fun` file, preserving the directory structure. It does
not bundle. Bundling is the job of the user's existing toolchain.

Generated imports are deduplicated and merged with user imports. If a generated name
would collide with a user binding, the compiler aliases the generated import (for
example `Effect as $Effect`) rather than requiring the user to rename anything.

### 6.3 Type checking

The compiler does not type-check FunScript directly. It emits TypeScript and invokes the
TypeScript compiler API (or the project's `tsc`) on the result. This has three benefits:

1. Type semantics are exactly TypeScript's.
2. Every npm type definition works; the FunScript _surface_ deliberately limits expression
   constructs.
3. The compiler stays small.

The resolver rejects explicit `any` in FunScript-authored types before `tsc` runs. `any` that
comes from an external package is contained at the boundary; the strict `any` leak report
shows where it escapes into FunScript code.

`tsc` runs over a virtual TypeScript program built from the `.fun` import graph, or over
the `.funscript-cache/` mirror. Plain `tsc` does not discover `.fun` files; the `funscript`
commands own the file walk. The generated `tsconfig.json` is the type policy, not the
project file list.

The cost is diagnostic mapping. The emitter records a source map from `.fun` spans to
`.ts` spans. TypeScript diagnostics are mapped back through that map. In early versions,
the CLI shows both the FunScript location and the generated TypeScript location.
**Planned:** later versions show a single FunScript code frame.

### 6.4 Source maps

There are two mappings:

1. `.fun` → `.ts` (produced by the emitter)
2. `.ts` → `.js` (produced by `tsc`)

The build composes them into `.fun` → `.js` using `@jridgewell/trace-mapping`. This is
what makes stack traces and debuggers useful. Source-map composition is a hard
requirement, not a polish item; a language that cannot be debugged will not be used.

### 6.5 The compiler itself

The compiler is written in TypeScript and dogfoods the target stack:

- The lexer and parser are pure functions.
- The AST uses tagged unions.
- The resolver and emitter use `ts-pattern` for AST dispatch.
- The CLI uses Effect for file system access, concurrency, watch mode, and error
  reporting.

This is both a sanity check on the language design and a source of real-world feedback.
If writing the compiler in the target style is painful, the language is not ready.

### 6.6 No runtime

The output imports only:

- `effect` (and `effect/http`, `effect/schema`, etc. as needed)
- `ts-pattern`
- `mutative`
- user packages
- Node/browser built-ins

There is no `@funscript/runtime` package. A helper that cannot be expressed as generated
TypeScript is not part of FunScript.

---

## 7. Tooling: Go-like batteries, Vite by default

FunScript's toolchain should feel like Go's day-to-day loop:

```text
funscript new
funscript dev
funscript test
funscript fmt
funscript build
```

One command, one default per concern, no configuration until a project genuinely needs
it. The full design is in [tooling.md](tooling.md); this section is the summary.

### 7.1 Commands

| Command             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `funscript new`     | scaffold a Vite + Vitest + TypeScript project                 |
| `funscript dev`     | Vite dev server with the FunScript plugin + typecheck watcher |
| `funscript build`   | `funscript check` then Vite production build                  |
| `funscript preview` | preview the production build through Vite                     |
| `funscript test`    | Vitest, discovering `*.test.fun`                              |
| `funscript check`   | parse + resolve + FunScript checks + `tsc --noEmit`           |
| `funscript fmt`     | canonical formatter; `--check` for CI                         |
| `funscript run`     | compile and execute a script/CLI                              |
| `funscript add`     | delegate to npm/pnpm/Bun                                      |
| `funscript emit`    | emit readable `.ts` for debugging or ejection                 |
| `funscript lsp`     | language server                                               |
| `funscript doctor`  | diagnose toolchain/version problems                           |

### 7.2 Defaults

| Concern              | Default                       |
| -------------------- | ----------------------------- |
| Dev server / bundler | **Vite**                      |
| Production preview   | **Vite preview**              |
| Test runner          | **Vitest**                    |
| Type checker         | **tsc**                       |
| Formatter            | **funscript fmt** (no config) |
| Packages             | npm / pnpm / Bun              |
| Editor               | **funscript lsp**             |
| Runtime              | **Effect TS**                 |
| Standard library     | **Effect TS**                 |
| Entry point          | `src/main.fun`                |
| Test files           | `*.test.fun`                  |
| Output               | `dist/`                       |

`funscript new` generates a normal Vite project with `@funscript/vite`, a strict
`tsconfig.json`, a passing test, and no FunScript runtime dependency. The generated
`vite.config.ts` and `tsconfig.json` are editable; there is no FunScript-specific build
format to escape.

### 7.3 Why Vite

Vite is already the TypeScript ecosystem's default dev server and bundler for web apps.
It gives FunScript HMR, esbuild transforms, Rollup production builds, CSS/assets/env support,
and a shared pipeline for dev, build, preview, and Vitest. FunScript only needs a Vite plugin
that compiles `.fun` to TypeScript in memory and provides source maps.

The plugin is injected automatically by `funscript dev`, `funscript build`, and `funscript test`.
The CLI does not require a config file; `funscript new` generates one so that running `vite`
or `vitest` directly also works. The plugin does not typecheck; `funscript dev` runs a
typecheck watcher and `funscript build` runs `funscript check` first.

For Node scripts and CLIs, `funscript run` compiles and executes directly. For Node builds,
`funscript build --target node` uses Vite's SSR/library mode.

### 7.4 Check, build, test

`funscript check` is the gate:

1. parse and resolve, including the banned JavaScript/TypeScript surface;
2. FunScript-specific checks (non-final bare expressions in `effect` blocks, duplicate
   service tags, `_tag` collisions, constructor-name collisions across tagged-union `schema`
   and `error`, explicit `any` in FunScript-authored types, unreachable match arms, known
   mutating JS methods on non-`mut` bindings and callback `forEach` loops as warnings);
3. emit TypeScript;
4. `tsc --noEmit` with the project config;
5. map diagnostics back to `.fun`;
6. post-typecheck warnings (nested `Effect` returns, `any` leaks from external packages).

`funscript build` and `funscript test` run `funscript check` first. The compiler is the first
reviewer. There is no separate lint step for things the compiler can know.

`funscript test` discovers `*.test.fun`, runs Vitest through the same Vite plugin, and
supports `@effect/vitest`. It typechecks tests by default (`--no-check` skips).

CI uses the same commands as developers:

```text
funscript fmt --check
funscript check
funscript test --run
funscript build
```

### 7.5 Formatter

A canonical formatter with no configuration:

- 2 spaces, no tabs, no semicolons in FunScript.
- One pipeline stage per line for three or more stages.
- Match arms aligned under `match`.
- Blank line between top-level declarations.
- Imports preserved in source order (never reordered; side effects matter).
- `--check` for CI, `--stdin` for editors.

There are no boolean symbol aliases to normalize: `&&`, `||`, and `!` are parse
errors. The formatter shares the compiler's parser and is published as
`@funscript/formatter`. There is exactly one style and no configuration.

### 7.6 Editor support — Planned

- **Phase 1:** TextMate grammar for syntax highlighting.
- **Phase 2:** `funscript lsp` compiles on save, runs the TypeScript language service on the
  generated `.ts`, and maps diagnostics, hover, completion, and rename positions back to
  `.fun`.
- **Phase 3:** FunScript-aware completions for `match` arms, service members, and pipeline
  stages.

The TypeScript language service does the heavy lifting. FunScript only maps positions and
provides syntax-level completions. The editor shows the same errors as `funscript check`.

### 7.7 Playground — Planned

A browser playground that bundles the compiler (which is TypeScript) and shows `.fun`
on the left, emitted `.ts` on the right, and errors inline. This is also the fastest way
to get feedback from people who will never install a CLI.

### 7.8 Testing strategy — Planned

- **Golden tests:** every `.fun` fixture has a reviewed `.ts` snapshot.
- **Type tests:** emitted examples are checked with `tsc --noEmit`.
- **Runtime tests:** compiled examples run under Vitest (`@effect/vitest` where useful).
- **Diagnostic tests:** parser/type errors assert message, span, and suggestion, including
  banned-surface errors (`let`, `class`, `null`, `undefined`, `any`, `&&`, semicolons) and
  the targeted fix suggestion for each.
- **Planned — Fuzzing:** later, for the lexer and parser.

The examples in this repository are the first golden fixtures.

---

## 8. Project layout

Current:

```text
funscript/
  README.md
  docs/
    proposal.md
    syntax.md
    pit-of-success.md
    tooling.md
    rejected-syntax.md
  examples/
    hello.fun
    shapes.fun
    todo-http.fun
    greeter-service.fun
```

Planned:

```text
packages/
  compiler/
    src/
      lexer.ts
      parser.ts
      ast.ts
      resolver.ts
      surface.ts
      emitter.ts
      source-map.ts
      index.ts
  vite-plugin/
  formatter/
  cli/
    src/
      main.ts
      commands/
  language-server/
  vscode/
tests/
  golden/
  runtime/
  diagnostics/
```

Published names use the `@funscript/*` scope because the npm name `funscript` is taken:

| Package                      | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| `@funscript/compiler`        | lexer, parser, resolver, surface checks, emitter |
| `@funscript/vite`            | Vite plugin                                      |
| `@funscript/formatter`       | canonical formatter                              |
| `@funscript/cli`             | the `funscript` binary                           |
| `@funscript/language-server` | LSP                                              |
| `@funscript/vscode`          | VS Code extension                                |

The compiler's public API should stay small:

```ts
import { compile } from "@funscript/compiler";

const result = compile(source, { filename: "main.fun" });
// result.code: string
// result.map: RawSourceMap
// result.diagnostics: Diagnostic[]
```

---

## 9. Roadmap

### M0 — Design (this document)

- Agree on the target stack and the non-goals.
- Write the syntax tour and examples.
- Validate that the generated TypeScript compiles and runs against current Effect.

### M1 — Parser

- Indentation-aware lexer.
- AST with spans.
- Parser for bindings, `mut`, functions, calls, operators, pipelines, records, arrays,
  `match` (value and boolean), `type` (Schema, tagged union, alias), interpolation,
  imports/exports.
- Banned-surface diagnostics with targeted fix suggestions (`let` → binding, `class` →
  `type`/`service`, `null`/`undefined` → `Option`, `&&` → `and`, and so on).
- Parser tests and a `funscript parse` debug command.

### M2 — Core emitter + Vite plugin

- Emit readable TypeScript for the M1 surface.
- Unified `type` (Schema + `Data.TaggedEnum`) and `match` lowering to ts-pattern.
- Golden tests for `hello.fun` and `shapes.fun`.
- `funscript emit`.
- `@funscript/vite` prototype and `funscript dev` for the core examples.

### M3 — Effects, services, and tests

- `effect` blocks, `<-`, `_ <-`.
- `service`, `error`.
- Import graph compilation and `.fun` specifier rewriting.
- `funscript run`.
- Vitest integration and `funscript test`.
- Golden and runtime tests for `todo-http.fun` and `greeter-service.fun`.

### M4 — Type checking, diagnostics, and builds

- Invoke the TypeScript compiler API.
- Map diagnostics back to `.fun`.
- Compose source maps for runtime stack traces.
- `funscript check` and `funscript build` (Vite).
- Custom checks: non-final bare effect expressions, duplicate service tags, `_tag`
  collisions, constructor-name collisions across tagged-union `schema` and `error`, explicit
  `any`, unreachable match arms, and warnings for known mutating JS methods on non-`mut`
  bindings.

### M5 — Go-like developer experience

- Formatter (`funscript fmt`).
- LSP and VS Code extension (`funscript lsp`).
- `funscript new` scaffold with Vite + Vitest + strict TypeScript.
- `funscript doctor`.
- Playground.
- Documentation site.

### 0.1 definition of done

- All four examples compile, typecheck, and run.
- Generated TypeScript is readable and source-mapped.
- Non-exhaustive matches and common Effect mistakes produce useful errors.
- `funscript new`, `funscript dev`, `funscript build`, `funscript test`, `funscript check`, and `funscript fmt`
  work with Vite/Vitest defaults.
- The compiler is installable from npm and works on Node 20+.
- The language has a written specification and a migration/eject guide.

---

## 10. Compatibility and versioning

- **Effect:** target 4.x. Pin a tested minor in the compiler's integration tests. Effect's
  core APIs are stable, but `effect/http` and some platform modules are marked unstable;
  the compiler must be tested against the exact version it claims to support.
- **ts-pattern:** target 5.x. Matching output is central; pin and test.
- **TypeScript:** target 7.x, with a 5.9+ compatibility goal for generated code.
- **Node:** 20+ for the CLI. Generated code runs wherever Effect runs.
- **Modules:** ESM first. CommonJS output can be added later through `tsc`.
- **Effect aliases:** the blessed type aliases are part of FunScript's surface. They are
  versioned with the language and documented in one place.

FunScript does not add a runtime version. It does add a **target version**: a given FunScript
release emits against a known Effect/ts-pattern range. That range is part of the
release notes.

---

## 11. Risks and open questions

### 11.1 Currying and pipeline ergonomics

FunScript functions use JavaScript's calling convention, so `add(1)` does not partially apply
a two-argument function. Effect's own modules are curried and data-last (`x |> Array.map(f)`),
while user-defined and npm functions are typically uncurried (`clamp(min, max, val)`).

To support both cleanly without auto-currying:

1. `value |> f(a)` calls a curried data-last function (`f(a)(value)`).
2. `value |> f(a, _)` plugs the piped value into the `_` slot of an uncurried call
   (`f(a, value)` in a single stage, or `(v) => f(a, v)` inside `pipe`).
3. Nested `_` expressions (`_.name`, `|> f(g(_))`) are rejected so `_` never has ambiguous
   lambda scope.

### 11.2 Subjectless `match` lowering

Subjectless `match` (boolean conditions) lowers to native conditional expressions (`? :`)
when arms are inline pure expressions, and to native `if / else if / else` statements (with
a hoisted `let` when assigned to a binding) inside `effect` blocks or when arms contain
multi-statement blocks or `mut` assignments. This avoids both `ts-pattern` runtime overhead
and IIFE wrapper noise.

### 11.3 Matching backend

The proposal uses ts-pattern. Effect also ships `Match`, which is tag-oriented and
integrates tightly with Effect. ts-pattern is richer for structural patterns, guards, and
nested data, and it is what the project explicitly targets. Recommendation: use
ts-pattern for `match`; consider an opt-in `Match` backend later if it produces better
output for tag-only unions.

### 11.4 Tagged-union `type` backend

`Data.TaggedEnum` gives equality, hashing, and `_tag` integration, but its constructors
take payload objects and its generics are awkward. Plain readonly tagged objects are
simpler to emit and easier to read, but lose structural equality unless wrapped in
`Data.struct`.

Recommendation: use `Data.TaggedEnum` + `Schema.Union` for V1 because the target is Effect
and equality + runtime decoding matter. Revisit if generated code or generics become
painful.

### 11.5 Generic tagged unions

Generic unions are common (`Result<A, E>`, `Tree<A>`). `Data.TaggedEnum` can express them
but constructor generation requires generic wrapper functions and careful type plumbing.
V1 keeps tagged-union `schema` declarations monomorphic and leans on Effect's `Option`,
`Either`, `Exit`, and `Schema` for generic shapes.

### 11.6 Diagnostic mapping

Mapping TypeScript errors back through generated code is the least glamorous and most
important part of the project. A naive line-based mapping will produce wrong carets.
Recommendation: emit precise token-level mappings from the start and build a diagnostic
test suite before the emitter grows.

### 11.7 Effect API churn

The implementation uses Effect 3.x; optional platform packages evolve independently. The compiler
should isolate all lowering decisions behind a small "target" module so a future Effect 5
or a changed `Context.Tag` shape can be adapted in one place.

### 11.8 Name collision

`funscript` is taken on npm by an unrelated package. Published packages should use
`funscript` or `@funscript/*`, and the CLI binary can remain `funscript` for local use.
Alternatives if the name does not stick: Ristretto, Cortado, Cascara, Cremina.

### 11.9 Readable output vs. sugar

Some sugar (multi-branch `match` expressions, nested patterns, service declarations)
necessarily expands into more TypeScript than the source. The rule is that the expansion
must remain _locally understandable_: a reader should be able to see the correspondence
without jumping across the file. Golden snapshots enforce this socially as much as
technically.

### 11.10 What about `async`/`await`?

No. Effect is the concurrency model. Promise interop is explicit and confined to a
boundary:

```funscript
response <- Effect.tryPromise(() => fetch(url))
```

Adding `await` would create two effect systems and undermine the type-level guarantees.
FunScript-authored APIs return `Effect`, not `Promise`. This is a deliberate non-goal.

---

## 12. Prior art

- **CoffeeScript** — indentation, `=>`, implicit returns, and interpolation. FunScript keeps
  the surface calm but drops implicit calls, `this`, classes, comprehensions (Effect's
  `Array` module is the iteration story), and the untyped runtime.
- **F#** — pipelines, function composition, expression orientation, discriminated
  unions, exhaustive matching, computation expressions (`effect` blocks are the `async`
  block analogue).
- **Elixir** — the pipe operator and the pleasure of reading left-to-right data flow.
- **Elm** — exhaustive case expressions and a small, opinionated language.
- **ReScript** — a typed language that compiles to JavaScript and treats interop as a
  first-class concern.
- **Gleam** — a small language with explicit data types and pattern matching.
- **Roc** — ambitious language design around platforms and interfaces; useful as a
  source of ideas, not as a scope model.
- **Scala 3** — significant indentation, union types, and expression-oriented syntax.
- **Effect's own `Match` and `Effect.gen`** — proof that the target abstractions are good;
  FunScript is a nicer notation for them, not a replacement.
- **ts-pattern** — the reason exhaustive structural matching can be a language feature
  without writing a matching engine.

The closest philosophical sibling is CoffeeScript, but the closest _semantic_ sibling is
F#: a small, typed, expression-oriented language whose features map onto a powerful
runtime.

---

## 13. Name

**FunScript** combines _Functional_ and _TypeScript/CoffeeScript_. Published packages use
the `@funscript/*` scope, and the file extension `.fun` is short and reads well:

```text
src/main.fun
```

---

## 14. Summary

FunScript is an attempt to answer a narrow question:

> What would a modern CoffeeScript look like if its target were Effect + ts-pattern +
> Mutative instead of jQuery-era JavaScript?

The answer is a small, 16-keyword, indentation-based, expression-oriented language with:

- immutable bindings by default, `{ ...user, a.b: 1 }` and explicit `mut` copy-on-write
  updates via Mutative, and implicit returns (no `return`);
- F#-style pipelines over Effect's data-last APIs (`|>` and `|> f(a, _)`);
- unified `schema` declarations (Effect `Schema` + tagged unions `| Variant(...)` +
  compile-time aliases) and `error` declarations that lower to Effect's tagged errors;
- exhaustive `match` (for both structural patterns via ts-pattern and boolean conditions);
- `effect` blocks that lower to `Effect.gen`;
- services that lower to `Context.Tag`;
- Effect-first, one way per job: no classes/`new`, no loops or comprehensions, no
  `throw`/`try`, no `async`/`await` or authored `Promise`, no `null`/`undefined`, no
  explicit `any`, no `if`/`else`/`switch`/ternary, and only one function form;
- TypeScript types, TypeScript checking, and a readable TypeScript output;
- a Go-like toolchain: `funscript new/dev/build/preview/test/check/fmt/run`, Vite and Vitest
  by default, `tsc` as the type gate, a canonical formatter, and an LSP;
- no FunScript runtime, no separate standard library (Effect TS _is_ the standard library),
  and a boring escape hatch.

The compiler is a weekend-sized parser plus a carefully engineered emitter. The hard
parts are diagnostics, source maps, and resisting the urge to add features. That is the
right kind of hard for a hobby language.
