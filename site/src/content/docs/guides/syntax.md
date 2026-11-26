---
title: Syntax
description: A concise tour of canonical FunScript syntax — bindings, functions, pipelines, match, schemas, effects, and services.
---

FunScript is a small, Effect-first language that compiles to TypeScript targeting Effect,
ts-pattern, and Mutative. It offers **one notation per job** and rejects the JavaScript
habits that duplicate or undermine it.

> If a construct needs a paragraph of explanation to avoid a silent mistake, change the
> construct.

This page is a summary of syntax accepted by the current FunScript compiler (0.2.3).
Planned constructs are labeled in the full reference at `docs/syntax.md` in the repository,
and the [compatibility guide](/guides/compatibility/) covers accepted legacy forms and
migration.

## Lexical basics

- Source files use the `.fun` extension and compile as one module per file.
- Indentation is significant: **2 spaces per level**. Tabs and mixed indentation are errors.
- Blocks are opened by `=>`, `match`, `effect`, `schema`, `service`, and similar constructs.
- Comments are `// line comments` only.
- There are **no semicolons**; newlines separate statements.
- Names are ASCII `[A-Za-z_][A-Za-z0-9_]*`. UpperCamel names are schemas, constructors,
  errors, and services; lowerCamel names are bindings, functions, parameters, and fields.

## Bindings and mutability

Bindings are immutable by default and compile to `const`.

```funscript
name = "Ada"
age = 36
user = { name, age }

count: Number = 0
```

Destructuring works in bindings, parameters, and patterns:

```funscript
{ name, age } = user
[first, ...tail] = items
```

Mutation is explicit and local. `mut` declares a mutable local binding; field and array
updates become copy-on-write Mutative updates, so the original value is never mutated in
place.

```funscript
accumulate = (user: User, delta: Number) =>
  mut total = 0
  total = total + delta
  mut current = user
  current.visits = current.visits + total
  => current
```

`mut` bindings may appear only inside function bodies and `effect` blocks. Shared or
concurrent state uses `Effect.Ref`, `SynchronizedRef`, or `Queue` instead.

## Functions

Functions are lambdas assigned with `=`. Parameters require parentheses, and a block body
must end with an explicit `=> value` return.

```funscript
add = (a: Number, b: Number) => a + b

answer = () => 42

greet = (name: String) =>
  trimmed = name |> String.trim()
  => "Hello, {trimmed}!"
```

- `function`, method shorthand, classes, and `new` are not part of the surface.
- Generic parameters precede the parameter list: `<A>(value: A) => ...`.
- An explicit return type goes before an indented body: `(x: Number): Number =>\n  ...`.
- Calls always require parentheses: `add(1, 2)`. There is no implicit call syntax.

## Pipelines

`|>` is the pipeline operator and follows Effect's data-last convention.

```funscript
names =
  users
  |> Array.filter((u) => u.active)
  |> Array.map((u) => u.name)
  |> Array.join(", ")
```

- `value |> f` means `f(value)`.
- `value |> f(a)` means `f(a)(value)`.
- Use `_` to plug the piped value into an uncurried call: `value |> clamp(0, 100, _)`.
- A single stage lowers to a direct call; multiple stages lower to Effect's `pipe`.
- When the piped type is known, stage names resolve against its companion module, so
  `|> filter(...)` can stand in for `|> Array.filter(...)`. Explicit qualification always
  works and user-scope definitions win.

## Records, arrays, and updates

```funscript
user = {
  name: "Ada"
  age: 36
  address: { city: "London" }
}

numbers = [1, 2, 3]
```

Commas are optional when entries are on separate lines, trailing commas are allowed, and
records and arrays are deeply `readonly` at rest.

Update immutable data with a spread. Nested dot-paths lower to a Mutative copy-on-write
update.

```funscript
older = { ...user, age: user.age + 1 }

relocated = {
  ...user
  age: user.age + 1
  address.city: "Paris"
}
```

For multi-step or conditional transforms, use a `mut` draft or the pipeline form:

```funscript
nextUser =
  user
  |> mut (draft) =>
    draft.visits = draft.visits + 1
    draft.tags.push("active")
```

There are no `for`, `while`, `do`, `break`, or `continue` statements. Use Effect collection
modules for pure transforms and `Effect.forEach` for effectful iteration.

## Control flow with `match`

`match` is the only branching construct. With no scrutinee, it matches boolean conditions;
with a scrutinee, it performs structural pattern matching.

```funscript
label =
  match
    | n > 0 => "positive"
    | n #= 0 => "zero"
    | _ => "negative"
```

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

- Arms start with `|` and are indented one level.
- `when` adds a guard: `| Circle(r) when r > 10 => ...`.
- Or-patterns share a handler: `| Admin | Owner => true`.
- Without `_`, matches must be exhaustive; with `_`, the fallback arm must be last.
- A pipeline can branch on its value directly with `|> match`.
- Lowercase pattern names bind; uppercase names are constructors. There is no `if`,
  `else`, `switch`, or ternary.

## Schemas and errors

One `schema` keyword covers data shapes, tagged unions, and compile-time aliases. A
data-shape schema generates both a runtime Effect `Schema` and a static TypeScript type.

```funscript
export schema User = {
  id: UUID
  name: NonEmptyString
  age: Int |> Schema.between(0, 150)
  role: "admin" | "member" = "member"
  bio: Option<String>
}
```

Tagged unions declare variants with `| Variant(...)`:

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)
```

Schema names are also validating constructors. Literal arguments are checked at compile
time; use `Schema.decodeUnknown(Name)` for untrusted input.

```funscript
id = UUID("0b9e6c1e-5f6a-4c6e-9a43-0c2f3b1d9e7a")
ada = User({
  id
  name: "Ada"
  age: 36
})
```

Typed errors use `error` and lower to `Schema.TaggedError`:

```funscript
export error NotFound(id: UUID)
export error ValidationFailed(field: String, message: NonEmptyString)
```

A record schema containing functions or Effects is a compile-time contract, not a runtime
decoder. TypeScript types can also be imported: `schema User = from ts<UserProfile>`.

## Effects

Effect is the only effect model. An `effect` block sequences work with `<-` and ends with
`=> value`. Blocks are scoped by default; use `effect (unscoped)` for resource constructors
that must attach finalizers to the caller's scope.

```funscript
export getUser = (id: String) =>
  effect {
    user <- UserRepo.find(id)
    org <- OrgRepo.find(user.orgId)
    => { user, org }
  }
```

- `name <- effect` binds a result; `_ <- effect` runs and discards it.
- A bare expression is a value, not an execution.
- `effect` blocks automatically track the union of possible errors and required services.
- Recoverable failures are typed values handled with `Effect.catchTag`, `catch`, `retry`,
  `timeout`, and friends. There is no `try`, `catch`, `throw`, `async`, or `await`.
- Library code describes effects. Only entry modules listed in `funscript.json` run them.

## Services and layers

Services are the only dependency-injection mechanism. Implement them with standard Effect
`Layer` constructors.

```funscript
export service Greeter
  greet: (name: String) => Effect<String>

export GreeterLive =
  Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed("Hello, {name}!")
  })
```

Use `Layer.effect` for layers with dependencies and `Layer.scoped` for resource lifecycles.
Inside an `effect` block, `message <- Greeter.greet("Ada")` resolves the service from context
and tracks it in the requirements channel.

## Modules and interop

Modules use ESM syntax only. Top-level declarations are private unless exported.

```funscript
import { Effect, Console } from "effect"
import { UserRepo } from "./services/user-repo.fun"
import type { Lookup } from "./types.fun"

export greet = (name: String) => "Hello, {name}!"

export { Circle, Rect, Shape } from "./shapes.fun"
```

- No `require`, `module.exports`, or dynamic `import()`.
- Use `js` for explicit JavaScript/Promise interop; it lifts native failures into the typed
  `JsInteropError` channel.
- Raw TypeScript blocks are the escape hatch: `` `const x = process.env.X` ``.
- `???` is a typed hole, optionally documented: `??? "todo: handle pagination"`.

## Learn more

- [Compatibility](/guides/compatibility/) — accepted legacy forms and migration notes.
- [Tooling](/guides/tooling/) — compiler, formatter, LSP, and CLI workflows.
- The generated language catalogue and full reference in the repository cover every
  construct, lowering rule, and diagnostic in detail.
