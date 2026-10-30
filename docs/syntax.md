# FunScript syntax

**Status:** draft, aligned with proposal 0.1
**Audience:** FunScript users and compiler contributors

This is the working syntax reference. It is more concrete than the tour in
[proposal.md](proposal.md), and it records the decisions made while reviewing the
surface for ambiguity and failure modes.

The design rule is simple:

> If a construct needs a paragraph of explanation to avoid a silent mistake, change the
> construct.

---

## 30-second cheat sheet

| Construct                    | FunScript                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Binding (immutable)          | `name = "Ada"`                                                                                   |
| Typed binding                | `count: Number = 0`                                                                              |
| Shallow / deep record spread | `{ ...user, age: 37, address.city: "Paris" }`                                                    |
| Copy-on-write mutable draft  | `mut d = user` and `d.visits = d.visits + 1` (or `user \|> mut (d) => ...`)                      |
| Local mutable binding        | `mut count = 0` and `count = count + 1`                                                          |
| Function                     | `add = (a: Number, b: Number) => a + b`                                                          |
| Generic / typed function     | `id = <A>(x: A) => A { => x }`                                                                   |
| Zero-arg function            | `answer = () => 42`                                                                              |
| Block function               | `greet = (name: String) =>` newline indented body                                                |
| Call                         | `add(1, 2)`                                                                                      |
| Pipeline                     | `value \|> f \|> g(a) \|> clamp(0, 100, _)`                                                      |
| Pipe into match              | `value \|> match` newline `\| Some(x) => ...`                                                    |
| Record                       | `{ name: "Ada", age: 36 }`                                                                       |
| Array                        | `[1, 2, 3]`                                                                                      |
| Iteration                    | `xs \|> filter((x) => ...)` (auto-resolves `Array.filter`)                                       |
| Match (value)                | `match shape` newline `\| Circle(r) => ...`                                                      |
| Match (boolean / cond)       | `match` newline `\| n > 0 => "pos"` newline `\| _ => "neg"`                                      |
| Match (inline)               | `match \| n > 0 => "pos" \| _ => "neg"`                                                          |
| Or-pattern                   | `\| Admin \| Owner => "elevated"`                                                                |
| Tagged union schema          | `schema Shape =` newline `\| Circle(radius: Number)`                                             |
| Record schema                | `schema User = { id: UUID, name: NonEmptyString, role: String = "member", bio: Option<String> }` |
| Refined schema               | `schema Age = Int \|> Schema.between(0, 150)`                                                    |
| Schema constructor           | `UUID("1")`, `Age(36)`, `User({ id, name })` (literals validated at compile time)                |
| Compile-time type alias      | `schema Lookup = (id: String) => Effect<User, NotFound>`                                         |
| Error                        | `error NotFound(id: String)`                                                                     |
| Service                      | `service Greeter` newline `greet: (name: String) => Effect<String>`                              |
| Layer (pure / effectful)     | `Layer.succeed(Greeter, { ... })` or `Layer.effect(Greeter, effect ...)`                         |
| Effect block                 | `effect` newline `user <- UserRepo.find(id)`                                                     |
| Effect bind                  | `name <- effect`                                                                                 |
| Discard effect               | `_ <- effect`                                                                                    |
| Typed hole                   | `???` or `??? "todo: handle pagination"`                                                         |
| Import                       | `import { Effect } from "effect"`                                                                |
| Export                       | `export area = (shape: Shape) => ...`                                                            |
| Barrel re-export             | `export { Circle, Shape } from "./shapes.fun"`                                                   |
| Raw TS                       | `` `const x = process.env.X` ``                                                                  |
| Comment                      | `# line comment`                                                                                 |

---

## 0. The narrow surface: one way per job

FunScript is **Effect-first**. It does not expose general JavaScript or TypeScript
programming. It exposes one notation for each job, and that notation lowers to the
idiomatic Effect + ts-pattern + Mutative way.

The language is deliberately smaller than TypeScript. If a JavaScript or TypeScript
feature has a safer, Effect-native equivalent, the FunScript surface uses the Effect-native
form and rejects the other one.

| Job                            | The only FunScript way                                                  | Lowers to / uses                                                                                 | Not in the surface                                   |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Sequence effects               | `effect` block + `<-`                                                   | `Effect.gen` + `yield*`                                                                          | `async`/`await`, `Promise` chains                    |
| Recoverable error              | `error` + `Effect.catch*`                                               | `Schema.TaggedError` + combinators                                                               | `throw`, `try`/`catch`, `finally`                    |
| Dependency                     | `service` + `Layer` (`Layer.succeed` / `Layer.effect` / `Layer.scoped`) | `Context.Tag` + `Layer`                                                                          | globals, singletons, `process.env`                   |
| Default data & bindings        | immutable `=` and deeply `readonly` values                              | `const` + `readonly`                                                                             | `let`, `var`, reassigning immutable bindings         |
| Shallow & deep record update   | `{ ...value, a: 1, b.c: 2 }`                                            | `{ ... }` (shallow) / Mutative `create` (deep)                                                   | deeply nested manual object spreads                  |
| Imperative data transform      | `mut d = value` + `d.x = 1` (or `\|> mut (d) => ...`)                   | Mutative `create(value, (d) => ...)`                                                             | in-place object/array mutation                       |
| Local mutable variable         | `mut x = 0` + `x = x + 1`                                               | `let` (+ `create` on path updates)                                                               | `++`, `--`, top-level `mut`                          |
| Shared/concurrent state        | `Effect.Ref` / `SynchronizedRef` / `Queue`                              | Effect                                                                                           | closure-captured `mut`, module globals               |
| Concurrency                    | Effect fibers                                                           | Effect                                                                                           | `Promise`, `async`, `await`, `setTimeout`            |
| Pure collection transform      | Effect `Array`/`Record`/`HashMap`/`Chunk` pipelines                     | Effect modules                                                                                   | `for`, `while`, `forEach` loops, comprehensions      |
| Effectful iteration            | `Effect.forEach`                                                        | Effect                                                                                           | `for await`, `Promise.all`                           |
| Validated data & tagged unions | `schema` (records, `?`, `= default`, `\|> Schema.*`, `\| Variant(...)`) | `Schema` + `Data.TaggedEnum` + `typeof Name.Type`                                                | duplicate TS `type` + validator, `enum`, `interface` |
| Absent / optional value        | `Option` (`Some` / `None`)                                              | `Option`                                                                                         | `null`, `undefined` literals                         |
| Boundary decoding              | `Unknown` + `Schema.decodeUnknown(MyType)`                              | `Unknown`, `Schema`                                                                              | `any`, `as any`                                      |
| Value / identity equality      | `==` / `!=`; `===` / `!==`                                              | `Equal.equals` for structured values; strict JS equality for primitives; identity for references | coercing equality                                    |
| Boolean                        | `and` / `or` / `not`                                                    | `&&` / `\|\|` / `!`                                                                              | `&&`, `\|\|`, `!`                                    |
| Conditional & pattern match    | `match` (value, boolean, `\|> match`, `\| A \| B =>`)                   | ts-pattern (value) / conditional & `if` (boolean)                                                | `if`, `else`, `switch`, ternary `? :`, `return`      |
| Type-driven placeholder        | `???`                                                                   | `Never` throw + `checker.getContextualType`                                                      | `TODO as any`                                        |
| Function                       | `=>` lambda (implicit final-expression return)                          | arrow function                                                                                   | `function`, method shorthand, classes, `return`      |
| Module                         | ESM named exports, `export` prefix, `export { ... } from`               | ESM                                                                                              | CommonJS, default exports, local `export { ... }`    |
| Package                        | npm/pnpm/Bun via `funscript add`                                        | npm                                                                                              | a FunScript registry                                 |
| Build/test                     | Vite/Vitest via `funscript`                                             | Vite/Vitest                                                                                      | a second bundler/test runner by default              |

### 0.1 Banned surface

The toolchain rejects these in `.fun` source, or flags the method-based ones in
`funscript check`. They may appear inside raw TypeScript blocks, in `.d.ts` files, or in
generated output, but not in idiomatic FunScript:

- **In-place and implicit mutation:** `let`, `var`, reassigning an immutable binding
  (reassignment with `=` is restricted to local `mut` bindings and `mut (draft) =>`
  drafts), `++`, `--`, top-level `mut`, mutating a `mut` binding across a closure boundary,
  and mutating objects/arrays without `mut`.
- **Loops:** `for`, `while`, `do`, `break`, `continue`, comprehensions.
- **OOP and ad-hoc types:** `class`, `extends`, `new`, `this`, `super`, `prototype`,
  `interface`, `enum`, `namespace`, `declare`, `type`, `data` (use `schema`).
- **Error handling:** `throw`, `try`, `catch`, `finally`.
- **Async:** `async`, `await`, `yield`, `Promise` as a FunScript-authored effect type.
- **Null, undefined, and unsafe types:** `null`, `undefined` (in expressions), `any`,
  and `as` in all forms (`as const`, `x as T`, `as unknown as T`, `as any`). Narrowing
  and validated values use schema constructors (`Pair([1, "ok"])`, `UUID("1")`) or
  `Schema.decodeUnknown`.
- **Hidden inputs:** `Date.now`, `Date()`, `Math.random`, `performance.now`,
  `crypto.randomUUID` / `crypto.getRandomValues` (use `Clock`, `DateTime`, `Random`).
- **Environment globals:** `process.env`, `import.meta.env`, `Deno.env`, `Bun.env` (use
  `Config`).
- **Running effects mid-program:** `Effect.runPromise`, `runSync`, `runFork`,
  `runCallback`, `run*Exit`, `Runtime.run*`, and `ManagedRuntime` outside modules listed
  as `entry` in `funscript.json` (see §9.7).
- **Equality:** `==` / `!=` compare values; `===` / `!==` compare reference identity on reference-like values.
- **Symbol booleans:** `&&`, `||`, `!` (use `and`, `or`, `not`).
- **Competing control flow:** `if`, `else`, `then`, `switch`, ternary `? :`, `return`
  (use `match` or `when`; functions/blocks return their final
  expression or an explicit `=> expr`).
- **Runtime reflection and mutation:** `typeof`, `instanceof`, `in`, `delete`, `eval`,
  `arguments`, `debugger`, `with`, `Object.assign`, and `Object.defineProperty`. Use
  `Schema.is(MySchema)`, `match`, and `{ ...x, a.b: 1 }` / `mut` instead. Type-level `typeof`
  inside a raw TypeScript type is still allowed. Nullish operators (`??`, `?.`) are allowed
  for interop; they do not introduce `null` or `undefined` literals.
- **Other function forms:** `fn`, `function`, unparenthesized `x =>`, default
  parameters, rest parameters, point-free `>>`.
- **CommonJS and export variants:** `require`, `module.exports`, `export default`,
  local `export { ... }` without `from`.
- **Formatting noise:** semicolons.

Use `js` for JavaScript/Promise interop and `ts "..."` for TypeScript types.
Raw TypeScript backtick blocks remain an explicit escape hatch. See §1.8. The complete rejected/replacement table is in
[rejected-syntax.md](rejected-syntax.md).

### 0.2 Effect-first replacements

| Instead of                              | Use                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `console.log`                           | `Console.log`                                                                |
| `fetch`                                 | `HttpClient`                                                                 |
| `process.env`                           | `Config` / `Schema.Config`                                                   |
| `setTimeout`                            | `Effect.sleep` / `Schedule`                                                  |
| `Math.random` / `crypto.randomUUID`     | `Random`                                                                     |
| `Date` / `Date.now` / `performance.now` | `Clock` / `DateTime`                                                         |
| `JSON.parse`                            | `Schema.decodeUnknown(MySchema)`                                             |
| `x as T` / `"1" as UUID` / `as const`   | schema constructor `T(x)` / `UUID("1")`, or `Schema.decodeUnknown(T)`        |
| `Effect.runPromise` in a helper         | return the `Effect`; `export main` in the entry module                       |
| `Promise` / `async`                     | `Effect`                                                                     |
| `try` / `catch` / `throw`               | `Effect.try`, `Effect.catch*`, `error`                                       |
| Nested spreads / in-place mutation      | `{ ...x, a.b: 1 }` or `mut d = x` / `\|> mut (d) => ...` (Mutative `create`) |
| `let` / local rebinding                 | `mut x = ...` and `x = ...` (or `Effect.Ref` for concurrent state)           |
| `for` / `while`                         | `Array`/`Record`/`Chunk` pipelines or `Effect.forEach`                       |
| `class` / `new` / `type` / `interface`  | records, `schema` (Schema structs & tagged unions), `service`                |
| `null` / `undefined`                    | `Option` (`Some` / `None`) or `Effect.void`                                  |
| `any`                                   | `Unknown` + `Schema.decodeUnknown(MySchema)`                                 |

These are not style suggestions. They are the supported programming model. The old
feature is either rejected by the parser or deliberately confined to raw TypeScript.

---

## 1. Lexical structure

### 1.1 Source files

- UTF-8.
- LF or CRLF; the lexer normalizes to LF.
- One file is one module.
- Extension: `.fun`.
- A shebang (`#!`) is allowed only on the first line and is ignored by the compiler.

### 1.2 Indentation

FunScript is indentation-sensitive.

- Indentation is **2 spaces per level**.
- Tabs are an error.
- Mixed tabs and spaces are an error.
- A block is opened by a construct that expects one (`=>`, `match`, `effect`, `schema`,
  `service`, etc.).
- Each level is exactly two spaces deeper than its parent. The first line of a block
  establishes the base for that block; it must be parent + 2 spaces.
- Blank lines and comment-only lines do not affect indentation.
- Dedenting closes the current block. When indentation decreases across a newline, the
  lexer emits all pending `DEDENT` tokens **before** evaluating continuation rules (such
  as a leading `|>` or `.`), ensuring pipeline stages aligned with an outer block
  attach to the outer block rather than its final inner statement.

The formatter always produces 2-space indentation. There is no configuration.

### 1.3 Comments

```funscript
# A line comment.

###
A block comment.
It can span lines.
###
```

Block comments do not nest. `#` inside a string is not a comment.

### 1.4 Identifiers and naming

```text
identifier = [A-Za-z_][A-Za-z0-9_]*
```

V1 is ASCII-only. Unicode identifiers are future work.

Naming is part of the syntax, not just style:

- **UpperCamel** names are schemas/types, tagged-union constructors, error constructors,
  and services.
- **lowerCamel** names (or `_`) are bindings, functions, parameters, fields, and
  variables.
- `_` alone is the wildcard pattern, the discard marker in `_ <-`, and the argument
  placeholder in `|> f(a, _)`.
- `_tag` is reserved. It is the discriminant used by Effect and ts-pattern.

This convention removes the "is this a binding or a constructor?" ambiguity in patterns:
a lowercase pattern name binds; an uppercase pattern name must resolve to a constructor
or a compiler-known pattern (`Some`, `None`, `Left`, `Right`, `Success`, `Failure`).

The compiler enforces the convention for declarations it generates. Imported JavaScript
values may have any casing; they are only relevant in expression position.

### 1.5 Keywords (15 total)

```text
and       effect    error     export    false
from      import    match     mut       not
or        schema    service   true      when
```

`_` is a special token (wildcard in patterns, discard in `_ <-`, and call-argument
placeholder in `|> f(a, _)`), not a keyword in the usual sense. `???` is the typed-hole
operator.

The following words are reserved only to produce a targeted error when someone brings
JavaScript or TypeScript habits into FunScript:

```text
arguments   as          async       await       break
catch       class       continue    data        declare
default     delete      do          else        enum
eval        extends     finally     for         function
if          in          instanceof  interface   let
module      namespace   new         null        private
protected   prototype   public      require     return
static      super       switch      then        this
throw       try         type        typeof      undefined
var         void        while       with        yield
```

Reserved words are still allowed as record field names and after `.` when the parser
expects a property name (and `Void` / `undefined` are allowed inside TypeScript type
annotations); they are rejected when used as declarations, operators, literals, or
statements.

`=>` is the single arrow for functions, function types, match arms, and explicit returns. `<-` is effect binding. `=` declares an
immutable binding by default, or updates an explicitly `mut` binding / `mut (draft) =>`
draft. `|>` is pipeline. `|` starts a match arm or a tagged-union `schema` variant; it is
not bitwise-or.

There is no `new`, no `class`, no `null`, and no `undefined` literal. Objects are records,
tagged unions, or services; absence is `Option`.

### 1.6 Effect TS types as the language primitives

All FunScript type names are PascalCase. Native TypeScript spelling is used only in
emitted TypeScript and `ts "..."` escape hatches.

| FunScript type | TypeScript output  | Runtime schema     |
| -------------- | ------------------ | ------------------ |
| `String`       | `string`           | `Schema.String`    |
| `Number`       | `number`           | `Schema.Number`    |
| `Boolean`      | `boolean`          | `Schema.Boolean`   |
| `Void`         | `void`             | `Schema.Void`      |
| `Unknown`      | `unknown`          | `Schema.Unknown`   |
| `Never`        | `never`            | `Schema.Never`     |
| `Array<T>`     | `ReadonlyArray<T>` | `Schema.Array(T)`  |
| `Option<T>`    | `Option.Option<T>` | `Schema.Option(T)` |

`Number` is the standard numeric type. Use refinements such as `Int`, `Float`, or
`Decimal` when a domain requires integers, finite numbers, or exact decimals.
Effect companion modules provide pipeline operations such as `String.trim` and
`Array.map`; raw JavaScript/Promise interop is explicit through `js`.

Numeric literal examples:

```funscript
1_000
3.14
1e9
0xFF
0b1010
0o755
123n

true
false

"Hello, {name}!"
'No {interpolation} here.'
```

- Decimal, hex, binary, octal, float, exponent, and BigInt literals are supported.
- Double-quoted strings interpolate with braces.
- Single-quoted strings are raw: no interpolation.
- Escapes: `\n`, `\r`, `\t`, `\\`, `\"`, `\'`, `\{`, `\}`, `\u{...}`.
- A literal brace is written `\{` or `\}`.
- Interpolation expressions are balanced; `"{(a + b)}"` is valid.
- Multi-line strings are not part of V1. Use a raw TypeScript block or escaped newlines
  for now.
- Neither `null` nor `undefined` is a FunScript expression literal. Use `Option` (`Some` /
  `None`) for absence and `Effect.void` for unit effects; use `Option.fromNullable` and
  `Option.getOrUndefined` (or raw TypeScript) at a legacy interop boundary.

### 1.7 Regular expressions

JavaScript regular expression literals are supported:

```funscript
pattern = /\s+/g
cleaned = value.replace(pattern, "-")
```

The lexer decides between division and a regex literal from the previous significant
token, the same way JavaScript lexers do. At the start of a statement, `/` begins a regex;
after an expression, `/` is division. Parenthesize when in doubt.

### 1.8 Raw TypeScript

A backtick block is emitted verbatim:

```funscript
legacy = `require("some-legacy-package")`
```

```ts
const legacy = require("some-legacy-package");
```

Rules:

- A raw block is emitted in the position where it appears. At statement position it may
  contain statements; in expression position it must contain an expression.
- It may span lines.
- To include a literal backtick, escape it as `` \` ``; the compiler removes the escape
  before emitting.
- Raw blocks are the explicit escape hatch. They are expected to be rare and should be
  greppable in CI; a simple search for a backtick in `.fun` files is a useful audit.

### 1.9 Semicolons

FunScript source has no semicolons. Newlines separate statements, and a semicolon is a parse
error with a suggestion to remove it. Semicolons inside raw TypeScript blocks are fine.

### 1.10 Newlines and continuation

Newlines end statements except:

- inside `()` (calls and grouping), where a newline is whitespace;
- inside `[]` and `{}` literals, where a newline at the top level of the literal may act
  as an element separator (a comma is also allowed and is inserted by the formatter);
- after a trailing binary operator (`+`, `|>`, `=`, `<-`, `=>`, `,`, `.`);
- before a leading `|>`;
- before a leading `.` or `?.` in a member chain;
- before a leading `|` in a `match` block or `data` declaration.

When a newline is followed by a dedent, the lexer emits `DEDENT` tokens for all closed
blocks first, and then applies leading-operator continuation (`|>`, `.`, `?.`) at
the target indentation level.

A newline after an operator is continuation, never an element separator. A newline
immediately after `[`/`{` or before `]`/`}` is not an empty element. Calls use commas for
arguments; arrays and records may use newlines or commas.

Canonical pipeline style puts each stage on its own line:

```funscript
names =
  users
  |> Array.map((u) => u.name)
  |> Array.join(", ")
```

---

## 2. Bindings, destructuring, and explicit local mutability

### 2.1 Immutable bindings (the default)

Bindings are immutable by default and compile to `const`.

```funscript
name = "Ada"
age = 36
user = { name, age }

count: Number = 0
user: User = { id: "1", name: "Ada" }
```

Destructuring works in immutable bindings, function parameters, and patterns:

```funscript
{ name, age } = user
{ name: displayName, ...rest } = user
[first, ...tail] = items
```

```ts
const { name, age } = user;
const { name: displayName, ...rest } = user;
const [first, ...tail] = items;
```

Without `mut`, `=` is always a new immutable binding declaration, never reassignment.
Re-assigning or re-declaring an immutable name in the same block is a resolver error. To
create a modified copy of an immutable record, use spread (supporting both shallow fields
and nested dot-paths, see §6.2):

```funscript
older = { ...user, age: user.age + 1, address.city: "Paris" }
```

A top-level binding is private unless exported:

```funscript
export greet = (name: String) => "Hello, {name}!"
```

### 2.2 Explicit local mutability (`mut`)

FunScript is **immutable-first, explicit-mutable**: all values, records, and arrays are deeply
`readonly` at rest, and every mutation requires an explicit `mut` — either a local `mut`
binding or a `mut (draft) => ...` pipeline stage (§6.2):

```funscript
accumulate = (user: User, delta: Number) =>
  mut total = 0
  total = total + delta
  mut current = user
  current.visits = current.visits + total
  current
```

```ts
const accumulate = (user: User, delta: number) => {
  let total = 0;
  total = total + delta;
  let current = user;
  current = create(current, (draft) => {
    draft.visits = current.visits + total;
  });
  return current;
};
```

Rules for `mut`:

- `mut name = expr` (or `mut name: Type = expr`) declares a local mutable binding and
  compiles to `let name = expr;`.
- Reassigning a `mut` binding (`name = nextExpr`) compiles to `name = nextExpr;`.
  Reassigning an immutable binding (`x = nextExpr` where `x` was not declared `mut`) is a
  compile-time error.
- Mutating a field, element path, or array method on a `mut` binding (`name.a.b = val`,
  `name.tags.push("x")`) compiles to a copy-on-write structural-sharing update via Mutative
  (`create(name, (draft) => { ... })`), coalescing consecutive statements on `name` into a
  single Mutative pass so the original value bound to `name` is **never mutated in place**.
- `mut` bindings are **local only**: they may appear inside function bodies or `effect`
  blocks, never at module top-level. Module-level state belongs in a `service` + `Layer`.
- **No closure-captured mutation:** a `mut` binding cannot be mutated inside a nested
  function or callback. Shared, asynchronous, or cross-fiber mutable state must use
  `Effect.Ref`, `SynchronizedRef`, or `Effect.Queue`.
- Destructuring bindings cannot be `mut`; declare `mut` on individual bindings.
- There are still no `let`, `var`, `:=`, `++`, or `--` tokens in FunScript.

---

## 3. Functions

### 3.1 Forms

```funscript
add = (a: Number, b: Number) => a + b

identity = <A>(value: A) => A { => value }

greet = (name: String) =>
  trimmed = name |> String.trim()
  "Hello, {trimmed}!"

answer = () => 42
```

```ts
const add = (a: number, b: number) => a + b;

const identity = <A>(value: A): A => value;

const greet = (name: string) => {
  const trimmed = pipe(name, String.trim);
  return `Hello, ${trimmed}!`;
};

const answer = () => 42;
```

- Parameters are comma-separated inside parentheses: `(a, b) => ...`.
- Single-argument functions require parentheses: `(x) => x`. Bare `x => x` is rejected.
- Zero-argument functions use `() => expression`.
- Parameters may use record or array destructuring (`({ id, name }: User) => ...`) and
  optional TypeScript type annotations.
- Optional generic type parameters precede the parameter list (`<A, B>(a: A, b: B) => ...`),
  and an explicit return type follows `=>`, before a braced body: `(x: Number) => Number { => x }`.
- Function parameters are always immutable (`readonly`); they cannot be marked `mut` or
  reassigned.
- A function body is either an inline expression or an indented block.
- The last expression of a block is returned; `=> expr` explicitly returns.
  Use `when` for early returns, `match` for branching, and `<- Effect.fail(...)` for typed Effect failure.
- A trailing binding or `mut` assignment returns the bound/assigned value.
- Functions use `name = (params) => ...`. Neither `fn` nor `function` is supported; there is no second function keyword, no method
  shorthand, and no class method syntax. An object field that holds a function uses the
  same lambda: `{ greet: (name) => ... }`.
- There are no default parameters or rest parameters in V1. Use a record parameter,
  `Option`, or raw TypeScript for interop.

### 3.1.1 Explicit returns and conditional execution

A final expression returns implicitly. `=> expression` explicitly returns from a
function or block. A return type can precede a braced body:

```funscript
absolute = (value: Number) => Number {
  when (value < 0) => -value
  => value
}
```

`when` has three forms: `when (condition) => value` returns early from a function;
`when (condition) { ... }` (or an indented body) conditionally executes statements
and then continues; `| Pattern when condition => value` guards a match arm.
Early returns require an enclosing function.

### 3.2 Calls and methods

Calls require parentheses:

```funscript
sum = add(1, 2)
trimmed = name |> String.trim()
response = client.get(url)
```

No implicit call syntax. `f x` is not a call; it is a parse error. This keeps the grammar
predictable and makes JavaScript interop obvious.

### 3.3 No `new`, no classes

FunScript has no `new`, no class declarations, no `this`, no `super`, and no prototypes.

- Plain immutable data is a record literal or `type` struct.
- Tagged unions are `type` declarations with `| Variant(...)` arms.
- Typed errors are `error`.
- Dependencies are `service` + `Layer`.

If a JavaScript library requires construction with `new`, wrap it in a named function at
the boundary, or use the raw TypeScript escape hatch. Effect's platform modules already
wrap the common cases (`DateTime`, `Url`, `HttpClient`, etc.); prefer those.

Generated TypeScript may contain `class` and `new` for `service`, `error`, and `type`
lowering. That is output, not source syntax; the FunScript surface still has no classes or
`new`.

---

## 4. Operators

### 4.1 Precedence

From lowest to highest:

| Level | Operators                | Notes                                                                               |
| ----- | ------------------------ | ----------------------------------------------------------------------------------- |
| 1     | `\|>`                    | pipeline, left-associative                                                          |
| 2     | `or`                     | logical or                                                                          |
| 3     | `and`                    | logical and                                                                         |
| 4     | `??`                     | nullish coalescing                                                                  |
| 5     | `==`, `!=`, `===`, `!==` | value equality and reference identity; relational operators also compare primitives |
| 6     | `+`, `-`                 | additive                                                                            |
| 7     | `*`, `/`, `%`            | multiplicative                                                                      |
| 8     | `**`                     | exponent, right-associative                                                         |
| 9     | `not`, unary `-`         | prefix                                                                              |
| 10    | call, member, index      | postfix                                                                             |

`match`, `effect`, functions, records, arrays, and literals are primary expressions.

### 4.2 Equality and comparisons

`==` and `!=` compare by value: structured values use Effect `Equal.equals`,
while primitives use strict JavaScript equality. `===` and `!==` compare reference
identity and are restricted to reference-like values:

```funscript
a == b   # value equality
a != b   # value inequality
```

#### Comparisons

Use `<`, `<=`, `>`, and `>=` for primitive comparisons. Effect companion functions
support pipelines and comparisons on `BigDecimal`, `DateTime`, and `Duration`:

```funscript
# Numbers (using Effect's Number module)
isValid = score |> Number.greaterThanOrEqualTo(0)
isPass = Number.greaterThan(score, 50)

# Dates and Times
isExpired = DateTime.greaterThan(now, token.expiresAt)

# High-precision Decimals
isPositive = BigDecimal.greaterThan(price, BigDecimal.fromNumber(0))

# In a match expression:
tier =
  match
    | score |> Number.greaterThanOrEqualTo(90) => "Platinum"
    | score |> Number.greaterThanOrEqualTo(75) => "Gold"
    | _ => "Silver"
```

### 4.3 Boolean operators

The only boolean operators are `and`, `or`, and `not`:

```funscript
match
  | user.active and not user.suspended => send(user)
  | _ => archive(user)
```

`&&`, `||`, and `!` are rejected. There is one spelling for each operator, and it reads
like the logic it represents.

### 4.4 Nullish and optional chaining

```funscript
city = user.address?.city ?? "Unknown"
```

These compile directly to JavaScript's `?.` and `??`. Mixing `??` with `and`/`or`
requires parentheses, matching JavaScript's rule; the parser reports an error rather
than guessing. They are an interop convenience for legacy nullable/optional fields; when
absence is meaningful in FunScript domain types, use `Option`.

### 4.5 No bitwise operators

There are no `&`, `|`, `^`, `<<`, `>>`, or `>>>` operators in V1.

`|` is a match/variant marker. Overloading it would make the grammar ambiguous and the code
harder to read. Use Effect/npm helpers or a raw TypeScript block for bit manipulation.
This is a deliberate tradeoff: bitwise code is rare in application code and explicit when
it appears.

### 4.6 No ternary or `if / else`

Use `match` (inline or indented block):

```funscript
label = match | n > 0 => "positive" | _ => "negative"
```

There is one conditional and branching form (`match`) to read, format, and teach.

---

## 5. Pipelines

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
- `value |> f(a)` means `f(a)(value)` (curried data-last stage, the Effect standard).
- `value |> f(a, _)` or `value |> f(_, b)` plugs the piped value into the `_` argument
  slot of an uncurried function:
  - In a single-stage pipeline, `value |> add(1, _)` compiles directly to `add(1, value)`.
  - In a multi-stage pipeline, `|> add(1, _)` compiles to the stage `(v) => add(1, v)`
    inside `pipe(...)`.
- At most one `_` placeholder may appear as a direct call argument of a `|>` stage.
  Nested uses like `|> f(g(_))` or `_.field` are rejected in favor of an explicit lambda
  `(x) => f(g(x))` so there is never scope ambiguity.
- A pipeline of two or more stages compiles to Effect's `pipe`.
- A single stage compiles to a direct call.
- There is no point-free `>>` composition operator: write `(x) => x |> f |> g` (which
  preserves TypeScript contextual type inference) or call Effect's `flow(f, g)` directly.

```funscript
# Effect's data-last APIs need no placeholder:
result =
  value
  |> Effect.map(normalize)
  |> Effect.flatMap(save)

# Uncurried functions (user-defined or npm) use `_` for the piped slot:
score =
  rawScore
  |> parseScore
  |> clamp(0, 100, _)
  |> formatScore(_, "en-US")
```

### 5.1 Type-directed pipeline resolution (auto-namespace)

To eliminate visual repetition, pipeline stages do not require repeating the module
namespace (`Array.`, `Option.`, `Effect.`, `String.`) when the type of the piped value is
known. When a pipeline stage uses a bare function name, the compiler resolves it against
the companion module of the left-hand type:

```funscript
# Clean, readable pipeline without repetitive "Array." prefixes:
topActive =
  users
  |> filter((u) => u.active)
  |> sortBy((u) => u.name)
  |> take(10)
  |> map((u) => u.name)
```

Compiles to:

```ts
import { Array, pipe } from "effect";

const topActive = pipe(
  users,
  Array.filter((u) => u.active),
  Array.sortBy((u) => u.name),
  Array.take(10),
  Array.map((u) => u.name),
);
```

#### Companion module registry

| Piped type                      | Companion module  | Examples of auto-resolved functions                                    |
| ------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `Array<T>` / `ReadonlyArray<T>` | `effect/Array`    | `map`, `filter`, `sort`, `sortBy`, `take`, `drop`, `join`, `findFirst` |
| `Option<T>`                     | `effect/Option`   | `map`, `flatMap`, `getOrElse`, `isSome`, `isNone`                      |
| `Effect<A, E, R>`               | `effect/Effect`   | `map`, `flatMap`, `retry`, `timeout`, `catchTag`, `provide`            |
| `HashMap<K, V>`                 | `effect/HashMap`  | `get`, `set`, `has`, `remove`, `values`, `keys`                        |
| `HashSet<T>`                    | `effect/HashSet`  | `has`, `add`, `remove`, `union`, `difference`                          |
| `String`                        | `effect/String`   | `trim`, `toLowerCase`, `toUpperCase`, `split`, `lines`                 |
| `DateTime`                      | `effect/DateTime` | `add`, `subtract`, `formatIso`, `greaterThan`                          |

#### Resolution and shadowing rules

1. **User scope wins:** If a function named `filter` is defined in the current file or
   explicitly imported, user scope takes precedence over auto-namespace resolution.
2. **Type inspection via `tsc`:** The compiler inspects the static type of the left-hand
   expression using TypeScript's `checker.getTypeAtLocation(node)` to determine the target
   companion module.
3. **Automatic import injection:** When a companion function is resolved, the compiler
   automatically adds the named module import (`import { Array } from "effect"`) to the
   emitted TypeScript file if not already present.
4. **Explicit syntax always valid:** You can always write `Array.filter` or `Effect.map`
   explicitly; the two forms emit identical TypeScript.

```ts
const score = pipe(
  rawScore,
  parseScore,
  (v) => clamp(0, 100, v),
  (v) => formatScore(v, "en-US"),
);
```

---

## 6. Records, arrays, and copy-on-write data manipulation (Mutative)

### 6.1 Records and arrays (deeply immutable at rest)

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

- Commas are optional when entries are on separate lines.
- Trailing commas are allowed.
- Shorthand entries (`{ name }`) and spreads (`{ ...user, age: 37 }`, `[0, ...numbers]`)
  are supported.
- Field access is `user.address.city`; optional access is `user.address?.city`.
- All records, `type` schemas, tagged-union variants, and `Array<T>` (`ReadonlyArray<T>`)
  are **deeply `readonly` at rest**. Direct in-place mutation of an object or array
  without `mut` is a compile-time error.

### 6.2 Copy-on-write updates (`{ ...x, a.b: 1 }` and `mut`)

FunScript supports two complementary ways to update immutable data, backed by
[Mutative](https://github.com/unadlib/mutative)'s `create(...)` for deep structural sharing
on plain JavaScript objects and arrays (working seamlessly with Effect `Schema`,
`Data.TaggedEnum`, and `ts-pattern`):

#### 1. Shallow and deep dot-path record spreads (`{ ...user, a.b: 1 }`)

Use `{ ...user, ... }` for declarative updates. Shallow field updates emit a plain
JavaScript object spread, while nested dot-paths (`address.city: "Paris"`) automatically
lower to Mutative's `create(...)`:

```funscript
# Shallow update (emits `{ ...user, age: user.age + 1 }`):
older = { ...user, age: user.age + 1 }

# Deep dot-path update (emits Mutative `create`):
relocated = {
  ...user
  age: user.age + 1
  address.city: "Paris"
}
```

Compiles to:

```ts
import { create } from "mutative";

const older = { ...user, age: user.age + 1 };

const relocated = create(user, (draft) => {
  draft.age = user.age + 1;
  draft.address.city = "Paris";
});
```

#### 2. Imperative copy-on-write drafts (`mut`)

When a transformation involves conditionals (`match`), multi-step assignments (`=`), or
mutating array operations (`push`, `pop`, `splice`, `sort`), bind a local `mut draft = user`
(or use `|> mut (draft) => ...` in a pipeline):

```funscript
export recordLogin = (user: User) =>
  mut draft = user
  draft.visits = draft.visits + 1
  match
    | draft.visits > 10 => draft.tier = "gold"
  draft.tags.push("active")
  draft

# Pipeline stage form (curried Mutative `create((draft) => ...)`):
nextUser =
  user
  |> mut (draft) =>
    draft.visits = draft.visits + 1
    draft.tags.push("active")
```

Compiles to:

```ts
export const recordLogin = (user: User) =>
  create(user, (draft) => {
    draft.visits = draft.visits + 1;
    if (draft.visits > 10) {
      draft.tier = "gold";
    }
    draft.tags.push("active");
  });

const nextUser = pipe(
  user,
  create((draft) => {
    draft.visits = draft.visits + 1;
    draft.tags.push("active");
  }),
);
```

Rules for copy-on-write `mut` drafts:

- Consecutive field/index assignments (`draft.a.b = x`, `draft.items[0] = y`) and mutating
  array methods (`draft.items.push(...)`, `splice`, `sort`) on a `mut` binding (or inside
  `mut (draft) => ...`) run inside Mutative's `create(...)`, where `draft` has type
  `Draft<T>`, and produce a deeply `readonly` `T` with structural sharing.
- A `mut (draft) => ...` draft parameter is scoped to its block: returning a sub-reference
  or capturing `draft` in an escaping closure is a `funscript check` error.
- Persistent collection types from Effect (`HashMap`, `HashSet`, `Chunk`) remain the
  standard library choice for large dynamic key-value maps and sets.

### 6.3 Iteration

There is no loop syntax. There is no comprehension syntax. There is one way per domain:

**Pure collection transforms** use Effect's data-last modules:

```funscript
squares =
  numbers
  |> Array.filter((n) => n > 0)
  |> Array.map((n) => n * n)
```

```ts
const squares = pipe(
  numbers,
  Array.filter((n) => n > 0),
  Array.map((n) => n * n),
);
```

**Effectful iteration** uses `Effect.forEach`:

```funscript
users <- Effect.forEach(ids, (id) => UserRepo.find(id))
```

Recursion is available for algorithms that genuinely need it. Local synchronous accumulation
within a function can use a `mut` binding; shared or concurrent state uses `Effect.Ref`,
`Effect.Queue`, or another Effect primitive.

### 6.4 No loop statements

There are no `for`, `while`, `do`, `break`, or `continue` statements. JavaScript's
side-effecting `forEach`, index loops, and comprehension syntax are all replaced by the
two forms above. This is not a stylistic preference; loops are where accidental mutation
and off-by-one errors live, and Effect already has the right tools for both pure and
effectful iteration.

---

## 7. Control flow (`match`)

`match` is FunScript's **single** branching construct. There are no `if`, `else`, `then`,
`switch`, or `? :` tokens. Depending on whether `match` is followed by a scrutinee value,
it performs either **boolean condition matching** or **structural pattern matching**.

### 7.1 Boolean / conditional `match` (subjectless `match`)

When `match` has no scrutinee expression, each arm tests a boolean condition top-to-bottom,
and `| _ =>` is the fallback (`else`) branch:

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

Statement / guard form (when the `match` result is not used as a value, `| _ =>` may be
omitted):

```funscript
match
  | user.active => send(user)
  | user.pending => queue(user)
  | _ => archive(user)

# Single-branch guard inside an effect or `mut` block:
match
  | draft.visits > 10 => draft.tier = "gold"
```

Lowering of subjectless `match` (zero `ts-pattern` runtime overhead):

- In pure expression position with single-expression arms, subjectless `match` compiles
  directly to a JavaScript conditional expression:
  ```ts
  const label = n > 0 ? "positive" : n === 0 ? "zero" : "negative";
  ```
- In statement position, inside an `effect` block, or when an arm has a multi-statement
  block or mutates a local `mut` binding (`=`), subjectless `match` compiles directly to
  native JavaScript `if (...) { ... } else if (...) { ... } else { ... }` statements
  (hoisting a `let` declaration when the `match` is on the right-hand side of `=` or `<-`)
  so `yield*` and local reassignments stay in the enclosing scope.
- **Exhaustiveness:** When a subjectless `match` is used as a value expression (`=`, `<-`,
  function return, or call argument), a trailing `| _ =>` arm is **required** so an
  unhandled boolean case can never silently evaluate to `undefined`. In statement position
  (where the result is discarded), `| _ =>` is optional.

### 7.2 Value and structural pattern `match`

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

Rules:

- Arms are indented one level under `match`.
- Each arm starts with `|`.
- An arm body is either an inline expression or an indented block.
- A `when` guard follows the pattern.
- Without `_`, the compiler emits `.exhaustive()`.
- With `_`, the compiler emits `.otherwise()`.
- A `_` arm must be last; unreachable arms are an error.
- An empty `match` is an error.
- Exhaustiveness is checked for finite unions. For open types (strings, numbers), use `_`
  or a guard; the compiler reports that an exhaustive match cannot be proven.

```funscript
export describe = (shape: Shape) =>
  match shape
    | Circle(r) when r > 10 => "large circle ({r})"
    | Circle(r) => "circle ({r})"
    | Rect(w, h) => "rectangle {w}x{h}"
```

```ts
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

Block arm:

```funscript
match exit
  | Success(value) =>
    normalized = normalize(value)
    { ok: true, value: normalized }
  | Failure(error) => { ok: false, error }
```

#### Pipe-into-`match` (`|> match`)

When a pipeline ends by branching on the piped value, `|> match` matches the piped value
directly without introducing a temporary variable:

```funscript
displayName =
  users
  |> Array.findFirst((u) => u.id == targetId)
  |> match
    | Some(user) => user.name
    | None => "Guest"
```

Compiles to:

```ts
const displayName = pipe(
  users,
  Array.findFirst((u) => u.id === targetId),
  (v) =>
    match(v)
      .with({ _tag: "Some" }, ({ value: user }) => user.name)
      .with({ _tag: "None" }, () => "Guest")
      .exhaustive(),
);
```

#### Or-patterns (`| A | B =>`)

Multiple patterns that share the same handler can be combined with `|` on a single arm,
lowering to multi-pattern `.with(pat1, pat2, handler)` in `ts-pattern`:

```funscript
canEdit = (role: Role) =>
  match role
    | Admin | Owner => true
    | Member(_) | Guest => false

isWeekend = (day: String) =>
  match day
    | "Sat" | "Sun" => true
    | _ => false
```

```ts
const canEdit = (role: Role) =>
  match(role)
    .with({ _tag: "Admin" }, { _tag: "Owner" }, () => true)
    .with({ _tag: "Member" }, { _tag: "Guest" }, () => false)
    .exhaustive();
```

If an or-pattern binds variables (for example `| Circle(r) | Sphere(r) =>`), every
alternative in the arm must bind the **exact same set of variable names** with compatible
types.

### 7.3 Patterns and constructor lowering

| Pattern             | Example                            | Meaning                                                                        |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| wildcard            | `_`                                | matches anything, binds nothing                                                |
| binding             | `name`                             | matches anything, binds lowercase name                                         |
| literal             | `42`, `"ok"`, `true`               | exact literal match                                                            |
| nullary constructor | `None`, `Red`, `Boom`              | matches `{ _tag: "None" }`                                                     |
| constructor         | `Circle(r)`                        | matches `_tag` and binds positional fields by declaration order                |
| nested constructor  | `Circle(10)`, `Some({ id, name })` | lowers nested literal/record sub-patterns into the `.with(...)` pattern object |
| or-pattern          | `Admin \| Owner`, `"Sat" \| "Sun"` | matches if any alternative matches (`.with(p1, p2, handler)`)                  |
| record              | `{ kind: "click", x, y }`          | structural object match                                                        |
| array               | `[first, ...rest]`                 | structural array match                                                         |

Constructor pattern lowering rules:

- Positional arguments in `Circle(r)` or `Rect(w, h)` map to the variant's declared field
  names (`radius`, `width`, `height`) via a lightweight **constructor-header cache** built
  by scanning tagged-union `schema` and `error` declarations across the `.fun` module graph
  before emission. This keeps generated TypeScript clean (`({ width: w, height: h }) => w * h`)
  without adding synthetic `_0`, `_1` tuple properties to runtime objects.
- When constructor arguments are simple variable bindings (`Circle(r)`), the emitter
  matches `{ _tag: "Circle" }` and destructures `({ radius: r })` in both the optional
  `when` guard callback and the arm handler callback.
- When constructor arguments contain literals or nested structural patterns
  (`Circle(10)` or `Some({ id, name })`), the sub-patterns are lowered directly into the
  first argument of `.with(...)` (for example `.with({ _tag: "Circle", radius: 10 }, ...)`
  and `.with({ _tag: "Some", value: { id: "1" } }, ({ value: { id, name } }) => ...)`), so
  `ts-pattern` narrows and tests every nested condition.

Built-in Effect patterns:

```funscript
match maybeUser
  | Some(user) => user.name
  | None => "anonymous"

match result
  | Right(value) => value
  | Left(error) => error.message
```

`Some(value)`/`None`, `Right(right)`/`Left(left)`, and `Success(value)`/`Failure(cause)`
are compiler-known. They lower to structural `_tag` patterns and work with TypeScript
narrowing.

Capitalization matters: lowercase names bind, uppercase names are constructors. This is
the syntax's main pattern-disambiguation rule. To compare against a variable value, use a
guard: `| value when value == expected => ...`.

There is no `null` or `undefined` pattern. A nullable interop value is converted with
`Option.fromNullable` and matched as `Some`/`None`.

---

## 8. Unified `schema` (Schema structs, tagged unions, and aliases) and `error` declarations

In FunScript, a single `schema` keyword handles all data, tagged-union, and type alias
declarations:

1. **Data-shape `schema` declarations** (records, primitives, refinements) → Effect `Schema` +
   static TypeScript `type`.
2. **Tagged-union `schema` declarations** (`| Variant(...)` arms) → `Data.TaggedEnum` +
   positional constructors + Effect `Schema.Union` + static TypeScript `type`.
3. **Compile-time `schema` aliases** (functions `=>`, `Effect<...>`, generics) → pure
   TypeScript `type`.

### 8.1 Data-shape `schema`: Effect `Schema` + static TypeScript type

Declaring a data-shape `schema` generates **both** a runtime `Schema` constant and a static
TypeScript `type` with the same name — there is no separate type declaration to keep in
sync.

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
```

Compiles to:

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
```

Because `User` is both a type and a `Schema` value, it works in type annotations and at
runtime boundaries without duplication:

```funscript
# In a type annotation:
greetUser = (user: User) => "Hello, {user.name}!"

# At a runtime validation boundary:
user <- rawInput |> Schema.decodeUnknown(User)
todo <- response |> HttpClientResponse.schemaBodyJson(Todo)
```

#### Schema constructors

Every data-shape `schema` (and every built-in Schema scalar such as `UUID`, `Int`,
`NonEmptyString`) is also callable as a **validating constructor**. This replaces type
casts: values are either constructed or decoded, never asserted with `as`.

```funscript
id = UUID("0b9e6c1e-5f6a-4c6e-9a43-0c2f3b1d9e7a")
name = Username("ada")
ada = User({ id, name, age: 36 })
```

```ts
const id = Schema.UUID.make("0b9e6c1e-5f6a-4c6e-9a43-0c2f3b1d9e7a");
const name = Username.make("ada");
const ada = User.make({ id, name, age: 36 });
```

Rules:

- `Name(value)` lowers to `Name.make(value)`, which validates refinements and applies
  brands.
- **Literal arguments are validated at compile time.** When the argument is a literal, or a
  record/array built only from literals and other constructor calls, the compiler runs the
  schema during `funscript check`; `Age(200)` or `UUID("nope")` is a compile error with
  the `Schema` parse message.
- A non-literal argument that fails validation throws a defect at runtime. For untrusted
  input (`unknown`, request bodies, files), use `Schema.decodeUnknown(Name)`, which keeps
  the failure as a typed `ParseError`; `funscript check` suggests it when a constructor is
  applied to an `unknown`-derived value.
- Compile-time-only `schema` aliases (functions, `Effect`, generics) have no constructor.
- Tagged-union variants (`Circle(...)`) and `error` declarations (`NotFound(...)`) already
  have positional constructors (§8.2, §8.3); the rule "uppercase name called like a
  function = validated construction" holds everywhere.

#### How data-shape `schema` lowers

1. **Data-shape `schema` declarations** (primitives `string`, `number`, `boolean`, `bigint`;
   built-in Schema scalars like `Int`, `NonNegativeInt`, `Positive`, `NonEmptyString`,
   `UUID`, `ULID`, `DateTimeUtc`, `Duration`; string/number/boolean literals; record shapes
   `{ ... }`; `Array<T>`; tuples `[A, B]`; `Option<T>`; `Either<A, E>`; unions `A | B` of
   data shapes; `|> Schema.*` refinement pipelines; and references to other
   `schema`/`error` declarations) compile to a runtime `Schema` value **and**
   `type Name = typeof Name.Type`.
2. **Absence and default fields in record `schema` declarations:**
   - **No `?` in records:** There is no `field?: Type` syntax. Absence is explicitly modeled
     as `field: Option<Type>`, which lowers to `Schema.OptionFromNullOr(...)`. Incoming JSON
     with `null`, `undefined`, or omitted keys automatically decodes to `Option.none()`,
     ensuring `null` never leaks into business logic.
   - `field: Type = defaultExpr` lowers to `Schema.optionalWith(..., { default: () => defaultExpr })`
     so the field is optional in raw encoded input and automatically populated in the
     decoded `User` type (`readonly field: T`).
3. **Deeply `readonly` at rest:** All fields in a `schema` are `readonly` in the static type
   inferred by `Schema.Struct`. Updating a value produces a new immutable value via
   `{ ...user, a.b: 1 }` or a `mut` copy-on-write draft (backed by Mutative's `create`, see
   §6.2).
4. **Refinement pipelines in schemas:** Any data type or record field type can pipe into
   `Schema` combinators using `|>` (`Int |> Schema.between(0, 150)`,
   `string |> Schema.pattern(/^[a-z]+$/)`). Zero-argument Schema combinators in a schema
   pipeline (`Schema.trimmed`, `Schema.nonEmptyString`) may be written with or without
   `()`.
5. **Compile-time-only `schema` declarations:** When a `schema` contains non-serializable
   constructs — function arrows `=>`, generic type parameters (`schema Box<A> = ...`),
   `Effect<...>`, `Layer<...>`, `Stream<...>`, services, or `unknown` — the compiler emits
   a pure TypeScript `type` alias only:

```funscript
export schema Lookup = (id: String) => Effect<User, NotFound>
```

```ts
export type Lookup = (id: string) => Effect.Effect<User, NotFound>;
```

Using a compile-time-only `schema` in value position (for example passing `Lookup` to
`Schema.decodeUnknown`) is reported as a clear compiler error.

### 8.2 Tagged-union `schema` (`| Variant(...)`)

When a `schema` declaration's right-hand side is an indented block of `| UpperIdent`
variants, it declares an algebraic tagged union:

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export schema Color =
  | Red
  | Green
  | Blue
```

Compiles to `Data.TaggedEnum`, positional constructor functions, and a companion
`Schema.Union` of `Schema.TaggedStruct` variants:

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

Rules:

- At least one variant.
- Variant names are UpperCamel, unique, and must differ from the union schema name.
- Constructor names are unique across all tagged-union `schema` and `error` declarations in
  a module; they share one value namespace.
- Field names are lowerCamel, `readonly` by default, and unique within a variant. Variant
  fields may also use Schema scalars and `|> Schema.*` refinements.
- `_tag` is reserved.
- Nullary tagged-union constructors are values: `Red`, not `Red()`.
- Tagged-union `schema` declarations are monomorphic in V1. Generic unions use compile-time
  `schema` aliases or Effect's own types.
- An exported tagged-union `schema` exports the static type, the companion `Schema` value of
  the same name, and its variant constructors; the internal `$Shape` helper is private to
  the module. Use `Circle(...)`/`Red` to construct variants in FunScript, and `Shape` as the
  type or `Schema`.

### 8.3 `error`

```funscript
export error NotFound(id: UUID)
export error ValidationFailed(field: String, message: NonEmptyString)
export error Boom
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

export class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}
```

Construct with positional arguments:

```funscript
Effect.fail(NotFound(id))
```

```ts
Effect.fail(new NotFound({ id }));
```

Fields are `readonly` and support the exact same `Schema` types and `|> Schema.*`
refinements as `schema` declarations. `_tag` is reserved. Because `error` lowers to
`Schema.TaggedError`, every error is **both** a real Effect tagged error (`catchTag`,
`catchAll`, `Effect.fail`, stack traces, and `match` patterns) **and** a runtime `Schema`
that can be serialized/decoded across HTTP or RPC boundaries.

Construction is positional: `NotFound(id)`; the compiler inserts `new` in the emitted
TypeScript. A nullary error is declared as `error Boom` (or `error Boom()`) and constructed
with `Boom()`. This differs from nullary tagged-union `schema` variants, which are constant
values (`Red`), because constructing an error allocates a fresh `Error` instance to capture
the call-site stack trace.

In a pattern, every nullary constructor is a bare name: `Boom`, `Red`, `None`. Only
_construction_ of an error uses parentheses. The parser rejects `Boom()` in pattern
position with a suggestion to drop the parentheses.

Error constructor names share the value namespace with tagged-union `schema` constructors.
The compiler rejects collisions.

---

## 9. Effects

Effect is the only effect model. There is no `async`/`await`, no Promise chain, no
`setTimeout`, and no manual `try`/`catch` in the surface. Promise-based libraries are
interop, wrapped with `Effect.tryPromise` or an Effect platform module.

### 9.1 `effect` blocks

```funscript
export getUser = (id: String) =>
  effect
    user <- UserRepo.find(id)
    org <- OrgRepo.find(user.orgId)
    { user, org }
```

```ts
export const getUser = (id: string) =>
  Effect.gen(function* () {
    const user = yield* (yield* UserRepo).find(id);
    const org = yield* (yield* OrgRepo).find(user.orgId);
    return { user, org };
  });
```

#### Direct service calls

When calling a method on a service inside an `effect` block, you do not need an intermediate
service bind (`repo <- UserRepo`). Calling `user <- UserRepo.find(id)` directly desugars to
fetching the service from Context and invoking the method, auto-tracking `UserRepo` in the
effect's `R` (requirements) channel.

Explicit service binding (`repo <- UserRepo`) remains fully supported when you need to retain
a local reference to the service instance or invoke multiple operations on it.

### 9.2 Bind and discard

```funscript
name <- fetchName()     # const name = yield* fetchName()
_ <- Console.log(name)  # execute and discard the result
```

- `<-` is the **only** way to execute an effect inside an `effect` block.
- `_ <-` executes an effect and discards its value.
- A bare expression is a value, not an execution.

### 9.3 The non-final expression rule and control-flow lowering

Inside an `effect` block, every non-final statement must be one of:

- a binding: `name = expression` or `mut name = expression`
- a reassignment of a local `mut` binding or `mut` field: `target = expression`
- an effect bind: `name <- expression` or `_ <- expression`
- a control-flow statement: `match` (boolean or value) or a nested `effect` block

A bare expression is allowed only as the **final** expression of the block.

Control-flow statements (`match` and nested `effect`) are effect-statement contexts:
their branches follow the same rule, and effects inside them must use `<-` or `_ <-`.
Because `yield*` in JavaScript cannot cross a plain `() => ...` callback boundary, the
emitter lowers `match` inside `effect` blocks as follows:

- **Subjectless (boolean) `match` in an `effect` block** lowers to native JavaScript
  `if / else if / else` statements inside the `Effect.gen(function* () { ... })` generator
  (hoisting a `let` declaration when the `match` is on the right-hand side of `=` or `<-`),
  so `yield*` stays in the generator scope.
- **Value `match` in an `effect` block:** if no arm uses `<-`, `match` lowers to a normal
  `ts-pattern` expression. If any arm uses `<-` (an _effectful match_), each arm body is
  wrapped in `Effect.gen(function* () { ... })` and the entire `match(...)...exhaustive()`
  expression is yielded with `yield*`.

This is a syntax rule, not a type-checking afterthought. It prevents the classic
`Effect.gen` mistake:

```funscript
# Rejected: the Console.log effect is created but never executed.
effect
  user <- UserRepo.find(id)
  Console.log("loaded")      # syntax error: non-final bare expression
  user
```

The fix is explicit:

```funscript
effect
  user <- UserRepo.find(id)
  _ <- Console.log("loaded")
  user
```

### 9.4 Return value

- The final expression of an `effect` block is returned.
- A final binding (`x = ...`) returns the bound value.
- A final effect bind (`x <- ...`) returns the bound value.
- A final `_ <- ...` returns `void` (`undefined` in emitted JS).
- There is no `return` statement: branching uses `match`, and short-circuiting on a
  recoverable failure uses `<- Effect.fail(MyError(...))`.

A final bare `Effect` value is **not** automatically yielded. It is returned as a value.
The compiler's post-typecheck pass warns when an `effect` block's return type is itself an
`Effect`, because that is almost always a missing `_ <-`.

### 9.5 No `try`, `catch`, or `throw`

Recoverable failures are typed values in the `E` channel:

```funscript
export findUser = (id: String) =>
  effect
    user <- UserRepo.find(id)
    user
  |> Effect.catchTag("NotFound", (e) => Effect.succeed({ id: e.id, name: "anonymous" }))
```

#### Automatic error union tracking

When sequencing multiple effectful operations with different error types inside an `effect` block,
the generator's `E` channel automatically infers and tracks the union of all possible errors:

```funscript
export checkout = (cartId: String) =>
  effect
    cart <- CartRepo.find(cartId)  # fails with NotFound
    _ <- PaymentGateway.charge(cart.total)  # fails with PaymentDeclined
    _ <- Inventory.reserve(cart.items)  # fails with OutOfStock
    cart

# Return type inferred as:
# Effect<Cart, NotFound | PaymentDeclined | OutOfStock, CartRepo | PaymentGateway | Inventory>
```

Unhandled domain errors are tracked in the signature and can be handled exhaustively with
`match` or `Effect.catchTag`. If a downstream service adds a new error variant, the TypeScript
compiler flags all unhandled call sites automatically.

#### Zero-cost defect demotion (`orDie`)

When a failure is considered an unrecoverable defect or invariant violation (for example, failing
to load an embedded seed configuration or decoding a hardcoded constant), use `|> orDie`:

```funscript
export loadDefaultConfig =
  effect
    raw <- ConfigRepo.loadDefault |> orDie
    raw
```

`|> orDie` strips the error from the `E` channel (demoting `E` to `never`) and converts any failure
into an uncatchable Effect defect. Thanks to Type-Directed Pipeline Resolution (§8.1), bare `orDie`
resolves directly to `Effect.orDie` with zero extra imports.

Use `Effect.catchAll`, `Effect.catchTag`, `Effect.retry`, `Effect.timeout`,
`Effect.orElse`, and the rest of the combinators. Defects use `Effect.die`; they are not
part of the typed error channel.

There is no `await` and no `async`. Promise interop is explicit:

```funscript
response <- Effect.tryPromise(() => fetch(url))
```

### 9.6 Effect type alias

In type position:

```funscript
schema Fetch = (id: String) => Effect<User, NotFound>
```

```ts
type Fetch = (id: string) => Effect.Effect<User, NotFound>;
```

The full form supports requirements as the third parameter:

```funscript
schema Program = Effect<Void, Never, UserRepo | Logger>
```

Prefer inference for function return types. If you annotate `Effect<A, E>` with only two
parameters, the requirement is `never`; this is correct only when the effect needs no
services.

### 9.7 Running effects: entry modules

Library code only describes effects; it never runs them. Running happens once, at the
edge, in an **entry module**.

```funscript
# src/main.fun
import { Effect } from "effect"
import { program } from "./app.fun"
import { AppLive } from "./layers.fun"

export main =
  program
  |> Effect.provide(AppLive)
```

The scaffolded entry point (and `funscript run`) executes the exported `main` with the
platform runtime's `runMain`:

```ts
// generated: .funscript/entry.ts
import { NodeRuntime } from "@effect/platform-node";
import { main } from "../src/main.js";

NodeRuntime.runMain(main);
```

`runMain` handles `SIGINT`/`SIGTERM` interruption, runs finalizers, logs unhandled
failures, and sets the process exit code.

Rules:

- `Effect.runPromise`, `runSync`, `runFork`, `runCallback`, `runPromiseExit`,
  `runSyncExit`, `Runtime.run*`, and `ManagedRuntime` are allowed only in modules listed
  under `entry` in `funscript.json` (default `["src/main.fun"]`). Anywhere else they are a
  `funscript check` error.
- Real runtime boundaries — an HTTP framework handler, a CLI library callback, a
  serverless handler — are added to `entry` explicitly, so every place that crosses from
  Effect into Promise-land is listed in one reviewed file.
- Tests use `it.effect` / `it.scoped` from `@effect/vitest` and never call `run*`.
- The entry module's `main` must have requirements `never`; a missing layer is a type
  error at `runMain`, not a runtime "service not found".

### 9.8 Concurrency: fibers, channels, and `select`

FunScript has no `go` keyword, no `chan`, and no `select` statement, because Effect already
provides all three as ordinary values. **Fibers are goroutines**: lightweight green threads
scheduled by the Effect runtime. Unlike goroutines they are **structured** — a fiber is
owned by its parent or a `Scope`, interruption propagates automatically (no `ctx`
plumbing), and a failing worker cancels its siblings.

| Go                           | Effect v3                                                      | FunScript                                                        |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `go f()`                     | `Effect.forkScoped` / `Effect.forkChild`                       | `fiber <- Effect.forkScoped(task)`                               |
| wait for a goroutine         | `Fiber.join`                                                   | `result <- Fiber.join(fiber)`                                    |
| `chan T` (buffered)          | `Queue.bounded<T>(n)`                                          | `jobs <- Queue.bounded<Job>(100)`                                |
| `ch <- v` / `v := <-ch`      | `Queue.offer` / `Queue.take`                                   | `_ <- Queue.offer(jobs, job)` / `job <- Queue.take(jobs)`        |
| `select` (first ready wins)  | `Effect.race` / `Effect.raceAll` / `Stream.merge`              | `data <- Effect.race(primary, replica)`                          |
| `errgroup` / `WaitGroup`     | `Effect.all` / `Effect.forEach` with `concurrency`, `FiberSet` | `users <- ids \|> Effect.forEach(fetchUser, { concurrency: 8 })` |
| `sync.Mutex` / semaphore     | `Semaphore.make(n)`, `SynchronizedRef`                         | `sem <- Semaphore.make(1)`                                       |
| `context.WithCancel`         | interruption (`Fiber.interrupt`, scope close)                  | automatic                                                        |
| `time.After` / `time.Ticker` | `Effect.timeout` / `Schedule.spaced`                           | `task \|> Effect.timeout("2 seconds")`                           |
| `defer`                      | `Effect.acquireRelease` / `Effect.ensuring`                    | runs even on interruption                                        |
| fan-out broadcast            | `PubSub`                                                       | `events <- PubSub.unbounded<Event>()`                            |
| one-shot promise / latch     | `Deferred` / `Latch`                                           | `ready <- Deferred.make<void>()`                                 |

#### Structured parallelism (the common case)

Most concurrency is "do these N things in parallel and collect the results". That never
needs an explicit fork:

```funscript
# errgroup: at most 8 in flight; the first failure interrupts the rest
users <- ids |> Effect.forEach(fetchUser, { concurrency: 8 })

# fixed set of heterogeneous tasks, run in parallel, typed record result
{ profile, orders, prefs } <-
  Effect.all({ profile: getProfile(id), orders: getOrders(id), prefs: getPrefs(id) }, { concurrency: 3 })

# select: first to succeed wins, the loser is interrupted
data <- Effect.race(fetchFromPrimary(key), fetchFromReplica(key))

# deadline
report <- buildReport |> Effect.timeout("30 seconds")
```

#### Channels and long-running workers

```funscript
import { Effect, Queue, Schedule } from "effect"

producer = (jobs: Queue<Job>) =>
  pollNewJobs
  |> Effect.flatMap((batch) => Queue.offerAll(jobs, batch))
  |> Effect.repeat(Schedule.spaced("1 second"))

worker = (jobs: Queue<Job>, id: Number) =>
  effect
    job <- Queue.take(jobs)
    _ <- process(job) |> Effect.withSpan("worker.process", { attributes: { id } })
  |> Effect.forever

export pipeline =
  effect
    jobs <- Queue.bounded<Job>(100)               # back-pressure: offer waits when full
    _ <- Effect.forkScoped(producer(jobs))        # "go producer(jobs)"
    _ <- Array.range(1, 4) |> Effect.forEach((i) => Effect.forkScoped(worker(jobs, i)))
    Effect.Never
  |> Effect.scoped                                 # closing the scope interrupts every fiber
```

Rules:

- **Prefer structure over forks.** `Effect.all`, `Effect.forEach`, `Effect.race`, and
  `Stream` cover most needs without ever holding a `Fiber`.
- **`Effect.forkScoped` is the default fork.** Its lifetime is the enclosing `Scope`, so it
  cannot outlive the work that started it. `Effect.forkChild` (owned by the parent fiber)
  is also allowed.
- **`Effect.forkDetach` is flagged by `funscript check`** (a detached fiber is a goroutine
  leak by construction). Long-lived background work belongs in a layer
  (`Layer.effectDiscard(Effect.forkScoped(worker))`), so its lifetime is the application's.
- **Concurrency is explicit and bounded.** `Effect.forEach` / `Effect.all` are sequential
  unless you pass `concurrency`; `concurrency: "unbounded"` is a `funscript check` warning
  that suggests a number.
- **Shared state between fibers** uses `Ref`, `SynchronizedRef`, `Queue`, or `PubSub` —
  never a closure-captured `mut` (already a compile error, §6.2).
- `Queue<A>`, `Fiber<A, E>`, `Deferred<A, E>`, `PubSub<A>`, and `Scope` are blessed type
  aliases (§12.1).

---

## 10. Services and layers

```funscript
import { Console, Effect, Layer } from "effect"

export service Greeter
  greet: (name: String) => Effect<String>

# Pure layer (no dependencies):
export GreeterLive =
  Layer.succeed(Greeter, {
    greet: (name) => Effect.succeed("Hello, {name}!")
  })

# Effectful layer (uses an `effect` block with `<-` to acquire dependencies):
export ConfigurableGreeterLive =
  Layer.effect(Greeter, effect
    prefix <- PrefixConfig
    {
      greet: (name) => Effect.succeed("{prefix}, {name}!")
    }
  )

export main =
  effect
    message <- Greeter.greet("Ada")
    _ <- Console.log(message)
    message
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
  const message = yield* (yield* Greeter).greet("Ada");
  yield* Console.log(message);
  return message;
}).pipe(Effect.provide(GreeterLive));
```

Rules:

- `service Name` uses the service name as the tag.
- `service Name "custom/tag"` sets an explicit tag.
- Member function types use `=>` (which compiles to TypeScript `=>`).
- Service names are UpperCamel.
- Duplicate service tags across a project are a `funscript check` error.
- Services are the only dependency-injection mechanism. There are no globals,
  module-level singletons, or service locators.
- Layers use Effect's standard `Layer` module directly — `Layer.succeed(Service, { ... })`
  for pure layers, `Layer.effect(Service, effect ...)` for layers with `<-` dependencies,
  and `Layer.scoped(Service, effect ...)` for layers that manage resource lifecycles —
  requiring no extra keyword.
- Direct service calls (`message <- Greeter.greet("Ada")`) automatically desugar to resolving the
  service tag from context (`(yield* Greeter).greet("Ada")`), tracking `Greeter` in the `R` channel.
- `yield* Greeter` (written `greeter <- Greeter`) accesses the full service instance when an explicit
  binding is preferred.

---

## 11. Modules

```funscript
import { Effect, Console } from "effect"
import { UserRepo } from "./services/user-repo.fun"
import type { Lookup } from "./types.fun"

export { Circle, Rect, Shape } from "./shapes.fun"
export greet = (name: String) => "Hello, {name}!"
```

Rules:

- ES module syntax only. No `require`, `module.exports`, or dynamic `import()`.
- `.fun` specifiers are rewritten to `.js` in emitted TypeScript; TypeScript resolves
  `.js` specifiers back to `.ts` sources.
- The compiler compiles the import graph (or the project in project mode).
- Top-level declarations are private unless prefixed with `export`.
- FunScript-authored modules use named exports only, written with the `export` prefix on the
  declaration (`export greet = ...`). Barrel re-exports (`export { ... } from "./mod.fun"`
  and `export type { ... } from "./mod.fun"`) are supported for package entry points.
  Default exports (`export default`) and local export lists (`export { x }` without `from`)
  are rejected.
- Named imports are canonical. Default and namespace imports are interop exceptions for
  external packages that require them; do not use them for FunScript modules.
- Import order is preserved. The formatter never reorders imports.
- `import type` is supported.

Exportable declarations:

```funscript
export name = ...
export schema User = ...
export schema Shape = | Circle(radius: Number) | Rect(width: Number, height: Number)
export error NotFound(...)
export service Greeter ...
export { Name } from "./other.fun"
```

---

## 12. Types and Schema integration

Type annotations are TypeScript enhanced with Effect `Schema` integration. Annotations on
bindings and parameters are optional.

```funscript
count: Number = 0
user: User = { id: "1", name: "Ada" }
lookup: (id: String) => Effect<User, NotFound> = ...
```

### 12.1 Blessed Effect type aliases

Usable anywhere a type is accepted (the compiler auto-injects the corresponding `effect`
type import when needed):

| FunScript         | TypeScript                |
| ----------------- | ------------------------- |
| `Effect<A, E, R>` | `Effect.Effect<A, E, R>`  |
| `Option<A>`       | `Option.Option<A>`        |
| `Either<A, E>`    | `Either.Either<A, E>`     |
| `Layer<A, E, R>`  | `Layer.Layer<A, E, R>`    |
| `Stream<A, E, R>` | `Stream.Stream<A, E, R>`  |
| `Array<A>`        | `ReadonlyArray<A>`        |
| `Queue<A>`        | `Queue.Queue<A>`          |
| `Fiber<A, E>`     | `Fiber.Fiber<A, E>`       |
| `Deferred<A, E>`  | `Deferred.Deferred<A, E>` |
| `PubSub<A>`       | `PubSub.PubSub<A>`        |
| `Ref<A>`          | `Ref.Ref<A>`              |
| `Scope`           | `Scope.Scope`             |

### 12.2 Enforcing Effect TS data types by default

FunScript replaces JavaScript's fragile primitives (`number`, `Date`, mutable collections)
with typed Effect primitives by default:

| FunScript type                | Under the hood                            | What it guarantees                                         |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `Int`                         | `Schema.Int`                              | Integer value; rejects floats like `1.5`                   |
| `Float`                       | `Schema.Finite`                           | Rejects `NaN`, `Infinity`, `-Infinity`                     |
| `Decimal`                     | `Schema.BigDecimal`                       | Exact arbitrary-precision decimal (no float rounding bugs) |
| `BigInt`                      | `Schema.BigIntFromSelf`                   | 64-bit+ integers                                           |
| `NonEmptyString`, `Trimmed`   | `Schema.NonEmptyString`, `Schema.Trimmed` | Validates non-empty text, trims whitespace                 |
| `UUID`, `ULID`                | `Schema.UUID`, `Schema.ULID`              | Standard validated identifiers                             |
| `DateTimeUtc`, `Duration`     | `Schema.DateTimeUtc`, `Schema.Duration`   | Replaces `Date`; testable with `TestClock`                 |
| `ReadonlyArray<T>`            | `effect/Array`                            | Immutable array; no `.push()` or in-place mutation         |
| `HashMap<K, V>`, `HashSet<T>` | `effect/HashMap`, `effect/HashSet`        | Structural equality; replaces mutable `Map`/`Set`          |

`Number` is supported; use `Int`, `Float`, or `Decimal` when stronger domain constraints are required.
Any numeric or date type can be refined with `|> Schema.*` (`Int |> Schema.between(1, 100)`).

### 12.3 Static guarantees and runtime boundaries

Inside FunScript, the compiler checks the emitted TypeScript before execution or
build output. Passing a `Number` to a function that requires `String` is a static
error; the command exits non-zero with a source-mapped diagnostic. `--no-check`
explicitly skips this static gate for prototyping; it does not disable runtime
schema validation. See [tooling.md](tooling.md).

Type annotations alone cannot validate values supplied by JavaScript, HTTP JSON,
CLI arguments, environment variables, database rows, or file I/O. Treat those
values as `Unknown` and decode them before they enter domain logic:

```funscript
schema User = {
  name: String
  age: Number
}

greet = (user: User) => "Hello, {user.name}!"

loadGreeting = (raw: Unknown) =>
  effect
    user <- raw |> Schema.decodeUnknown(User)
    greet(user)
```

`Schema.decodeUnknown(User)` returns an Effect whose error channel contains
`ParseError`. `Schema.decodeUnknownEither(User)` returns an Either for explicit
success/failure handling. `Schema.decodeUnknownSync(User)` validates synchronously
and throws on invalid input; use it at synchronous boundaries, or catch that
exception with `Effect.try` when entering an Effect program. JSON text must first
be parsed, for example with `Schema.parseJson(User)`; decoding a record schema
directly from a JSON string does not parse it.

`export js` exposes a function to JavaScript and is a runtime validation boundary:
its generated wrapper validates annotated parameters before running the body.
Primitive parameters receive runtime type checks; schema-backed parameters use
their schema validator. An invalid foreign argument fails at that boundary.
Complex `ts` aliases have no runtime validator merely because they have a static
type; provide a boundary schema and decode those values explicitly.

```funscript
export js greet = (name: String) =>
  effect
    "Hello, {name}!"
```

Schema constructors such as `User({ name: "Ada", age: 36 })` also validate their
payloads at runtime. Keep the runtime validator and static type derived from the
same schema. Use `Option<T>` for absence, and `ts "..."` for complex TypeScript
types; a type escape hatch does not replace boundary decoding. Neither a cast
nor `Unknown` itself proves that an external value satisfies a schema.

### 12.4 Typed holes (`???`)

`???` (optionally followed by a label string: `??? "handle discount"`) is a type-driven
development placeholder that can appear in any expression position:

```funscript
export checkout = (user: User, cart: Cart) =>
  effect
    total = calculateTotal(cart)
    ??? "charge payment provider"
```

How `???` works:

1. **Lowering (`never`):** The compiler lowers `???` to
   `(() => { throw new Error("not implemented: charge payment provider"); })()`, which
   TypeScript infers as type `never` (the bottom type, assignable to any expected type
   without poisoning surrounding inference like `any` would).
2. **Contextual type and scope inspection:** During the post-typecheck pass, the compiler
   queries TypeScript's `checker.getContextualType(node)` and `checker.getSymbolsInScope(node)`
   at the hole's AST node and reports the expected type alongside relevant local bindings:
   ```text
   warning[funscript/typed-hole]: Unfinished hole `???` ("charge payment provider")
     at src/checkout.fun:5:5
     | Expected type: Effect<Receipt, PaymentError, never>
     | In scope:
     |   user  : User
     |   cart  : Cart
     |   total : number
   ```
3. **Dev vs. build:** `???` emits a structured warning in `funscript dev`, `funscript test`, and
   `funscript check` (so you can run and test other branches while sketching code), and is a
   **hard error** in `funscript build` and `funscript check --strict` so an unfinished hole never
   ships to production.

---

## 13. Formatting

The formatter is canonical and has no configuration.

- 2 spaces.
- No semicolons.
- One statement per line.
- One pipeline stage per line when there are three or more stages.
- Match arms aligned under `match` (or inline when a subjectless `match` has two short
  arms: `match | a => x | _ => y`).
- Blank line between top-level declarations.
- Imports preserved in source order.
- Trailing commas in multiline records/arrays.
- String quotes: double quotes (`"..."`) are the default; single quotes (`'...'`) are
  preserved whenever the string contains `{` or `"`, since single-quoted strings are raw
  (non-interpolating).

`funscript fmt` writes; `funscript fmt --check` verifies in CI.

---

## 14. Complete example

```funscript
# A small program using `schema`, tagged unions, `mut` copy-on-write, and effects.

import { Array, Console, Effect, Schema } from "effect"

export schema User = {
  id: NonEmptyString
  name: NonEmptyString |> Schema.trimmed
  active: Boolean
  logins: NonNegativeInt
}

export schema Role =
  | Admin
  | Member(since: String)

export error NotFound(id: String)

export findUser = (users: Array<User>, id: String) =>
  users
  |> Array.findFirst((u) => u.id == id)
  |> Effect.fromOption(() => NotFound(id))

export recordLogin = (user: User) =>
  mut draft = user
  draft.logins = draft.logins + 1
  draft.active = true
  draft

export label = (role: Role) =>
  match role
    | Admin => "admin"
    | Member(since) => "member since {since}"

export main =
  effect
    rawUser <- Schema.decodeUnknown(User)({
      id: "1"
      name: "Ada"
      active: false
      logins: 0
    })
    user = recordLogin(rawUser)
    _ <- Console.log("{user.name} ({user.logins}): {label(Admin)}")
    user.name
```

This example is deliberately ordinary: no macros, no hidden runtime, no FunScript-specific
collections. It is Effect + ts-pattern + Mutative code with a calmer notation.

---

## Appendix A. Grammar sketch

This is a working EBNF, not a final parser specification. `INDENT` and `DEDENT` are
produced by the lexer. Types are parsed as balanced TypeScript token sequences with
optional `|> Schema.*` refinement stages.

```ebnf
program        = { statement } EOF ;

statement      = importDecl
               | exportDecl
               | schemaDecl
               | errorDecl
               | serviceDecl
               | binding
               | mutBinding
               | assignStmt
               | "=>" expression
               | "when" "(" expression ")" ( "=>" expression | block | bracedBlock )
               | expression ;

exportDecl     = "export" ( schemaDecl | errorDecl | serviceDecl | binding | reExport ) ;
reExport       = "{" identList "}" "from" string ;

binding        = pattern [ ":" type ] "=" expression ;
mutBinding     = "mut" identifier [ ":" type ] "=" expression ;
assignStmt     = assignable "=" expression ;
assignable     = identifier { "." identifier | "[" expression "]" } ;

expression     = pipeline ;
pipeline       = logicalOr { "|>" ( pipeMatch | mutStage | logicalOr ) } ;
pipeMatch      = "match" INDENT { matchArm } DEDENT ;
mutStage       = "mut" "(" identifier ")" "=>" ( expression | block ) ;
logicalOr      = logicalAnd { "or" logicalAnd } ;
logicalAnd     = nullish { "and" nullish } ;
nullish        = equality { "??" equality } ;
equality       = comparison { ( "==" | "!=" | "===" | "!==" ) comparison } ;
comparison     = additive { ( "<" | "<=" | ">" | ">=" ) additive } ;
additive       = multiplicative { ( "+" | "-" ) multiplicative } ;
multiplicative = exponent { ( "*" | "/" | "%" ) exponent } ;
exponent       = unary [ "**" exponent ] ;
unary          = ( "not" | "-" ) unary | postfix ;
postfix        = primary { call | member | optMember | index } ;
call           = "(" [ callArg { "," callArg } ] ")" ;
callArg        = "_" | expression ;

primary        = literal
               | identifier
               | "(" expression ")"
               | record
               | array
               | matchExpr
               | effectExpr
               | holeExpr
               | function
               | rawTs
               | string ;

record         = "{" [ recordEntry { ( "," | NEWLINE ) recordEntry } ] "}" ;
recordEntry    = "..." expression
               | dotPath ":" expression
               | string ":" expression
               | identifier ;
dotPath        = identifier { "." identifier } ;

holeExpr       = "???" [ string ] ;

function       = [ "<" typeParams ">" ] params "=>" ( expression | block | type bracedBlock ) ;
params         = "(" [ param { "," param } ] ")" ;
bracedBlock    = "{" { statement } "}" ;
param          = ( identifier | recordPattern | arrayPattern ) [ ":" type ] ;

matchExpr      = "match" expression INDENT { matchArm } DEDENT
               | "match" INDENT { condArm } DEDENT
               | "match" condArm { condArm } ;
matchArm       = "|" orPattern [ "when" expression ] "=>" ( expression | block ) ;
condArm        = "|" ( "_" | expression ) "=>" ( expression | block ) ;
orPattern      = pattern { "|" pattern } ;

effectExpr     = "effect" INDENT { effectStatement } DEDENT ;
effectStatement = binding
                | mutBinding
                | assignStmt
                | effectBind
                | matchExpr
                | expression ;
effectBind     = pattern "<-" expression ;

serviceDecl    = "service" UpperIdent [ string ] INDENT { serviceMember } DEDENT ;
serviceMember  = identifier ":" type ;

errorDecl      = "error" UpperIdent [ "(" [ field { "," field } ] ")" ] ;
schemaDecl     = "schema" UpperIdent [ "<" typeParams ">" ] "=" ( variantBlock | typeExpr ) ;
variantBlock   = INDENT variant { variant } DEDENT
               | variant { variant } ;
variant        = "|" UpperIdent [ "(" field { "," field } ")" ] ;
field          = identifier ":" typeExpr ;
typeExpr       = ( typeRecord | rawType ) { "|>" schemaStage } ;
typeRecord     = "{" [ typeField { ( "," | NEWLINE ) typeField } ] "}" ;
typeField      = identifier ":" typeExpr [ "=" expression ] ;

pattern        = "_"
               | literal
               | LowerIdent
               | UpperIdent [ "(" [ pattern { "," pattern } ] ")" ]
               | recordPattern
               | arrayPattern ;

recordPattern  = "{" [ fieldPattern { "," fieldPattern } ] "}" ;
fieldPattern   = ( identifier | string ) ":" pattern | identifier ;

arrayPattern   = "[" [ ( pattern { "," pattern } [ "," "..." identifier ] ) | "..." identifier ] "]" ;

block          = INDENT { statement } DEDENT ;
```

### Known parser edge cases

1. **Function vs. group.** A leading `(` (or `<` for type parameters followed by `(`) is
   scanned ahead to see whether its closing `)` is followed by `: type =>` or `=>`.
   `(a, b) => ...` is a function; `(a + b)` is a group.
2. **Regex vs. division.** Uses the previous significant token.
3. **`|` in schemas vs. arms.** Tagged-union `schema` variants (`| Variant(...)`) are parsed
   in schema context; `match` arms (and `| A | B =>` or-patterns) are parsed in
   expression/pattern context.
4. **No `>>` operator.** Neither bitwise shift nor point-free `>>` composition is in V1;
   use `(x) => x |> f |> g` (which preserves TypeScript contextual type inference) or
   `flow(f, g)`.
5. **`_` in patterns vs. pipeline calls.** In patterns and `_ <-`, `_` is a wildcard /
   discard marker. In expressions, `_` is allowed only as a direct call argument of a
   pipeline stage (`value |> f(a, _)`); nested or standalone `_` in expressions is
   rejected.
6. **No `as` keyword (Option C).** There is no `as` keyword in FunScript. `as const`,
   `as Type`, and `as any` are rejected. Literal narrowing, fixed tuples, and branded
   types use schema constructors (`Pair([1, "ok"])`, `UUID("1")`) or `Schema.decodeUnknown`.
7. **Raw TS fences.** Backtick blocks are lexed as opaque text with escape handling; they
   cannot contain an unescaped backtick.
8. **Schema declarations and refinement pipelines.** A `schema` right-hand side ends at a
   newline that is not inside balanced `()`, `[]`, `{}`, or `<>` and is not continued by a
   leading `|>` or `|`, or at a dedent.
9. **Effect block statements.** A non-final bare expression is a parse error (see
   §9.3). This is intentional.
10. **Zero-argument and single-argument functions.** Write `() =>` or `(x) =>`;
    parameter lists are parenthesized.
11. **Nullary constructors.** `Red()` is rejected for a tagged-union `schema` variant; write
    `Red`. `Boom()` is a _construction_ of a nullary error (`new Boom()`); the declaration
    may be written `error Boom` or `error Boom()`.
12. **Banned words.** `let`, `var`, `class`, `null`, `undefined`, `any`, `return`, `data`,
    `type`, `with`, and the other reserved words produce a targeted error with the
    Effect-first replacement, not a generic unexpected-token message.
13. **Dedent before leading pipeline.** On a newline with decreased indentation, the lexer
    emits all pending `DEDENT` tokens before suppressing `NEWLINE` for a leading `|>`,
    `.`, or `?.`.

---

## Appendix B. Syntax decisions made during review

These are the choices that came out of checking the surface for ambiguity:

| Decision                                                                      | Why                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified `schema` = Effect `Schema` + Tagged Unions (`\| Variant`) + TS `type` | Naming the keyword `schema` (instead of `type` or `data`) makes it explicit that declarations compile to runtime Effect `Schema` validators + `Data.TaggedEnum` + static TypeScript types.                                                               |
| `\|> Schema.*` refinements + `?` / `= default` in `schema`                    | Constraints, branding, optional fields (`Schema.optional`), and decoding defaults (`Schema.optionalWith`) live directly on the `schema` declaration.                                                                                                     |
| `{ ...x, a.b: 1 }` and `mut` for immutable updates (no `with`)                | Shallow spreads emit `{ ...x, k: v }`, while nested dot-paths (`a.b: 1`) and `mut draft = x` / `\|> mut (d) => ...` lower to Mutative's `create(...)` with fast structural sharing on plain `Schema`/`ts-pattern` objects.                               |
| Local `mut` + `=` with copy-on-write                                          | `mut` marks local mutable bindings and `\|> mut (d) =>` drafts explicitly up front; reassignment uses normal `=` (no extra `:=` operator) and path updates on a `mut` binding lower to `create(...)`.                                                    |
| `\|> f(a, _)` pipeline argument placeholder                                   | Lets uncurried multi-argument functions participate in pipelines without throwaway lambdas, while banning nested `_` (`_.x`, `f(g(_))`) to prevent scope ambiguity.                                                                                      |
| Type-directed pipeline resolution                                             | Bare functions in pipelines (`\|> filter(...) \|> sort`) auto-resolve against the left-hand type's companion module (`Array`, `Option`, `Effect`) via `tsc`, eliminating visual repetition while emitting standard `pipe(xs, Array.filter, Array.sort)`. |
| `\|> match` and `\| A \| B =>` or-patterns                                    | Eliminates dummy scrutinee names at the end of pipelines and maps multi-pattern arms directly to `ts-pattern`'s `.with(p1, p2, handler)`.                                                                                                                |
| No dedicated `layer` keyword                                                  | Because `effect` is already an expression, `Layer.succeed(Svc, { ... })`, `Layer.effect(Svc, effect ...)`, and `Layer.scoped(Svc, effect ...)` are already concise and keep lifecycle semantics (`effect` vs `scoped`) explicit.                         |
| No `>>` point-free composition operator                                       | Point-free `flow(f, g)` degrades TypeScript generic type inference; `(x) => x \|> f \|> g` is explicit and preserves contextual inference.                                                                                                               |
| No `return` keyword                                                           | Blocks, functions, `match` arms, and `effect` blocks evaluate to their final expression; early failure in `effect` uses `<- Effect.fail(...)`.                                                                                                           |
| No `undefined` expression literal                                             | Alongside `null`, `undefined` is banned in expressions; use `Option` (`Option.none()`, `Option.fromNullable`, `Option.getOrUndefined`) or `Effect.void`.                                                                                                 |
| Typed holes (`???`)                                                           | Lowers to `never`-typed throw and inspects `checker.getContextualType` + scope symbols; warns in `dev`/`check`, fails in `build`.                                                                                                                        |
| Constructor-header cache for `match`                                          | Resolves tagged-union `schema` and `error` positional field names across `.fun` files so generated TypeScript keeps readable named destructuring without `_0`, `_1` tuple pollution.                                                                     |
| `=>` in both terms and types                                                  | One arrow in the entire language (`(a: A) => B` for both lambdas and function types, compiling to `=>` in TypeScript); the same arrow is used throughout.                                                                                                |
| No `as` keyword (Option C)                                                    | `as` is eliminated entirely from keywords; `UUID("1")` / `Pair([1, "ok"])` use schema constructors, so brands cannot be forged and narrowing is non-magical.                                                                                             |
| `Clock` / `DateTime` / `Random` instead of `Date.now` / `Math.random`         | Time and randomness are services, so tests control them with `TestClock` and seeded `Random`.                                                                                                                                                            |
| `Config` instead of `process.env`                                             | Configuration is typed, `Schema`-validated, `Redacted` for secrets, and overridable via `ConfigProvider` in tests.                                                                                                                                       |
| `run*` only in `entry` modules                                                | Library code describes effects; `export main` is run once with `runMain`, and every Promise boundary is listed in `funscript.json`.                                                                                                                      |
| No `go` / `chan` / `select` syntax                                            | Effect fibers, `Queue`, and `Effect.race` already are goroutines, channels, and select — structured, interruptible, and typed. `forkScoped` is the default fork; `forkDetach` and unbounded concurrency are flagged.                                     |
| `and`/`or`/`not` only                                                         | One boolean spelling; symbols are rejected, not normalized.                                                                                                                                                                                              |
| Only `match` (no `if`, `then`, `else`, `switch`, or `? :`)                    | One branching construct for both structural patterns (`match x`) and boolean conditions (`match` without a scrutinee), reducing active keywords to 15.                                                                                                   |
| No bitwise operators                                                          | `\|` already has a language meaning; bitwise is rare and explicit via raw TS.                                                                                                                                                                            |
| Capitalization is semantic                                                    | Pattern bindings vs. constructors need no guessing.                                                                                                                                                                                                      |
| `_tag` reserved                                                               | The Effect/ts-pattern discriminant cannot be accidentally shadowed.                                                                                                                                                                                      |
| No `throw`/`try`/`catch`                                                      | Errors are values in Effect's `E` channel.                                                                                                                                                                                                               |
| No `await`/`async`/`Promise`                                                  | One concurrency model: Effect. Promise is interop only.                                                                                                                                                                                                  |
| No `let`, `var`, `:=`, or unannotated reassignment                            | `=` declares an immutable binding unless preceded by `mut` or targeting a `mut` binding / `mut (d) =>` draft; `Effect.Ref` handles concurrent state.                                                                                                     |
| No loops or comprehensions                                                    | Pure iteration is Effect `Array`/`Record`; effectful iteration is `Effect.forEach`.                                                                                                                                                                      |
| No `class`/`new`/`this`                                                       | Records, `schema` (Schema + tagged unions), and `service` cover the same ground without OOP.                                                                                                                                                             |
| No `null`/`undefined`/`any`                                                   | `Option` and `unknown` + `Schema` are the safe representations.                                                                                                                                                                                          |
| No `interface`/`enum`/`namespace`/`type`/`data`                               | `schema` is the one way to describe shapes, tagged unions, and schemas.                                                                                                                                                                                  |
| One function form                                                             | `=>` only; no `function`, method shorthand, or class methods.                                                                                                                                                                                            |
| One zero-arg and single-arg form                                              | `() =>` and `(x) =>` (parameters are parenthesized).                                                                                                                                                                                                     |
| Nullary variant values, nullary error calls                                   | `Red` is a value; `Boom()` allocates a fresh `Error` for stack traces. The compiler enforces the distinction.                                                                                                                                            |
| Non-final bare expressions banned in `effect`                                 | Prevents silently creating an effect and never running it.                                                                                                                                                                                               |
| Semicolons rejected                                                           | Newlines are the only statement separator.                                                                                                                                                                                                               |
| Formatter has no config                                                       | Go-style: one format, no bikeshedding.                                                                                                                                                                                                                   |
