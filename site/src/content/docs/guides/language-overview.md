---
title: Language Overview
description: A comprehensive tour of FunScript — lexical structure, types, bindings, functions, pattern matching, pipelines, schemas, effects, services, concurrency, modules, interop, and tooling.
---

FunScript is a small, indentation-based, expression-oriented language that compiles to readable
TypeScript for the [Effect](https://effect.website) v4 ecosystem. It is a **notation**, not a
runtime: the generated code is ordinary TypeScript built on Effect, [ts-pattern](https://github.com/gvergnaud/ts-pattern),
and [Mutative](https://github.com/unadlib/mutative). There is no FunScript virtual machine,
standard library, package registry, or hidden framework behind the output.

The language is designed around a few principles:

- **Effect-first.** Effects, services, layers, schemas, and structured concurrency are the
  programming model, not add-ons.
- **One notation per job.** If JavaScript or TypeScript has two ways to do something, FunScript
  exposes one — usually the Effect-native form — and rejects the rest with an actionable
  diagnostic.
- **Immutable by default.** Bindings, records, arrays, and schema values are deeply `readonly`
  at rest. Mutation requires an explicit `mut` draft.
- **One declaration, two artifacts.** A data `schema` produces both a static TypeScript type and
  a runtime Effect `Schema` validator.
- **Visible boundaries.** JavaScript and TypeScript interop is explicit through `js` and
  `ts { ... }`, and running an Effect happens only at a designated entry module.

This page describes the language as implemented by FunScript 0.2.3. The
[Syntax](/guides/syntax/) guide is a shorter tour; the repository's `docs/syntax.md` is the full
reference, including planned material.

## At a glance

```funscript
// shapes.fun
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h

export describe = (shape: Shape) =>
  match shape
    | Circle(r) when r |> isGreaterThan(10) => "large circle ({r})"
    | Circle(r) => "circle ({r})"
    | Rect(w, h) => "rectangle {w}x{h}"
```

The emitted TypeScript is direct and readable:

```ts
export const area = (shape: Shape) =>
  match(shape)
    .with({ _tag: "Circle" }, ({ radius: r }) => Math.PI * r * r)
    .with({ _tag: "Rect" }, ({ width: w, height: h }) => w * h)
    .exhaustive();
```

## Lexical structure

### Source files

- Source is UTF-8. LF and CRLF are accepted; the lexer normalizes to LF.
- One file is one module.
- `.fun` files compile to TypeScript; `.funx` files compile to TSX and enable JSX.
- A shebang (`#!`) is allowed only on the first line and is ignored by the compiler.

### Layout and indentation

FunScript is indentation-sensitive.

- Indentation is **2 spaces per level**. Tabs and mixed tabs/spaces are errors.
- A block is opened by a construct that expects one: `=>`, `match`, `effect`, `schema`,
  `service`, `par`, and similar forms.
- Each level is exactly two spaces deeper than its parent. Blank lines and comment-only lines do
  not affect indentation.
- Dedenting closes the current block. The lexer emits pending `DEDENT` tokens before applying
  leading-operator continuation, so a pipeline aligned with an outer block attaches to that
  outer block.
- The formatter always emits 2-space indentation. There is no indentation configuration.

### Comments

Only TypeScript-style line comments exist:

```funscript
// A line comment.
name = "Ada"  // Comments may follow code.
```

`//` inside a string is not a comment. There are no block comments.

### Identifiers and naming

Identifiers are ASCII: `[A-Za-z_][A-Za-z0-9_]*`.

Casing carries meaning:

- **UpperCamel** names are schemas, types, tagged-union constructors, error constructors, and
  services.
- **lowerCamel** names (or `_`) are bindings, functions, parameters, fields, and variables.
- `_` alone is the wildcard pattern, the discard marker in `_ <-`, and the pipeline argument
  placeholder in `|> f(a, _)`.
- `_tag` is reserved. It is the discriminant used by Effect and ts-pattern.

The rule removes the “is this a binding or a constructor?” ambiguity in patterns: a lowercase
pattern name binds; an uppercase pattern name must resolve to a constructor or a compiler-known
pattern such as `Some`, `None`, `Success`, or `Failure`.

### Keywords and reserved words

The language keywords are:

```text
and default effect error export false from import js match mut not or par schema service true ts when
```

`_`, `???`, and `...` are special tokens rather than ordinary keywords.

JavaScript and TypeScript spellings are reserved to produce a targeted error when they are
brought into FunScript source. This includes `let`, `var`, `class`, `new`, `this`, `interface`,
`type`, `enum`, `if`, `else`, `switch`, `return`, `try`, `catch`, `throw`, `async`, `await`,
`function`, `null`, `undefined`, `any`, `as`, `require`, and dynamic `import()`. Reserved words
are still allowed as record field names and after `.` where a property name is expected.

### Literals

```funscript
name = "Ada"
greeting = "Hello, {name}!"     // double quotes interpolate
raw = 'No {interpolation} here.' // single quotes are raw

count = 1_000
ratio = 3.14
scientific = 1e9
hex = 0xFF
binary = 0b1010
octal = 0o755
big = 123n

enabled = true
disabled = false

whitespace = /\s+/g
```

- Decimal, hex, binary, octal, float, exponent, and BigInt literals are supported.
- Double-quoted strings interpolate with balanced braces: `"{(a + b)}"`.
- Escapes include `\n`, `\r`, `\t`, `\\`, `\"`, `\'`, `\{`, `\}`, and `\u{...}`.
- A literal brace is written `\{` or `\}`.
- Multi-line strings are not part of the current language. Use a raw TypeScript block or escaped
  newlines.
- There is **no `null` or `undefined` literal**. Absence is `Option` (`Some` / `None`); unit
  effects use `Effect.void`.
- Regular expression literals are supported. The lexer distinguishes division from a regex from
  the previous significant token.

### Punctuation and operators

| Token | Meaning                                                         |
| ----- | --------------------------------------------------------------- |
| `=>`  | function arrow, function type arrow, match arm, explicit return |
| `<-`  | effect bind inside an `effect` block                            |
| `\|>` | pipeline                                                        |
| `\|`  | match arm or tagged-union variant marker                        |
| `#=`  | value equality                                                  |
| `#!`  | value inequality                                                |
| `@=`  | reference identity                                              |
| `@!`  | reference inequality                                            |
| `???` | typed hole                                                      |
| `...` | spread or rest                                                  |
| `_`   | wildcard, discard, or pipeline argument placeholder             |

There are no semicolons in FunScript source. A semicolon is a parse error with a suggestion to
remove it; semicolons inside raw TypeScript blocks are fine.

### Newlines and continuation

Newlines end statements except:

- inside `()` where a newline is whitespace;
- inside `[]` and `{}` literals, where a newline may separate elements;
- after a trailing binary operator (`+`, `|>`, `=`, `<-`, `=>`, `,`, `.`);
- before a leading `|>`;
- before a leading `.` or `?.` in a member chain;
- before a leading `|` in a `match` block or tagged-union schema.

Canonical pipeline style puts each stage on its own line:

```funscript
names =
  users
  |> Array.filter((u) => u.active)
  |> Array.map((u) => u.name)
  |> Array.join(", ")
```

### Raw TypeScript

A backtick block is emitted verbatim. It is the explicit escape hatch for statements that do not
fit the FunScript surface:

```funscript
legacy = `require("some-legacy-package")`
```

`ts { ... }` is the type-oriented escape hatch and is covered in
[Interop with TypeScript and JavaScript](#interop-with-typescript-and-javascript).

## Types

Type annotations are optional and use PascalCase FunScript names. Native TypeScript spelling is
used only in emitted TypeScript and `ts { ... }` escapes.

### Primitive and collection types

| FunScript       | Emitted TypeScript      | Notes                      |
| --------------- | ----------------------- | -------------------------- |
| `String`        | `string`                | UTF-16 text                |
| `Number`        | `number`                | IEEE-754 number            |
| `Boolean`       | `boolean`               | `true` / `false`           |
| `Void`          | `void`                  | Unit                       |
| `Unknown`       | `unknown`               | Uninspected external value |
| `Never`         | `never`                 | Bottom type                |
| `Array<T>`      | `ReadonlyArray<T>`      | Immutable array            |
| `Option<T>`     | `Option.Option<T>`      | Absence or presence        |
| `Result<A, E>`  | `Result.Result<A, E>`   | Success or typed failure   |
| `Record<K, V>`  | `Record<K, V>`          | String-keyed dictionary    |
| `HashMap<K, V>` | `HashMap.HashMap<K, V>` | Persistent hash map        |
| `HashSet<T>`    | `HashSet.HashSet<T>`    | Persistent hash set        |

`Number` is the general numeric type. Use refined schemas when the domain needs a narrower type:

| Type                      | Runtime schema                          | Guarantee                         |
| ------------------------- | --------------------------------------- | --------------------------------- |
| `Int`                     | `Schema.Int`                            | Whole number; rejects `1.5`       |
| `Float`                   | `Schema.Finite`                         | Rejects `NaN` and infinities      |
| `Decimal`                 | `Schema.BigDecimal`                     | Exact arbitrary-precision decimal |
| `BigInt`                  | `Schema.BigIntFromSelf`                 | Arbitrary-size integer            |
| `NonEmptyString`          | `Schema.NonEmptyString`                 | Non-empty text                    |
| `UUID`, `ULID`            | `Schema.UUID`, `Schema.ULID`            | Validated identifiers             |
| `DateTimeUtc`, `Duration` | `Schema.DateTimeUtc`, `Schema.Duration` | Typed date/time and duration      |

### Effect types

These aliases are available anywhere a type is accepted; the compiler injects the corresponding
`effect` type import when needed.

| FunScript         | TypeScript                |
| ----------------- | ------------------------- |
| `Effect<A, E, R>` | `Effect.Effect<A, E, R>`  |
| `Layer<A, E, R>`  | `Layer.Layer<A, E, R>`    |
| `Stream<A, E, R>` | `Stream.Stream<A, E, R>`  |
| `Queue<A>`        | `Queue.Queue<A>`          |
| `Fiber<A, E>`     | `Fiber.Fiber<A, E>`       |
| `Deferred<A, E>`  | `Deferred.Deferred<A, E>` |
| `PubSub<A>`       | `PubSub.PubSub<A>`        |
| `Ref<A>`          | `Ref.Ref<A>`              |
| `Scope`           | `Scope.Scope`             |

### Records, unions, functions, and generics

```funscript
export schema Point = {
  x: Number
  y: Number
}

export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export schema Lookup = (id: String) => Effect<User, NotFound>
export schema Program = Effect<Void, Never, UserRepo | Logger>

export identity = <A>(value: A): A => value

export mapOption = <A, B>(value: Option<A>, f: (a: A) => B): Option<B> =>
  value |> Option.map(f)
```

- Records are structural and deeply `readonly`.
- Unions use `|` in type position.
- Function types use the same `=>` as function values.
- Generic parameters precede the parameter list: `<A, B>(...) => ...`.
- A type parameter may be constrained with `extends`, as in `<Client extends RedisClient>`.
  This is a TypeScript generic constraint, not class inheritance.

### Absence and failure

FunScript has no `null` or `undefined` values. Optional data is `Option<A>`:

```funscript
export findName = (users: Array<User>, id: String): Option<String> =>
  users
  |> Array.findFirst((user) => user.id #= id)
  |> Option.map((user) => user.name)
```

`Result<A, E>` is used when a pure operation returns either a value or a typed failure. Inside
effects, the `E` channel of `Effect<A, E, R>` is the normal error mechanism.

### No unsafe types or casts

`any`, `as` in every form, `null`, `undefined`, `typeof`, `instanceof`, and `in` are rejected in
FunScript source. External values enter as `Unknown` and are narrowed by decoding a schema:

```funscript
export loadUser = (raw: Unknown) =>
  effect {
    user <- raw |> decode(User)
    => user
  }
```

`Unknown` is the safe counterpart of `any`: it can be passed around, but it cannot be used as a
domain value until a schema, match, or explicit boundary adapter narrows it.

## Bindings and mutability

Bindings are immutable by default and compile to `const`.

```funscript
name = "Ada"
age = 36
user = { name, age }

count: Number = 0
user: User = { id: "1", name: "Ada" }
```

Destructuring works in bindings, parameters, and patterns:

```funscript
{ name, age } = user
{ name: displayName, ...rest } = user
[first, ...tail] = items
```

Without `mut`, `=` always introduces a new immutable binding; it never reassigns. Re-declaring or
reassigning an immutable name in the same block is a compiler error. To create a modified copy,
use a spread:

```funscript
older = {
  ...user
  age: user.age + 1
  address.city: "Paris"
}
```

### Explicit local mutability

Mutation is explicit and local. `mut` declares a mutable local binding:

```funscript
export accumulate = (user: User, delta: Number) =>
  mut total = 0
  total = total + delta
  mut current = user
  current.visits = current.visits + total
  => current
```

Rules:

- `mut name = expr` compiles to `let name = expr`.
- Reassigning a `mut` binding uses ordinary `=`.
- Field, index, and array-method updates on a `mut` binding compile to a Mutative
  copy-on-write `create(...)` pass. The original value is never mutated in place.
- `mut` is local only: it may appear inside function bodies and `effect` blocks, never at module
  top level. Module-level state belongs in a `service` and `Layer`.
- A `mut` binding cannot be captured and mutated across a closure boundary. Shared or concurrent
  state uses `Effect.Ref`, `SynchronizedRef`, or `Queue`.
- Destructuring bindings cannot be `mut`.
- `let`, `var`, `:=`, `++`, and `--` do not exist.

## Functions

Functions are lambdas assigned with `=`. Parameters are always parenthesized.

```funscript
add = (a: Number, b: Number) => a + b

answer = () => 42

identity = <A>(value: A): A => value

greet = (name: String) =>
  trimmed = name |> String.trim
  => "Hello, {trimmed}!"
```

- A single-argument function requires parentheses: `(x) => x`. Bare `x => x` is rejected.
- A zero-argument function uses `() => expression`.
- Parameters may destructure records or arrays: `({ id, name }: User) => ...`.
- A default parameter, such as `(count: Number = 5)`, accepts omission and is a plain `Number`
  inside the function. Defaults are evaluated lazily and preserve `false`, `0`, empty strings,
  and `null`.
- Rest parameters use `...name: Array<T>` or `...name`; argument and array spreads use
  `f(...args)` and `[1, ...items]`.
- Optional data uses `Option<T>`; the `?` optional parameter/field syntax is disabled.
- Function parameters are immutable and cannot be marked `mut`.

### Explicit returns

An inline expression is the concise return form. An indented function block must end
with an explicit `=> value`:

```funscript
absolute = (value: Number): Number =>
  match
    | value < 0 => -value
    | _ => value
```

The final bare expression of a multi-statement block is never returned implicitly. This prevents
side-effecting calls from silently becoming return values:

```funscript
saveState = (state: State) =>
  serialized = serialize(state)
  writeDisk(serialized)
  => Void
```

A single-expression JSX body in a `.funx` file is the one implicit-return exception:

```funscript
export Message = () =>
  <div className="message">
    <p>Hello, World!</p>
  </div>
```

### `when`

`when` has three forms:

- `| Pattern when condition => value` guards a match arm.
- `when (condition) { ... }` (or an indented body) conditionally executes statements and then
  continues.
- `when (condition) => value` returns early from a function. This form requires
  `allowEarlyReturns: true`; `match` is the default idiomatic form.

### Typed holes

`???`, optionally followed by a label, is a type-driven placeholder for work that is not written
yet:

```funscript
export checkout = (user: User, cart: Cart) =>
  effect {
    total = calculateTotal(cart)
    => ??? "charge payment provider"
  }
```

A hole lowers to a `never`-typed throw, so it fits any expected type without poisoning inference
the way `any` would. The compiler reports the expected type and the bindings in scope as a warning
during `check`, `dev`, and `test`, and treats the hole as a hard error in `build` and
`check --strict`, so unfinished work cannot ship.

### No classes, methods, or `new`

FunScript has no `class`, `new`, `this`, `super`, or prototype syntax. Plain data is a record or a
schema; tagged unions are `schema` variants; typed errors are `error`; dependencies are
`service` plus `Layer`. If a JavaScript library requires construction with `new`, wrap it at the
boundary or use a raw TypeScript block.

Calls always require parentheses: `add(1, 2)`. There is no implicit call syntax; `f x` is a parse
error.

## Operators

### Precedence

From lowest to highest:

| Level | Operators              | Notes                                        |
| ----- | ---------------------- | -------------------------------------------- |
| 1     | `\|>`                  | Pipeline, left-associative                   |
| 2     | `or`                   | Logical or                                   |
| 3     | `and`                  | Logical and                                  |
| 4     | `#=`, `#!`, `@=`, `@!` | Value equality and reference identity        |
| 5     | `<`, `<=`, `>`, `>=`   | Relational comparison; numeric operands only |
| 6     | `+`, `-`               | Additive                                     |
| 7     | `*`, `/`, `%`          | Multiplicative                               |
| 8     | `**`                   | Exponent, right-associative                  |
| 9     | `not`, unary `-`       | Prefix                                       |
| 10    | call, member, index    | Postfix                                      |

### Equality

`#=` and `#!` compare by value. Structured values use Effect `Equal.equals`; primitives use strict
JavaScript equality. `@=` and `@!` compare reference identity and are restricted to reference-like
values such as objects, arrays, functions, and schemas.

```funscript
sameValue = a #= b
differentValue = a #! b
sameReference = a @= b
differentReference = a @! b
```

### Comparisons

`<`, `<=`, `>`, and `>=` are valid only when both operands are statically known to be numbers.
FunScript never applies them to strings or Effect domain values; use an explicit `Order` or the
typed comparison shorthand instead.

```funscript
// Numeric comparison
isValid = score >= 0 and score <= 100

// Typed comparison shorthand, resolved from the operand's static type
isBeforeDeadline = score |> lessThan(deadline)
inRange = score |> between(0, 100)
isExpired = now |> greaterThan(token.expiresAt)

// Explicit ordering
isBefore = name |> Order.isLessThan(String.Order)("m")
```

### Boolean operators

The only boolean operators are `and`, `or`, and `not`:

```funscript
match
  | user.active and not user.suspended => send(user)
  | _ => archive(user)
```

`&&`, `||`, and `!` are rejected.

There are no bitwise operators (`&`, `|`, `^`, `<<`, `>>`, `>>>`). `|` is reserved for match arms
and tagged-union variants. There is also no ternary operator and no `if` / `else`; use `match`.

## Pipelines

`|>` follows Effect's data-last convention:

```funscript
names =
  users
  |> Array.filter((u) => u.active)
  |> Array.map((u) => u.name)
  |> Array.join(", ")
```

Semantics:

- `value |> f` means `f(value)`.
- `value |> f(a)` means `f(a)(value)` — a curried data-last stage.
- `value |> f(a, _)` or `value |> f(_, b)` plugs the piped value into the `_` argument slot of an
  uncurried function.
- At most one `_` may appear as a direct call argument of a pipeline stage. Nested uses such as
  `f(g(_))` or `_.field` are rejected; write an explicit lambda instead.
- A single stage lowers to a direct call. Two or more stages lower to Effect's `pipe`.
- There is no point-free `>>` composition operator. Write `(x) => x |> f |> g` or call
  `flow(f, g)`.

```funscript
// Effect data-last APIs need no placeholder
result =
  value
  |> Effect.map(normalize)
  |> Effect.flatMap(save)

// Uncurried functions use `_` for the piped slot
score =
  rawScore
  |> parseScore
  |> clamp(0, 100, _)
  |> formatScore(_, "en-US")
```

### Type-directed resolution

When the piped value's type is known, a bare stage name resolves against the companion module of
that type:

```funscript
topActive =
  users
  |> filter((u) => u.active)
  |> sortBy((u) => u.name)
  |> take(10)
  |> map((u) => u.name)
```

This compiles to `pipe(users, Array.filter(...), Array.sortBy(...), Array.take(10), Array.map(...))`.

The companion registry includes:

| Piped type                      | Companion module  |
| ------------------------------- | ----------------- |
| `Array<T>` / `ReadonlyArray<T>` | `effect/Array`    |
| `Option<T>`                     | `effect/Option`   |
| `Result<A, E>`                  | `effect/Result`   |
| `Chunk<T>`                      | `effect/Chunk`    |
| `Effect<A, E, R>`               | `effect/Effect`   |
| `Schedule<Env, In, Out>`        | `effect/Schedule` |
| `Layer<ROut, E, RIn>`           | `effect/Layer`    |
| `Stream<A, E, R>`               | `effect/Stream`   |
| `Schema<A, I, R>`               | `effect/Schema`   |
| `Record<K, V>`                  | `effect/Record`   |
| `String`                        | `effect/String`   |
| `DateTime`                      | `effect/DateTime` |
| `HashMap<K, V>`                 | `effect/HashMap`  |
| `HashSet<T>`                    | `effect/HashSet`  |

Resolution rules:

1. **User scope wins.** A local or explicitly imported `filter` shadows `Array.filter`.
2. **Types come from TypeScript.** The compiler inspects the static type of the left-hand
   expression.
3. **Imports are injected.** The required companion module import is added to the emitted file.
4. **Explicit qualification always works.** `Array.filter` and `Effect.map` are always valid and
   emit the same code as the inferred forms.

If a bare stage is ambiguous for an untyped or unproven receiver, the compiler raises a
`PipelineResolutionError` listing the candidates. Qualify the stage or annotate the receiver;
there is no priority fallback.

### Pipe into `match`

A pipeline can branch on its own value without a temporary variable:

```funscript
displayName =
  users
  |> Array.findFirst((u) => u.id #= targetId)
  |> match
    | Some(user) => user.name
    | None => "Guest"
```

## Records, arrays, and updates

```funscript
user = {
  name: "Ada"
  age: 36
  address: { city: "London" }
}

numbers = [1, 2, 3]
matrix = [
  [1, 2]
  [3, 4]
]
```

- Commas are optional when entries are on separate lines; trailing commas are allowed.
- Shorthand entries (`{ name }`) and spreads (`{ ...user, age: 37 }`, `[0, ...numbers]`) are
  supported.
- Field access is `user.address.city`; optional access is `user.address?.city`.
- Records, schema values, tagged-union variants, and `Array<T>` are deeply `readonly` at rest.
  Direct in-place mutation without `mut` is a compile-time error.

### Shallow and deep updates

A record spread is a declarative update. A shallow field emits a plain object spread; a nested
dot-path emits a Mutative copy-on-write update:

```funscript
older = { ...user, age: user.age + 1 }

relocated = {
  ...user
  age: user.age + 1
  address.city: "Paris"
}
```

```ts
const older = { ...user, age: user.age + 1 };

const relocated = create(user, (draft) => {
  draft.age = user.age + 1;
  draft.address.city = "Paris";
});
```

### Imperative drafts

For multi-step or conditional transforms, use a `mut` draft:

```funscript
export recordLogin = (user: User) =>
  mut draft = user
  draft.visits = draft.visits + 1
  draft.tags.push("active")
  => draft
```

Or use the pipeline form, which scopes the draft to the stage and returns the updated value:

```funscript
nextUser =
  user
  |> mut (draft) =>
    draft.visits = draft.visits + 1
    draft.tags.push("active")
```

Consecutive assignments and mutating array methods on the same draft coalesce into one Mutative
pass. Returning a sub-reference of the draft or capturing it in an escaping closure is a
`funscript check` error.

### Iteration

There are no `for`, `while`, `do`, `break`, or `continue` statements, and no comprehension
syntax.

Pure collection transforms use Effect's data-last modules:

```funscript
squares =
  numbers
  |> Array.filter((n) => n > 0)
  |> Array.map((n) => n * n)
```

Effectful iteration uses `Effect.forEach`:

```funscript
users <- Effect.forEach(ids, (id) => UserRepo.find(id))
```

Recursion is available when an algorithm genuinely needs it. Local synchronous accumulation can
use `mut`; shared or concurrent state uses `Ref`, `Queue`, or another Effect primitive.

## Pattern matching

`match` is the only branching construct. There is no `if`, `else`, `then`, `switch`, or `? :`.

### Subjectless match

With no scrutinee, each arm tests a boolean condition top-to-bottom, and `| _ =>` is the
fallback:

```funscript
label =
  match
    | n > 0 => "positive"
    | n #= 0 => "zero"
    | _ => "negative"
```

Inline form:

```funscript
label = match | n > 0 => "positive" | _ => "negative"
```

When a subjectless match is used as a value, a trailing `| _ =>` arm is required so an unhandled
case cannot silently become `undefined`. In statement position the fallback may be omitted.

### Value and structural match

```funscript
export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

- Arms are indented one level and start with `|`.
- An arm body is an inline expression or an indented block.
- `when` adds a guard: `| Circle(r) when r |> isGreaterThan(10) => ...`.
- Or-patterns share a handler: `| Admin | Owner => true`.
- Without `_`, the compiler emits `.exhaustive()`; with `_`, it emits `.otherwise()`.
- A `_` arm must be last; unreachable arms are an error.
- Exhaustiveness is checked for finite unions. For open types such as `String` or `Number`, use
  `_` or a guard; the compiler reports that an exhaustive match cannot be proven.

```funscript
export describe = (shape: Shape) =>
  match shape
    | Circle(r) when r |> isGreaterThan(10) => "large circle ({r})"
    | Circle(r) => "circle ({r})"
    | Rect(w, h) => "rectangle {w}x{h}"
```

Block arm:

```funscript
match exit
  | Success(value) =>
    normalized = normalize(value)
    { ok: true, value: normalized }
  | Failure(error) => { ok: false, error }
```

### Patterns

| Pattern             | Example                            | Meaning                                                         |
| ------------------- | ---------------------------------- | --------------------------------------------------------------- |
| wildcard            | `_`                                | Matches anything, binds nothing                                 |
| binding             | `name`                             | Matches anything, binds a lowercase name                        |
| literal             | `42`, `"ok"`, `true`               | Exact literal match                                             |
| nullary constructor | `None`, `Red`, `Boom`              | Matches `{ _tag: "None" }`                                      |
| constructor         | `Circle(r)`                        | Matches `_tag` and binds positional fields in declaration order |
| nested constructor  | `Circle(10)`, `Some({ id, name })` | Lowers nested literal/record sub-patterns                       |
| or-pattern          | `Admin \| Owner`, `"Sat" \| "Sun"` | Matches if any alternative matches                              |
| record              | `{ kind: "click", x, y }`          | Structural object match                                         |
| array               | `[first, ...rest]`                 | Structural array match                                          |

Capitalization is the disambiguation rule: lowercase names bind, uppercase names are
constructors. To compare against a variable value, use a guard:
`| value when value #= expected => ...`.

`Some(value)` / `None` and `Success(value)` / `Failure(cause)` are compiler-known patterns that
lower to structural `_tag` matches and work with TypeScript narrowing.

## Schemas

A single `schema` keyword covers data shapes, tagged unions, and compile-time aliases.

### Data schemas

A data-shape `schema` generates both a runtime Effect `Schema` and a static TypeScript type with
the same name:

```funscript
export schema Username = String |> Schema.trimmed
|> Schema.minLength(3)
|> Schema.brand("Username")

export schema Age = Int |> Schema.between(0, 150)

export schema User = {
  id: UUID
  name: Username
  age: Age
  role: "admin" | "member" = "member"
  bio: Option<NonEmptyString>
  visits: NonNegativeInt = 0
}
```

- `field: Option<T>` decodes an omitted, `null`, or `undefined` value to `Option.none()`, and a
  present value to `Option.some(value)`. Encoding `None` omits the field.
- `field: T = default` applies the decoded default lazily during decoding.
- `|> Schema.*` refinements work on fields and on the schema itself.
- All fields are `readonly` in the static type.

A schema name is also a validating constructor. Literal arguments are checked at compile time;
non-literal arguments validate at runtime. For untrusted input, decode explicitly:

```funscript
id = UUID("0b9e6c1e-5f6a-4c6e-9a43-0c2f3b1d9e7a")
name = Username("ada")

ada = User({
  id
  name
  age: 36
})

// At a boundary
user <- rawInput |> decode(User)
```

`Schema.decodeUnknown(User)`, `Schema.decodeUnknownResult(User)`, and
`Schema.decodeUnknownSync(User)` are also available. JSON text must first be parsed, for example
with `Schema.parseJson(User)` or the ambient `decodeJson(User)` helper.

### Tagged unions

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export schema Color =
  | Red
  | Green
  | Blue
```

Tagged unions lower to `Data.TaggedEnum`, positional constructor functions, and a companion
`Schema.Union` of tagged structs. Variant names are UpperCamel and unique within the module. A
nullary variant is a value: `Red`, not `Red()`.

### Generic data schemas

A generic data record is a schema factory. Pass a runtime schema for each type parameter to create
the concrete decoder:

```funscript
export schema Page<A> = {
  items: Array<A>
  next: Option<String>
}

export schema Country = {
  name: String
}

export countryPageSchema = Page(Country)
export names = (page: Page<Country>) => page.items |> Array.map((country) => country.name)
```

Defaults, recursive generic declarations, and generic tagged-union decoders are not supported.

### Compile-time contracts

When a schema contains functions, `Effect`, `Layer`, `Stream`, services, or `unknown`, it is a
compile-time TypeScript contract rather than a runtime decoder:

```funscript
export schema Lookup = (id: String) => Effect<User, NotFound>
```

Using a compile-time-only schema in value position, such as passing it to `Schema.decodeUnknown`,
is a compiler error. A record containing a function or Effect field is likewise a contract; it
has no `FromUnknown` decoder or `SchemaInput` type.

### Imported TypeScript schemas

`schema Name = from ts<Type>` derives an Effect `Schema`, a static type, and a `NameFromUnknown`
decoder from an imported TypeScript type:

```funscript
import type { UserProfile } from "./schema-types.js"

export schema User = from ts<UserProfile>
```

Supported constructs include primitives, literals, arrays, records, object types, optional
properties, nullable and undefined unions, general unions, and recursive root records. `any`,
`unknown`, `never`, functions, classes, and unsupported built-ins such as `Date`, `Map`, and
`Promise` are rejected with a source-mapped diagnostic rather than silently widened.

### `SchemaInput`

`SchemaInput<Name>` is the encoded input type of a named schema. It is a static type only; using
it does not decode, validate, or apply defaults.

```funscript
export readNickname = (profile: Profile) => profile.nickname
export fromInput = (input: SchemaInput<Profile>) => readNickname(ProfileFromUnknown(input))
```

## Errors and failure

Typed errors are declared with `error` and lower to `Schema.TaggedError`:

```funscript
export error NotFound(id: UUID)
export error ValidationFailed(field: String, message: NonEmptyString)
export error Boom
```

Construct them positionally:

```funscript
Effect.fail(NotFound(id))
Effect.fail(ValidationFailed("email", "required"))
Effect.fail(Boom())
```

An error is both a real Effect tagged error — usable with `catchTag`, `catch`, `Effect.fail`, stack
traces, and `match` — and a runtime `Schema` that can be serialized or decoded across HTTP and RPC
boundaries.

### The typed error channel

Recoverable failures live in the `E` channel of `Effect<A, E, R>`:

```funscript
export findUser = (id: String) =>
  effect {
    user <- UserRepo.find(id)
    => user
  }
  |> Effect.catchTag("NotFound", (e) =>
    Effect.succeed({ id: e.id, name: "anonymous" })
  )
```

Sequencing operations with different error types automatically tracks the union:

```funscript
export checkout = (cartId: String) =>
  effect {
    cart <- CartRepo.find(cartId)
    _ <- PaymentGateway.charge(cart.total)
    _ <- Inventory.reserve(cart.items)
    => cart
  }

// Effect<Cart, NotFound | PaymentDeclined | OutOfStock, CartRepo | PaymentGateway | Inventory>
```

Use `Effect.catch`, `Effect.catchTag`, `Effect.retry`, `Effect.timeout`, `Effect.orElse`, and the
rest of the combinators to handle failures. `|> orDie` demotes a failure to an uncatchable defect
and removes it from `E`:

```funscript
raw <- ConfigRepo.loadDefault |> orDie
```

Defects use `Effect.die`; they are not part of the typed channel.

There is no `try`, `catch`, `throw`, `finally`, `async`, or `await`. A native throw or Promise
rejection at a `js` boundary becomes the typed `JsInteropError` channel.

## Effects

Effect is the only effect model. An `effect` block sequences work with `<-` and ends with
`=> value`.

```funscript
export getUser = (id: String) =>
  effect {
    user <- UserRepo.find(id)
    org <- OrgRepo.find(user.orgId)
    => { user, org }
  }
```

- `name <- effect` binds the result.
- `_ <- effect` runs and discards the result.
- A bare expression is a value, not an execution. Every non-final statement in an `effect` block
  must be a binding, a reassignment, an effect bind, or a control-flow statement.
- The block must end with an explicit return, `=> value`.
- An `Effect` returned with `=>` is returned as a value, not automatically yielded. The compiler
  warns when an effect block returns an `Effect`, because that usually means a missing `_ <-`.
- The block automatically tracks the union of possible errors and required services in its `E`
  and `R` channels.

This rule prevents the classic `Effect.gen` mistake:

```funscript
// Rejected: Console.log is created but never executed.
effect {
  user <- UserRepo.find(id)
  Console.log("loaded")
  => user
}
```

The fix is explicit:

```funscript
effect {
  user <- UserRepo.find(id)
  _ <- Console.log("loaded")
  => user
}
```

### Scoped and unscoped blocks

`effect { ... }` is scoped by default. It lowers to `Effect.scoped(Effect.gen(...))`, so resources
acquired with `Effect.acquireRelease` or `Effect.addFinalizer` are closed when the block exits:

```funscript
export processFile = (path: String) =>
  effect {
    file <- acquireFile(path)
    data <- readFile(file)
    => data
  }
```

A **resource constructor** that must attach a finalizer to the caller's scope uses
`effect (unscoped)`. It lowers to `Effect.gen(...)` without the `Effect.scoped` wrapper and
requires `Scope` in `R`:

```funscript
export openSocket = (url: String) =>
  effect (unscoped) {
    socket <- connect(url)
    _ <- Effect.addFinalizer(() => close(socket))
    => socket
  }
```

Registering a finalizer in a scoped block and returning a non-`Void` value triggers the
`FS_PREMATURE_FINALIZER_CLOSE` diagnostic, because the finalizer would run immediately when the
block returns.

### Running effects

Library code describes effects; it does not run them. Running happens once, at the edge, in an
**entry module**:

```funscript
// src/main.fun
export main =
  program
  |> Effect.provide(AppLive)
```

`funscript run` and the scaffolded entry point execute `main` with the platform runtime's
`runMain`, which handles interruption signals, finalizers, unhandled failures, and the process
exit code.

`Effect.runPromise`, `runSync`, `runFork`, `runCallback`, `Runtime.run*`, and `ManagedRuntime` are
allowed only in modules listed under `entry` in `funscript.json` (default `["src/main.fun"]`).
Everywhere else they are a `funscript check` error. Tests use `it.effect` / `it.scoped` and never
call `run*`.

## Services and layers

Services are the only dependency-injection mechanism. They are declared with `service`:

```funscript
export service Greeter
  greet: (name: String) => Effect<String>

export GreeterLive =
  Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed("Hello, {name}!")
  })

export ConfigurableGreeterLive =
  Layer.effect(Greeter, effect {
    prefix <- PrefixConfig
    => {
      greet: (name) => Effect.succeed("{prefix}, {name}!")
    }
  })
```

- `service Name` uses the service name as the context tag.
- `service Name "custom/tag"` sets an explicit tag. Duplicate tags across a project are a
  `funscript check` error.
- `Layer.succeed(Service, { ... })` builds a pure layer.
- `Layer.effect(Service, effect { ... })` builds a layer with dependencies.
- `Layer.scoped(Service, effect { ... })` builds a layer that manages resource lifecycles.
- Direct calls such as `message <- Greeter.greet("Ada")` resolve the service from context and
  track `Greeter` in `R`.
- `greeter <- Greeter` binds the full service instance when an explicit reference is preferred.

There are no globals, module-level singletons, or service locators. Use `Config` for environment
configuration, `Clock`/`DateTime` for time, and `Random` for randomness.

## Concurrency

Concurrency uses Effect fibers: lightweight, structured green threads. A fiber is owned by its
parent or a `Scope`, interruption propagates automatically, and a failing worker cancels its
siblings.

### Structured parallelism with `par`

`par` runs all bound tasks in parallel and returns a record of the bound names. It defaults to
`concurrency: "inherit"`:

```funscript
export fetchDashboard = (userId: String) =>
  par {
    user <- fetchUser(userId)
    orders <- fetchOrders(userId)
  }
```

A custom concurrency limit is written in parentheses:

```funscript
export fetchLimited = par (2) {
  a <- taskA()
  b <- taskB()
  => a + b
}
```

Early returns are rejected inside `par`, so a sibling fiber cannot be orphaned.

### Effect combinators

Most concurrency is “run these N things in parallel and collect the results”, which never needs
an explicit fork:

```funscript
// At most 8 in flight; the first failure interrupts the rest
users <- ids |> Effect.forEach(fetchUser, { concurrency: 8 })

// Fixed set of heterogeneous tasks with a typed record result
{ profile, orders, prefs } <-
  Effect.all(
    { profile: getProfile(id), orders: getOrders(id), prefs: getPrefs(id) },
    { concurrency: 3 }
  )

// First to succeed wins; the loser is interrupted
data <- Effect.race(fetchFromPrimary(key), fetchFromReplica(key))

// Deadline
report <- buildReport |> Effect.timeout("30 seconds")
```

### Fibers, queues, and shared state

```funscript
jobs <- Queue.bounded<Job>(100)
_ <- Effect.forkScoped(producer(jobs))
job <- Queue.take(jobs)

fiber <- Effect.forkScoped(task)
result <- Fiber.join(fiber)

counter <- Ref.make(0)
_ <- Ref.update(counter, (n) => n + 1)
```

- `Effect.forkScoped` is the default fork. Its lifetime is the enclosing `Scope`.
- `Effect.forkChild` is owned by the parent fiber and is also allowed.
- `Effect.forkDetach` is flagged by `funscript check`; detached fibers outlive their owner.
  Long-lived background work belongs in a layer.
- Concurrency is explicit and bounded. `Effect.all` and `Effect.forEach` are sequential unless
  you pass `concurrency`; `concurrency: "unbounded"` is a warning.
- Shared state between fibers uses `Ref`, `SynchronizedRef`, `Queue`, `PubSub`, or `Deferred`,
  never a closure-captured `mut`.
- `Queue<A>`, `Fiber<A, E>`, `Deferred<A, E>`, `PubSub<A>`, and `Scope` are blessed type aliases.

## Modules, imports, and exports

Modules use ESM syntax only. Top-level declarations are private unless exported.

```funscript
import { Effect, Console } from "effect"
import { UserRepo } from "./services/user-repo.fun"
import type { Lookup } from "./types.fun"
import "./app.css"
import React, { useState } from "react"
import * as ReactDOM from "react-dom/client"

export greet = (name: String) => "Hello, {name}!"

export { Circle, Rect, Shape } from "./shapes.fun"
```

Supported import forms:

- named imports: `import { Effect } from "effect"`;
- renamed default imports: `import { default as stylesheet } from "./app.css?url"`;
- type-only imports: `import type { Lookup } from "./types.fun"`;
- default imports: `import React from "react"`;
- namespace imports: `import * as ReactDOM from "react-dom/client"`;
- combined default plus named or namespace imports;
- side-effect-only imports: `import "./app.css"`.

Exportable declarations:

```funscript
export name = ...
export schema User = ...
export schema Shape = | Circle(radius: Number) | Rect(width: Number, height: Number)
export error NotFound(...)
export service Greeter ...
export { Name } from "./other.fun"
```

Rules:

- No `require`, `module.exports`, or dynamic `import()`.
- Named exports are the default style. `export default expression` is supported for framework
  integration, such as route components; only one default export is allowed per file.
- Module specifiers are preserved in emitted TypeScript. Choose specifiers supported by the target
  runtime or bundler. The Vite plugin resolves a relative `.js` import to a `.fun` or `.funx`
  source when the `.js` file does not exist; local FunScript imports may also use the `.fun` path
  directly.
- Import order is preserved; the formatter never reorders imports.
- A `.fun` and `.funx` file with the same stem in one source set are rejected because their
  JavaScript-style import would be ambiguous.

## Interop with TypeScript and JavaScript

FunScript treats JavaScript and TypeScript as explicit boundaries, not as a second in-language
style.

### `js`: Promise and native interop

Inside an `effect` block, `js` lifts a JavaScript Promise or native call into an Effect:

```funscript
export fetchGreeting = (name: String) =>
  effect {
    greeting <- js loadGreeting(name)
    => greeting
  }
```

- Native throws and Promise rejections become the typed `JsInteropError` channel.
- A `Promise<A>` becomes `Effect<A, JsInteropError>`.
- A `Promise<A | null | undefined>` becomes `Effect<Option<A>, JsInteropError>`.
- An `any`, `unknown`, or unresolved native result becomes `Effect<Option<Unknown>, JsInteropError>`;
  handle `None` and decode `Some` with a schema before use.

Handle the interop error explicitly:

```funscript
export loadProfile = (id: String) =>
  effect {
    profile <- js fetchProfile(id)
    => profile
  }
  |> Effect.catchTag("JsInteropError", (e) =>
    Effect.fail(ProfileUnavailable(e.message))
  )
```

`export js` exposes a FunScript function to JavaScript as a Promise-returning function. Its
generated wrapper validates annotated parameters at the boundary before running the body:

```funscript
export js getPublicGreeting = (name: String) =>
  effect {
    greeting <- fetchGreeting(name)
    => greeting
  }
```

### `ts`: TypeScript escape hatches

`ts { ... }` embeds verbatim TypeScript for types, expressions, and declarations that are better
expressed directly in TypeScript:

```funscript
ts { type Timestamp = number; }

export schema Settings = ts { Record<string, string> }

export schema Position = ts { import("vscode-languageserver").Position }
```

Backtick blocks are the statement-oriented raw escape hatch:

```funscript
legacy = `require("some-legacy-package")`
```

Raw blocks are emitted in place. Use them sparingly; they are expected to be rare and greppable.

### Imported TypeScript types as schemas

`schema Name = from ts<Type>` derives a runtime Effect `Schema` and a `NameFromUnknown` decoder
from an imported TypeScript type:

```funscript
import type { UserProfile } from "./schema-types.js"

export schema User = from ts<UserProfile>

export decodeUser = (raw: Unknown) => UserFromUnknown(raw)
```

The referenced type must be imported or declared locally in a `ts { ... }` block. Derivation is
compile-time and concrete; unsupported types are rejected rather than widened.

### Boundaries and safety

- Type annotations do not validate runtime values. Treat HTTP JSON, CLI arguments, environment
  variables, database rows, and file input as `Unknown` and decode them with a schema.
- Imported JavaScript functions retain their TypeScript declarations. An imported `any` remains
  `any`; wrap it in a typed adapter or decode its result.
- `--no-ts` rejects `ts { ... }`, `as { ... }`, and standalone JavaScript/TypeScript files in the
  audited paths. It is an opt-in audit, not a sandbox; run it in CI to enforce a FunScript-only
  area.
- `effectOnly` project policy rejects raw escapes, JS interop, ambient side-effect APIs, and
  non-Effect package imports in selected directories.

## Testing and tooling

The `funscript` CLI stays small and composable. It does not create a proprietary project layout
or package format.

### CLI

| Command                    | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `funscript check`          | Type-check sources with source-mapped diagnostics; `--json`, `--sarif` |
| `funscript fmt`            | Format or verify `.fun` / `.funx`; `--check`, `--diff`, `--stdin`      |
| `funscript run`            | Bundle and run a program with its local imports                        |
| `funscript build`          | Emit TypeScript/TSX, or bundle a Bun executable with `--target bun`    |
| `funscript emit`           | Compile one file to TypeScript or TSX                                  |
| `funscript test`           | Run unit and integration tests through Vitest or Bun                   |
| `funscript init`           | Scaffold a project; alias `new`                                        |
| `funscript repl`           | Start an interactive REPL                                              |
| `funscript lsp`            | Start the Language Server Protocol server                              |
| `funscript explain`        | Show reference documentation for a keyword or construct                |
| `funscript doc`            | Generate HTML, Markdown, or JSON documentation from source             |
| `funscript doctor`         | Check Node version, module mode, config, and generated type views      |
| `funscript tsc`            | Run `tsc` and map type-view diagnostics back to FunScript sources      |
| `funscript pipeline-style` | Convert stages between bare and qualified pipeline style               |
| `funscript version`        | Display the version; aliases `-v` and `--version`                      |

Typical project scripts:

```json
{
  "type": "module",
  "scripts": {
    "check": "funscript check src",
    "format": "funscript fmt src",
    "format:check": "funscript fmt src --check",
    "run": "funscript run src/main.fun",
    "build": "funscript build src/main.fun",
    "test": "funscript test"
  }
}
```

### Tests

FunScript tests can be written in FunScript using the universal test helpers exported from
`funscript/test`, which delegate to Vitest, Bun, or `funscript test`:

```funscript
import { describe, expect, it } from "funscript/test"

export add = (a: Int, b: Int): Int => a + b

suite = describe("math", () =>
  it("adds", () =>
    expect(add(2, 3)).toBe(5)
  )
)
```

Effect tests use `@effect/vitest`. They never call `Effect.run*`; the test runner provides the
runtime, and `TestClock` and seeded `Random` make time and randomness deterministic:

```funscript
import { expect, it } from "@effect/vitest"
import { Effect, TestClock } from "effect"

suite = it.effect("expires after one hour", () =>
  effect {
    token <- issueToken(user)
    _ <- TestClock.adjust("61 minutes")
    expired <- isExpired(token)
    => expect(expired).toBe(true)
  }
)
```

### Formatter and project policy

The formatter is canonical and has no style configuration beyond `indentSize` and `lineWidth`:

```funscript
export config = {
  noTs: ["app/domain", "app/services"]
  noGlobalThis: ["app/domain", "app/services"]
  barePipelines: ["app/domain", "app/services"]
  noDeepDestructure: ["app/domain", "app/services"]
  maxDestructureDepth: 2
  effectOnly: ["app/domain"]
  format: { indentSize: 2, lineWidth: 100 }
}
```

`funscript.config.fun` is parsed as a single literal exported record and is never executed. It is
loaded by `check`, `build`, `emit`, `run`, the REPL, the language server, and the Vite and Bun
plugins.

### Editor and build integrations

- The Vite plugin compiles `.fun` and `.funx` in memory: `funscript/vite`.
- The Bun plugin is `funscript/bun`; esbuild integration is `funscript/esbuild`.
- The VS Code extension and the LSP provide diagnostics, hover, go-to-definition, rename,
  inlay hints, and pipeline refactorings.
- `funscript explain <topic>` is a quick offline reference for a keyword, construct, or operator.

### Safety checks

`funscript check` enforces architectural boundaries in addition to types. Representative
diagnostics include:

| Diagnostic                 | Rejects                                                        | Use instead                                    |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `FS_HIDDEN_INPUT`          | `Date.now`, `Math.random`, `performance.now`, `crypto.random*` | `Clock`, `DateTime`, `Random`                  |
| `FS_EFFECT_RUN`            | `Effect.run*` outside entry modules                            | Return the `Effect`; run it in `main`          |
| `FS_ENV_GLOBAL`            | `process.env`, `Deno.env`, `Bun.env` outside entry modules     | `Config`                                       |
| `FS_DETACHED_FIBER`        | `Effect.forkDetach` outside entry modules                      | `Effect.forkScoped` or `Effect.forkChild`      |
| `FS_UNBOUNDED_CONCURRENCY` | `concurrency: "unbounded"`                                     | An explicit numeric limit                      |
| `FS_THROW`                 | `throw` and throwing helpers                                   | `Effect.fail` and typed `error` values         |
| `FS_NATIVE_API`            | Unmanaged `fetch`, timers, `console.log`, and similar APIs     | Effect platform modules, `Console`, or `js`    |
| `FS_INPLACE_MUTATION`      | Array mutators outside a draft block                           | `Array.*` functions or `mut` drafts            |
| `FS_NON_EXHAUSTIVE_MATCH`  | A match that misses a finite union case                        | Add the missing arm or `\| _ => ...`           |
| `FS_NESTED_EFFECT`         | Returning an `Effect` from inside an `effect` block            | Bind it with `<-` first                        |
| `FS_UNBOUNDED_QUEUE`       | `Queue.unbounded()` and bare `Queue.make()`                    | `Queue.bounded(n)` or a dropping/sliding queue |

## Complete example

The following module combines schemas, typed errors, services, effects, pattern matching, and
pipelines. It is ordinary Effect code with a calmer notation.

```funscript
// src/orders.fun
import { Console, Effect, Layer } from "effect"

export schema OrderItem = {
  sku: String
  quantity: Int
  price: Number
}

export schema Order = {
  id: String
  customer: String
  items: Array<OrderItem>
  status: "open" | "paid" = "open"
}

export error OrderNotFound(id: String)
export error PaymentDeclined(reason: String)

export service Orders
  find: (id: String) => Effect<Order, OrderNotFound>
  save: (order: Order) => Effect<Order>

export service Payments
  charge: (order: Order) => Effect<Void, PaymentDeclined>

export label = (order: Order) =>
  match order.status
    | "open" => "awaiting payment"
    | "paid" => "paid"

export total = (order: Order) =>
  order.items
  |> Array.map((item) => item.price * item.quantity)
  |> Array.reduce(0, (sum, lineTotal) => sum + lineTotal)

export payOrder = (id: String) =>
  effect {
    order <- Orders.find(id)
    _ <- Payments.charge(order)
    paid = { ...order, status: "paid" }
    saved <- Orders.save(paid)
    => saved
  }

export OrdersLive = Layer.succeed(Orders, {
  find: (id) =>
    Effect.succeed({
      id
      customer: "Ada"
      items: [
        {
          sku: "book"
          quantity: 1
          price: 42
        }
      ]
      status: "open"
    })
  save: (order) => Effect.succeed(order)
})

export PaymentsLive = Layer.succeed(Payments, {
  charge: (order) => Effect.void
})

export main =
  effect {
    order <- payOrder("order-1")
    _ <- Console.log("{order.id}: {label(order)} — {total(order)}")
    => order
  }
  |> Effect.provide(OrdersLive)
  |> Effect.provide(PaymentsLive)
```

## Compatibility and status

FunScript is an experimental compiler and toolchain under active development. The language,
typechecker, compiler, and standard-library bindings evolve quickly. Documented features are
stable within a minor release, but breaking changes may land across minor versions.

The project follows a **Strict Zero-Alias Policy**: obsolete constructs, historical shims, and
ambiguous heuristics are rejected immediately rather than carried through long deprecation
windows or hidden behind edition flags. When upstream Effect renames an export, FunScript adopts
the new name and drops the old one. Update code using the compiler's diagnostic; there is no
automatic migration codemod.

Pre-1.0 guarantees:

- Syntax, tooling, and standard-library bindings may change between minor releases.
- No transitional wrappers or compatibility flags are maintained for obsolete constructs.
- The generated TypeScript remains readable, debuggable, and portable.
- `funscript check` is the static gate; `--no-check` is for prototyping only and does not disable
  runtime schema validation.

## Learn more

- [Syntax](/guides/syntax/) — a concise tour of canonical syntax.
- [Tooling](/guides/tooling/) — CLI, formatter, LSP, Vite, and project workflows.
- [Compatibility](/guides/compatibility/) — the Strict Zero-Alias policy and migration rules.
- The repository's `docs/syntax.md`, `docs/tooling.md`, `grammar.ebnf`, and `docs/reference/`
  contain the full language, tooling, grammar, and generated API references.
