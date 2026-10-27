# Rejected syntax

FunScript is deliberately narrower than JavaScript and TypeScript. This page is the
quick-reference list of what the toolchain rejects or flags, why, and what to write
instead.

The rule behind the list is in [pit-of-success.md](pit-of-success.md): **one way per job**.
If a feature would create a second way to loop, define a function, create an object, model
an error, hold state, or run an effect, it is not in the FunScript surface.

Most entries are parser errors. Method-based habits such as `forEach`, `Object.assign`,
and `Array.push` are `funscript check` warnings (errors in strict mode). Either way, the
canonical answer is the same.

## The table

| Rejected or flagged | Why | Write instead |
| --- | --- | --- |
| `let`, `var`, `:=`, `with`, reassigning an immutable binding, `++`, `--` | Implicit mutability hides state changes; bindings are immutable unless declared `mut`. | Immutable bindings by default; `{ ...user, a.b: 1 }` or `mut draft = user` / `\|> mut (d) -> d.x = 1` (Mutative `create`) for copy-on-write data updates; local `mut x = 0` with `x = x + 1` for local variables; `Effect.Ref` for shared/concurrent state. |
| Top-level `mut` or closure-captured `mut` mutation | Mutable module globals and cross-fiber mutation break Effect's model. | `service` + `Layer` or `Effect.Ref` / `SynchronizedRef`. |
| `for`, `while`, `do`, `break`, `continue` | Loops are where off-by-one and accidental mutation live. | Effect `Array`/`Record`/`HashMap` pipelines for pure iteration; `Effect.forEach` for effects. |
| `forEach` callback loops | A side-effecting callback is a loop in disguise. | `Array.map`/`filter`/`reduce` for values; `Effect.forEach` for effects. |
| `Array.push`/`pop`/`splice`/`sort` outside a `mut` draft, `Object.assign`, `Object.defineProperty` | Unchecked in-place mutation of shared values. | Use `mut draft = items` / `\|> mut (draft) -> draft.push(...)` (Mutative copy-on-write) or Effect `Array`/`Record` modules. |
| Comprehensions (`[x for x in xs]`) | A second iteration syntax. | The Effect `Array` module. |
| `function`, `=>`, `return` | A second function/arrow form and imperative control-flow exits. | `->` for both function expressions and function types (blocks, `match` arms, and `effect` blocks evaluate to their final expression; early failure in `effect` uses `<- Effect.fail(...)`). |
| `() ->` or `x ->` (unparenthesized param) | Multiple parameter-list spellings. | `->` for zero args; `(x) ->` for one or more args. |
| `>>` point-free composition | Degrades TypeScript generic/contextual type inference and creates a second pipeline operator. | `(x) -> x \|> f \|> g` (or Effect's `flow(f, g)` when needed). |
| Default and rest parameters | Hidden call-site behavior. | A record parameter, `Option`, or a wrapper function. |
| `class`, `extends`, `this`, `super`, `prototype`, `new` | OOP is a second data/dependency model. | Records, `schema` (Schema + tagged unions), `error`, `service` + `Layer`; raw TypeScript for a library that demands `new`. |
| `interface`, `enum`, `namespace`, `declare`, `type`, `data` | Competing declaration forms. | `schema` (backed by Effect `Schema` for data shapes and `Data.TaggedEnum` + `Schema.Union` for `\| Variant(...)` tagged unions), `error`, `service`, ES modules; `.d.ts` files may use them. |
| `throw`, `try`, `catch`, `finally` | Unchecked control flow; errors vanish from types. | `error` declarations, `Effect.fail`, `Effect.catch*`, `Effect.retry`. |
| `async`, `await`, `yield`, authored `Promise` | A second effect system. | `effect` + `<-`, or `Effect.tryPromise` at an interop boundary. |
| `null`, `undefined` | Untyped absence values with coercions and `typeof` traps. | `Option` (`Option.none()`, `Option.fromNullable`, `Option.getOrUndefined`) or `Effect.void`. |
| `any`, `as`, `as any`, `as T`, `as const`, `as unknown as T` | Disables the type checker, skips `Schema` validation, or introduces casting syntax. | `unknown` + `Schema.decodeUnknown(MyType)` at boundaries; schema constructors `UUID("1")` / `Pair([1, "ok"])` for known values (Option C: no `as` keyword in FunScript). |
| `Date.now()`, `Date()`, `Math.random()`, `performance.now()`, `crypto.randomUUID()` | Hidden non-deterministic inputs make tests flaky and bugs unreplayable. | `Clock.currentTimeMillis`, `DateTime.now`, `Random.next*` (controlled by `TestClock` / seeded `Random` in tests). |
| `process.env`, `import.meta.env`, `Deno.env`, `Bun.env` | Untyped, possibly-missing globals that tests cannot override safely. | `Config.string` / `Config.integer` / `Config.redacted` / `Schema.Config(name, schema)`; `ConfigProvider.fromMap` in tests. |
| `Effect.runPromise` / `runSync` / `runFork` / `Runtime.run*` / `ManagedRuntime` outside an `entry` module | Running mid-program drops typed errors, interruption, and the caller's layers. | Return the `Effect`; `export main` in the entry module (run with `runMain`); list real runtime boundaries under `entry` in `funscript.json`. |
| `Effect.forkDetach` outside an `entry` module | Detached fibers leak beyond the lifetime of the caller with no owner. | `Effect.forkScoped` (tied to `Scope`), `Effect.forkChild` (tied to parent fiber), or long-lived background work in `Layer.effectDiscard(Effect.forkScoped(...))`. |
| `go`, `chan`, `select` syntax | A second concurrency model and language keywords. | Effect fibers (`forkScoped`), `Queue.bounded` / `take` / `offer`, and `Effect.race` / `Effect.forEach(..., { concurrency })`. |
| `if`, `else`, `then`, `switch`, ternary `? :` | Competing branching constructs. | `match` (both `match value` for pattern matching and subjectless `match` for boolean conditions). |
| `&&`, `||`, `!` | A second boolean spelling. | `and`, `or`, `not`. |
| `===`, `!==` | A second equality spelling. | `==`, `!=`; these compile to strict equality. |
| `<`, `<=`, `>`, `>=` comparison operators | Operators fail silently on `BigDecimal`, `DateTime`, `Duration`, and complex types. | Pure data-last functions: `Number.greaterThan`, `Number.lessThan`, `DateTime.greaterThan`, `BigDecimal.greaterThan`, `Number.between`. |
| `typeof`, `instanceof`, `in`, `delete` in expressions | Runtime reflection and deletion replace typed models. | `Schema.is(MyType)`, `match`, records, `HashMap.has`; type-level `typeof` in raw types is still fine. |
| `eval`, `arguments`, `debugger` | Dynamic scope and hidden behavior. | Explicit functions, records, and services. |
| `require`, `module.exports`, `export default`, local `export { ... }` | CommonJS and redundant export forms. | ESM named imports, the `export` prefix, and barrel re-exports `export { ... } from "./mod.fun"`. |
| Semicolons | Two statement separators. | Newlines only. |

## What the error looks like

The parser does not stop at “unexpected token.” It names the habit and suggests the
Effect-first replacement.

```text
$ funscript check src/main.fun
src/main.fun:3:1  error  `let` is not a FunScript binding
  bindings are immutable by default; use `mut` only for local mutable state
  try: count = 0  (or `mut count = 0` and `count = count + 1`)

src/main.fun:7:3  error  `for` is not FunScript iteration
  use an Effect Array pipeline (pure) or Effect.forEach (effectful)
  try: names |> Array.map((name) -> ...)

src/main.fun:11:5  error  `null` is not a FunScript value
  absence is Option
  try: Option.none()

src/main.fun:15:9  error  `&&` is not a FunScript operator
  use `and`
  try: match | ready and valid -> ... | _ -> ...
```

## The one escape hatch

Raw TypeScript backtick blocks are the only way to write rejected syntax:

```funscript
legacy = `const value = require("legacy-package")`
```

That is explicit, greppable, and expected to be isolated at a boundary. It is not a second
dialect: ordinary FunScript code never looks like the line above.

## Why reject instead of lint?

Style linters are configurable; a language surface is not. A project cannot disable
`funscript check`'s parser rules, add a plugin that accepts `class`, or choose a second loop
form. That is the Go-like trade: fewer choices, one codebase shape, and every exception
visible in review.

The enforcement layers are described in
[pit-of-success.md](pit-of-success.md#3-tooling-is-part-of-the-pit) and
[tooling.md](tooling.md#6-funscript-check).
