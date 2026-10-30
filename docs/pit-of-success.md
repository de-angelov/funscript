# The pit of success

> A good language does not merely allow correct programs. It makes the correct program
> the path of least resistance.

"Pit of success" is Rico Mariani's phrase for a design where the obvious way to do
something is also the safe way. You can still make mistakes, but the common ones are
caught early, locally, and with an explanation.

FunScript is not a proof system and not a sandbox. It is a notation for Effect + ts-pattern
with a deliberate bias: **the guarded path is the short path**.

## 0. The narrow gate

FunScript's pit is not only exhaustive matching. It is that **idiomatic Effect is the only
easily supported way to write a program**.

The language exposes one notation per job. The alternatives are rejected by the parser or
flagged by `funscript check`, not left as style advice.

| Job                                    | The only FunScript way                                                                          | Not supported                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Effects                                | `effect` + `<-`                                                                                 | `async`/`await`, Promise chains                                  |
| Errors                                 | `error` + `Effect.catch*`                                                                       | `throw`, `try`/`catch`, `finally`                                |
| Dependencies                           | `service` + `Layer`                                                                             | globals, singletons                                              |
| Configuration                          | `Config.*` / `Schema.Config`                                                                    | `process.env`, `import.meta.env`                                 |
| Time & randomness                      | `Clock`, `DateTime`, `Random`                                                                   | `Date.now()`, `new Date()`, `Math.random()`, `performance.now()` |
| Running effects                        | `export main` in an entry module (`runMain`)                                                    | `Effect.runPromise` / `runSync` / `runFork` in library code      |
| Validated values                       | schema constructors `UUID("1")` / `Schema.decodeUnknown`                                        | `x as T` casts                                                   |
| Default data & bindings                | immutable `=` and `readonly` fields                                                             | `let`, `var`, unannotated reassignment                           |
| Copy-on-write & local `mut`            | `{ ...x, a.b: 1 }` or explicit `mut` + `=` (Mutative)                                           | implicit mutation, `:=`, `with`, `++`, `--`, top-level `mut`     |
| Shared/concurrent state                | `Effect.Ref` / `SynchronizedRef` / `Queue`                                                      | closure-captured `mut`, module globals                           |
| Concurrency                            | Effect fibers (`Effect.all`/`forEach` with `concurrency`, `forkScoped`, `Queue`, `Effect.race`) | `Promise`, `setTimeout`, detached fibers                         |
| Pure iteration                         | Effect `Array`/`Record` pipelines                                                               | `for`, `while`, `forEach`, comprehensions                        |
| Effectful iteration                    | `Effect.forEach`                                                                                | `for await`, `Promise.all`                                       |
| Data schemas, tagged unions, & aliases | `schema` (`Schema`, `\| Variant(...)`, or TS `type`)                                            | classes, `new`, `type`, `data`, `interface`, `enum`              |
| Typed errors                           | `error`                                                                                         | error classes written by hand                                    |
| Primitive numbers                      | `Number`, refined with `Int` / `Float` / `Decimal` when needed                                  | unchecked external numeric input                                 |
| Nullable values                        | `Option`                                                                                        | `null`, `undefined`, `any`                                       |
| Equality & comparisons                 | value `==` / `!=`, reference `===` / `!==`; primitive comparisons or Effect companion functions | coercing equality                                                |
| Booleans                               | `and` / `or` / `not`                                                                            | `&&`, `                                                          |     | `, `!` |
| Runtime reflection                     | `Schema.is(MyType)` / `match`                                                                   | `typeof`, `instanceof`, `eval`                                   |
| Functions                              | `=>` lambda (implicit final expression)                                                         | `function`, `return`, method shorthand                           |
| Branching & conditionals               | `match` (structural or subjectless boolean), `when` for conditional execution and early returns | `if`, `then`, `else`, ternary, `switch`                          |
| Modules                                | ESM named exports, `export` prefix, `export { ... } from`                                       | CommonJS, default exports, local `export { ... }`                |
| Build / test                           | Vite / Vitest via `funscript`                                                                   | a second bundler or test runner by default                       |

If a feature is not in the left column, it is not part of the supported programming model.
Raw TypeScript (backticks) is the only escape, and it is visible in every code review. The
full rejection table is in [rejected-syntax.md](rejected-syntax.md).

---

## 1. The fifteen guarantees

These are the promises the language and toolchain try to keep. Each one has a failure
mode it removes, a mechanism that enforces it, and an escape hatch for the cases where
the rule is wrong.

### 1.1 You cannot forget a case

**The failure:** adding a variant to a union and forgetting to update a `switch` or a
chain of `if`s. TypeScript may not notice; the bug ships.

**The FunScript path:**

```funscript
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)

export area = (shape: Shape) =>
  match shape
    | Circle(r) => Math.PI * r * r
    | Rect(w, h) => w * h
```

**The mechanism:** `match` without `_` compiles to ts-pattern's `.exhaustive()`. When a
variant is added, the generated TypeScript fails to typecheck. The diagnostic is mapped
back to the `match` expression.

**The feedback:**

```text
main.fun:9:3  error  match is not exhaustive
  missing: Triangle
  add a `| Triangle(...) => ...` arm, or opt out with `| _ => ...`
```

**The escape hatch:** `_` is explicit. A wildcard arm is a deliberate statement that the
match is total enough for now, and it is easy to grep for.

**Enforced by:** ts-pattern + `tsc`, reported by `funscript check`.

---

### 1.2 You cannot hide an effect

**The failure:** writing an Effect value and never running it. In raw `Effect.gen`, this
is easy:

```ts
Effect.gen(function* () {
  const user = yield* findUser(id);
  Console.log("loaded"); // creates an Effect, never runs it
  return user;
});
```

**The FunScript path:**

```funscript
effect
  user <- findUser(id)
  _ <- Console.log("loaded")
  user
```

**The mechanism:** inside an `effect` block, `<-` is the only way to execute an effect.
A bare expression is only allowed as the final expression. A non-final bare expression
is a **syntax error**, not a silent no-op:

```funscript
effect
  user <- findUser(id)
  Console.log("loaded")      # error: non-final bare expression
  user
```

The compiler suggests `_ <- Console.log("loaded")`. The same rule applies inside the
branches of `match` statements in an effect block.

**The feedback:**

```text
main.fun:12:3  error  non-final expression in effect block
  this value is not executed; use `<-` to run an effect
  try: _ <- Console.log("loaded")
```

**The remaining sharp edge:** a final bare `Effect` value is returned, not run. After
typechecking, the compiler warns when an `effect` block returns a nested `Effect`, which
is almost always a missing `_ <-`.

**Enforced by:** parser (non-final rule) + `tsc` (nested-effect warning).

---

### 1.3 You cannot hide a dependency

**The failure:** a function reaches for a global database, logger, or config object.
Tests become order-dependent, and production wiring is invisible.

**The FunScript path:**

```funscript
export service UserRepo
  find: (id: String) => Effect<User, NotFound>

export findUser = (id: String) =>
  effect
    user <- UserRepo.find(id)
    user
```

The requirement is in the type: `Effect<User, NotFound, UserRepo>`. Direct service calls
(`UserRepo.find(id)`) automatically desugar to resolving the service from Context, keeping
`UserRepo` tracked in the `R` channel without requiring an intermediate service binding. If you
forget to provide `UserRepoLive`, the program does not typecheck.

**The mechanism:** `service` lowers to `Context.Tag`. The requirement stays in
Effect's `R` channel. Layers are values; there is no global registry to fall back on.

**The feedback:**

```text
main.fun:20:3  error  missing service: UserRepo
  provide it with `|> Effect.provide(UserRepoLive)`
```

**The escape hatch:** `Effect.provideService`, `Effect.provideContext`, and test layers
are ordinary Effect APIs. Nothing is hidden behind a FunScript-only container.

**Enforced by:** Effect's type system + `tsc` + `funscript check`.

---

### 1.4 You cannot throw an untyped error

**The failure:** `throw new Error("not found")` escapes the type system. Callers cannot
see it in the signature, `catch` is easy to forget, and the error channel is a lie.

**The FunScript path:**

```funscript
export error NotFound(id: String)

export findUser = (id: String) =>
  effect
    user <- UserRepo.find(id)
    user
  |> Effect.catchTag("NotFound", (e) => Effect.succeed(anonymous(e.id)))
```

**The mechanism:** there is no `throw`, `try`, or `catch` syntax. Recoverable failures
are values in Effect's `E` channel, declared with `error` and handled with the normal
combinators. Calling operations with different error types automatically aggregates their
union in `E` (e.g. `NotFound | PaymentDeclined`), enforced exhaustively via `match`.
`Schema.TaggedErrorClass` keeps `_tag`, stack traces, `catchTag`, and runtime
`Schema` serialization working.

Errors are constructed positionally: `NotFound(id)`, `Boom()`. This is deliberately
different from nullary tagged-union `schema` constructors, which are values (`Red`). The
compiler enforces the distinction, so a variant value cannot be called and an error
constructor cannot be used as a bare value. In patterns all nullary constructors are bare
names (`Boom`, `Red`, `None`).

**The feedback:** forgetting to handle an error is a type error when the caller's
signature says `Effect<A, NotFound>`. `catchTag` requires a real tag.

**The escape hatch:** `Effect.die` or `|> orDie` for defects. Defects are not typed recoverable errors,
and the distinction is explicit: `orDie` demotes typed failures in `E` to uncatchable fiber defects,
stripping them from the signature.

**Enforced by:** parser (no `throw`) + Effect's `E` channel + `tsc`.

---

### 1.5 You cannot mutate by accident

**The failure:** a stray `x++`, an accidentally mutated record field or shared array, or a
mutable variable captured across a closure or fiber.

**The FunScript path:**

```funscript
export schema Counter = {
  id: String
  count: NonNegativeInt
}

older = { ...user, age: user.age + 1, address.city: "Paris" }

bump = (c: Counter) =>
  mut draft = c
  draft.count = draft.count + 1
  draft

effect
  shared <- Ref.make(0)
  _ <- Ref.update(shared, (n) => n + 1)
  Ref.get(shared)
```

**The mechanism:** FunScript is **immutable-first, explicit copy-on-write**:

- Bindings (`x = 1`) are `const` and all records, arrays, and `type`/`error` values are
  deeply `readonly` at rest.
- Concise deep record spreads (`{ ...user, address.city: "Paris" }`) and imperative `mut`
  drafts (`mut draft = c` or `c |> mut (draft) => ...`) compile to Mutative's
  structural-sharing `create(...)` — producing a new immutable value without mutating the
  input reference.
- Without `mut`, `=` is only for new declarations; reassigning with `=` is only permitted
  on a `mut` binding (`mut x = 0`) or `|> mut (draft) =>` draft, and path updates on a
  local `mut` binding lower to `create(...)`.
- `mut` bindings are strictly local to a function or `effect` block: they are rejected at
  module top-level and cannot be mutated inside an escaping closure.
- Shared or concurrent state across fibers uses `Effect.Ref`, `SynchronizedRef`, or
  `Effect.Queue`.

**The feedback:** `x = x + 1` on an immutable binding is a mutability error; `x.a = 1`
on an immutable binding suggests `{ ...x, a: 1 }` or `mut draft = x` (or `Effect.Ref` for
shared state).

**The escape hatch:** `{ ...x, a.b: 1 }` / `mut` (Mutative `create`) for copy-on-write data
manipulation; `Effect.Ref` for concurrent state; raw TypeScript for mutable interop.

**Enforced by:** grammar + resolver + `tsc`.

---

### 1.6 You cannot lose the types (or let schemas drift from types)

**The failure:** a language with its own type system disagrees with the ecosystem; or
static TypeScript types drift out of sync with runtime validation schemas and everything
degrades to `any` at boundaries.

**The FunScript path:** data `schema` declarations compile directly to Effect `Schema` values
**and** their inferred static TypeScript types (`typeof Name.Type`), while non-data schemas
pass through to `tsc`.

```funscript
export schema User = {
  id: UUID
  name: NonEmptyString |> Schema.trimmed
}

schema Lookup = (id: UUID) => Effect<User, NotFound>

export lookup: Lookup = (id) =>
  effect
    repo <- UserRepo
    raw <- repo.findRaw(id)
    raw |> Schema.decodeUnknown(User)
```

**The mechanism:** declaring a data `schema` emits both `export const User = Schema.Struct(...)`
and `export type User = typeof User.Type`. Built-in Schema scalars (`Int`, `UUID`,
`NonEmptyString`, etc.) and `|> Schema.*` refinement pipelines live directly in the `schema`
declaration, so the static type and the runtime validator are defined once and can never
drift apart. Non-data schemas (functions, `Effect`, `Layer`, `Stream`, generics) emit pure
TypeScript `type` aliases. Explicit `any` in FunScript-authored types is a compiler error.

**The feedback:** normal TypeScript errors at compile time and structured `Schema` parse
errors at runtime boundaries, mapped back to `.fun` spans. `strict` is the default in
`funscript new`.

**The escape hatch:** raw TypeScript is explicit and greppable (`as T` casts are not in the
surface; see §1.12). `any`
from an npm package is still `any`; FunScript cannot fix a bad dependency, so decode it at the
boundary with `raw |> Schema.decodeUnknown(MyType)`.

**Enforced by:** `Schema` emitter + `tsc` + `funscript check`.

---

### 1.7 You cannot get stuck in the output

**The failure:** a source-to-source language generates unreadable code, so debugging
means reading a compiler's private IR, and leaving the language means rewriting
everything.

**The FunScript path:** the emitted TypeScript is formatted, source-mapped, and treated as a
product. `funscript emit` gives you the `.ts` files. Deleting FunScript and keeping the output is
a supported exit.

```funscript
names =
  users
  |> Array.map((u) => u.name)
```

```ts
const names = pipe(
  users,
  Array.map((u) => u.name),
);
```

**The mechanism:** golden tests review emitted TypeScript. The compiler does not minify,
rename, or macro-expand. Source maps compose `.fun` → `.ts` → `.js`. There is no FunScript
runtime to remove.

**The feedback:** `funscript emit` is a first-class command, not a debug flag. The output is
documented and stable within a release line.

**The escape hatch:** eject entirely. The generated code imports `effect`, `ts-pattern`,
and your packages; nothing else.

**Enforced by:** golden tests, code review, and the no-runtime rule.

---

### 1.8 You cannot bikeshed the basics

**The failure:** every project invents its own formatter, test setup, bundler config, and
directory layout. Onboarding cost is paid forever.

**The FunScript path:** one command and one default for each concern:

```text
funscript new       scaffold a Vite + Vitest + TypeScript project
funscript dev       Vite dev server + typecheck
funscript build     check + Vite production build
funscript test      Vitest, discovers *.test.fun
funscript check     parse + resolve + tsc + project checks
funscript fmt       canonical formatter, no config
funscript run       compile and execute a script
funscript add       delegate to npm/pnpm/bun
```

**The mechanism:** Vite is the default build engine, Vitest the default test runner,
`tsc` the type checker, and `funscript fmt` the only formatter. The generated
`vite.config.ts` and `tsconfig.json` are small, readable, and editable when a project
genuinely needs to deviate.

**The feedback:** `funscript build` fails if `funscript check` fails. CI runs
`funscript fmt --check`, `funscript check`, `funscript test --run`, and `funscript build` — the same
commands developers run locally.

**The escape hatch:** the config files are real Vite/TypeScript config files. There is no
FunScript-specific build format to learn or escape.

**Enforced by:** the CLI and the scaffold.

---

### 1.9 You cannot hide time or randomness

**The failure:** `Date.now()`, `new Date()`, and `Math.random()` are hidden inputs. Code
that reads them is non-deterministic: tests become flaky ("passes except around midnight"),
time-based logic (expiry, retries, rate limits) cannot be tested without real waiting, and
bugs cannot be replayed.

**The FunScript path:** time and randomness are Effect services, like every other input.

```funscript
import { Clock, DateTime, Effect, Random } from "effect"

export isExpired = (token: Token) =>
  effect
    now <- DateTime.now
    DateTime.greaterThan(now, token.expiresAt)

export rollDice =
  Random.nextIntBetween(1, 7)
```

```funscript
# token.test.fun — the clock is controlled; no real waiting
import { expect, it } from "@effect/vitest"
import { Effect, TestClock } from "effect"

it.effect("expires after one hour", () =>
  effect
    token <- issueToken(user)
    _ <- TestClock.adjust("61 minutes")
    expired <- isExpired(token)
    expect(expired).toBe(true)
)
```

**The mechanism:** `Date.now`, `Date()`, `Math.random`, `performance.now`, and
`crypto.randomUUID` / `crypto.getRandomValues` are rejected by `funscript check` (`new Date`
is already rejected because there is no `new`). The replacements are Effect's built-in
`Clock`, `DateTime`, and `Random` services, which are provided by default in production and
replaced by `TestClock` and a seeded `Random` in `@effect/vitest`'s `it.effect`.

**The feedback:**

```text
billing.fun:12:11  error  `Date.now()` is a hidden input
  time is an Effect service; it makes code testable with TestClock
  try: now <- Clock.currentTimeMillis   (or DateTime.now)
```

**The escape hatch:** raw TypeScript for a library that insists on `Date`; convert at the
boundary with `DateTime.unsafeFromDate`.

**Enforced by:** `funscript check` (global-name resolution) + Effect's default services.

---

### 1.10 You cannot run an effect in the middle of your program

**The failure:** `Effect.runPromise(...)` or `Effect.runSync(...)` buried inside a helper.
It looks harmless, but it escapes everything Effect gives you: the typed error becomes a
rejected `Promise` or a thrown exception, interruption stops propagating, the caller's
layers and services are silently ignored, and `runSync` crashes on any async step.

**The FunScript path:** library code only _describes_ effects. Running happens once, at the
edge, in an **entry module**:

```funscript
# src/main.fun — the entry module
import { Effect, Layer } from "effect"
import { program } from "./app.fun"
import { AppLive } from "./layers.fun"

export main =
  program
  |> Effect.provide(AppLive)
```

`funscript run` and the scaffolded entry point execute the exported `main` with the platform
runtime's `runMain` (`NodeRuntime.runMain` / `BunRuntime.runMain`), which wires up
`SIGINT`/`SIGTERM` interruption, finalizers, error logging, and the process exit code. You
do not write the run call at all.

**The mechanism:** `Effect.runPromise`, `runSync`, `runFork`, `runCallback`,
`runPromiseExit`, `runSyncExit`, `Runtime.run*`, and `ManagedRuntime` are only allowed in
modules listed as `entry` in `funscript.json` (default: `src/main.fun`). Framework adapters
that genuinely need to cross into Promise-land (an HTTP framework handler, a CLI library
callback) are added to `entry` explicitly, so every runtime boundary is listed in one place.
Tests use `it.effect` and never call `run*`.

**The feedback:**

```text
src/users.fun:18:5  error  `Effect.runPromise` outside an entry module
  running here drops typed errors, interruption, and the caller's layers
  try: return the Effect and let the caller compose it
  (or add this file to "entry" in funscript.json if it is a runtime boundary)
```

**The escape hatch:** the `entry` list. It is config, it is reviewed, and it is short.

**Enforced by:** `funscript check` + `funscript.json`.

---

### 1.11 You cannot read configuration from globals

**The failure:** `process.env.DATABASE_URL` is `String | undefined`, read at an arbitrary
moment, parsed by hand (`Number(process.env.PORT)` is `NaN` when it is missing), impossible
to override in a test without mutating global state, and easy to log by accident.

**The FunScript path:** configuration is a typed, validated Effect `Config`:

```funscript
import { Config, Console, Effect, LogLevel, Schema } from "effect"

export schema Port = Int | Schema.between(1, 65535)

export AppConfig =
  Config.all({
    port: Schema.Config("PORT", Port)
    databaseUrl: Config.redacted("DATABASE_URL")
    logLevel: Config.logLevel("LOG_LEVEL") |> Config.withDefault(LogLevel.Info)
  })

export start =
  effect
    config <- AppConfig
    _ <- Console.log("listening on {config.port}")
    startServer(config)
```

**The mechanism:** `process.env`, `import.meta.env`, `Deno.env`, and `Bun.env` are
rejected by `funscript check`. `Config` reads from Effect's `ConfigProvider` (environment
variables by default), validates with `Schema`, and fails with a typed `ConfigError` that
names the missing or malformed key. `Config.redacted` returns a `Redacted` value that
prints as `<redacted>` in logs and errors. Tests swap the source with
`ConfigProvider.fromMap(...)` — no global mutation.

**The feedback:**

```text
src/db.fun:4:9  error  `process.env` is an untyped global
  configuration is read with Config so it is validated and testable
  try: url <- Config.redacted("DATABASE_URL")
```

At runtime, a missing key fails at startup with
`(Missing data at DATABASE_URL: "Expected DATABASE_URL to exist in the process context")`
instead of an `undefined` deep inside a request.

**The escape hatch:** a custom `ConfigProvider` (files, a secrets manager) is ordinary
Effect code; raw TypeScript for a library that reads the environment itself.

**Enforced by:** `funscript check` + Effect `Config` + `Schema`.

---

### 1.12 You cannot cast your way past a schema

**The failure:** `"1" as UUID`, `input as User`, `0 as NonNegativeInt`. Each cast tells
TypeScript "trust me" and skips the runtime validator that the `schema` declaration exists
to provide. Branded types become meaningless if anyone can mint one with `as`.

**The FunScript path:** every data-shape `schema` is also its own **constructor**. Values
are either constructed (and validated) or decoded — never asserted:

```funscript
export schema UserId = UUID |> Schema.brand("UserId")
export schema User = {
  id: UserId
  name: NonEmptyString
  age: Int |> Schema.between(0, 150)
}

# Known values: construct. Literal arguments are validated at compile time.
ada = User({ id: UserId("0b9e…"), name: NonEmptyString("Ada"), age: 36 })

# Untrusted values: decode, with a typed ParseError in the E channel.
load = (raw: Unknown) => raw |> Schema.decodeUnknown(User)
```

**The mechanism:**

- `Name(value)` lowers to `Name.make(value)` (`Schema.UUID.make("…")`, `User.make({ … })`),
  which validates and brands.
- When the argument is a literal (or a record/array of literals), the compiler runs the
  schema at compile time, so `Age(200)` or `UUID("nope")` is a **compile error**, not a
  runtime one.
- A non-literal argument that fails validation throws a defect; for untrusted input
  `funscript check` suggests `Schema.decodeUnknown`, which keeps the failure typed.
- There is no `as` keyword in FunScript (Option C). `x as T`, `as const`,
  `as unknown as T`, and `as any` are parser errors. Exact tuples and narrowed values use
  schema constructors (`Pair([1, "ok"])`, `Role("admin")`).

**The feedback:**

```text
src/seed.fun:3:22  error  `as` cannot assert a schema type
  `"1" as UUID` skips validation
  try: UUID("1")  (validated at compile time for literals)

src/seed.fun:7:15  error  invalid literal for schema `Age`
  Expected a number between 0 and 150, actual 200
```

**The escape hatch:** raw TypeScript (`` `x as T` ``) — visible in review, which is the
point.

**Enforced by:** parser (no `as T`) + compile-time literal validation + `Schema.make`.

---

### 1.13 You cannot leak a goroutine

**The failure:** in Go, a goroutine blocked on a channel nobody reads lives forever; in
Promise code, a fire-and-forget `promise.then(...)` keeps running after the request that
started it was cancelled. Cancellation needs manual `ctx` plumbing, and one failing worker
does not stop the others.

**The FunScript path:** concurrency is **structured**. The common cases need no fork at all,
and the fork you do write is owned by a scope:

```funscript
# Parallel, bounded, fail-fast: the first failure interrupts the other in-flight fetches
users <- ids |> Effect.forEach(fetchUser, { concurrency: 8 })

# Long-running workers live exactly as long as their scope
export pipeline =
  effect
    jobs <- Queue.bounded<Job>(100)
    _ <- Effect.forkScoped(producer(jobs))
    _ <- Effect.forkScoped(worker(jobs))
    Effect.Never
  |> Effect.scoped
```

**The mechanism:** Effect fibers are supervised. `Effect.forkScoped` ties a fiber to the
enclosing `Scope`; `Effect.forkChild` ties it to the parent fiber; closing either interrupts
it and runs its finalizers (`acquireRelease`, `ensuring`). `funscript check` adds:

- `Effect.forkDetach` is an error outside an `entry` module (suggest `forkScoped`, or
  `Layer.effectDiscard(Effect.forkScoped(...))` for application-lifetime background work);
- `concurrency: "unbounded"` is a warning (suggest a number);
- closure-captured `mut` across fibers is already a compile error (§1.5); shared state uses
  `Ref`, `SynchronizedRef`, `Queue`, or `PubSub`.

**The feedback:**

```text
src/notify.fun:9:7  error  `Effect.forkDetach` creates a fiber nobody owns
  it keeps running after its caller is interrupted
  try: Effect.forkScoped(sendEmails)   (inside `|> Effect.scoped` or a layer)
```

**The escape hatch:** `Effect.forkDetach` in an `entry` module, or `Effect.forkIn(scope)`
with an explicitly managed `Scope`.

**Enforced by:** Effect's fiber supervision + `funscript check`.

---

### 1.14 You cannot write silent comparison bugs

**The failure:** in JavaScript, `<, <=, >, >=` operators only work on primitive numbers and
strings. When applied to `BigDecimal`, `DateTime`, `Duration`, or complex domain objects,
they coerce to `NaN` or compare by object reference, failing silently. Furthermore, floating
point math produces `0.1 + 0.2 == 0.3` bugs.

**The FunScript path:** comparisons are pure, data-last functions that work on any type:

```funscript
# Numbers
isValid = score |> Number.greaterThanOrEqualTo(0)

# Dates and Times
isExpired = DateTime.greaterThan(now, token.expiresAt)

# High-precision Decimals (no float rounding errors!)
isProfit = BigDecimal.greaterThan(netIncome, BigDecimal.fromNumber(0))
```

**The mechanism:** the parser rejects `<`, `<=`, `>`, and `>=` in expression position.
Developers use the corresponding typed module (`Number.greaterThan`, `DateTime.greaterThan`,
`BigDecimal.greaterThan`, `Number.between`).

**The feedback:**

```text
src/calc.fun:5:12  error  `<` is not a FunScript comparison operator
  comparison operators fail silently on DateTime, BigDecimal, and custom types
  try: score |> Number.greaterThan(10)   (or DateTime.greaterThan, BigDecimal.greaterThan)
```

**Enforced by:** grammar (no comparison operators) + typed ordering functions.

---

### 1.15 You cannot use fragile JavaScript primitives

**The failure:** JavaScript's `Number` allows `NaN`, `Infinity`, and precision loss; `Date`
is mutable and timezone-dependent; `Map`/`Set` compare by reference, not value equality.

**The FunScript path:** Effect TS data types are the defaults:

- `Number` is the numeric primitive; `Int`, `Float` (`Finite`), and `Decimal` (`BigDecimal`) add domain constraints;
- `DateTimeUtc` replaces `Date`;
- `ReadonlyArray`, `HashMap`, `HashSet` replace mutable JS collections.

```funscript
export schema Order = {
  id: UUID
  amount: Decimal
  itemsCount: Int
  createdAt: DateTimeUtc
}
```

**The mechanism:** Use refined schemas at boundaries when `Number` alone is too
permissive. Runtime decoding checks the refinement. Collections are immutable at rest.

**The feedback:**

```text
A domain schema can use Int for integers, Float for finite floats,
or Decimal for exact math; invalid external input fails schema decoding.
```

**Enforced by:** `funscript check` + Effect `Schema` scalar types.

---

## 2. Failure modes at a glance

| Failure mode                       | Raw TypeScript + Effect                     | FunScript guardrail                                                                    | Caught by                              |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| Missing union case                 | `switch`/`if` chain, no exhaustiveness      | `match` without `_` is exhaustive                                                      | ts-pattern + `tsc`                     |
| Effect created but not run         | bare `Effect` expression                    | non-final bare expressions rejected; nested-return warning                             | parser + type pass                     |
| Missing service                    | runtime “service not found”                 | requirement in `R` channel                                                             | `tsc`                                  |
| Thrown exception                   | invisible in signature                      | `error` declarations + `E` channel                                                     | parser + `tsc`                         |
| Accidental mutation                | `let`, `++`, mutable fields/arrays          | immutable by default; `{ ...x, a.b: 1 }`, explicit local `mut`, or `Effect.Ref`        | parser + resolver + `tsc`              |
| Type/validator drift               | separate TS `type` and runtime schema       | data & tagged-union `schema` compile to both `Schema` and TS `type`                    | emitter + `tsc`                        |
| Loose equality                     | coercing `==`                               | value equality via `Equal.equals` for structures and strict JS equality for primitives | emitter                                |
| Null/`undefined`/`any` soup        | `null`/`undefined` checks, `any`            | `Option`; `Unknown` + `Schema.decodeUnknown(MyType)`                                   | parser + `tsc`                         |
| Ad-hoc OOP                         | `class`, `new`, `this`                      | records, `type`, `service`                                                             | parser                                 |
| Promise concurrency                | `async`/`await`, `Promise.all`              | Effect fibers                                                                          | parser                                 |
| Loop smorgasbord                   | `for`, `while`, `forEach`, comprehensions   | `Array` pipelines or `Effect.forEach`                                                  | parser + check                         |
| Multiple function forms            | `function`, methods, class methods          | `=>` only                                                                              | parser                                 |
| Boolean symbol spelling            | `&&`, `!`                                   | `and`, `not`                                                                           | parser                                 |
| Stringly-typed tags                | `_tag: String`                              | tagged-union `schema` constructors + exhaustive match                                  | `type` generator + `tsc`               |
| Global singleton                   | module-level mutable state                  | `service` + layers                                                                     | `tsc`                                  |
| Flaky time/random logic            | `Date.now()`, `Math.random()`               | `Clock` / `DateTime` / `Random` + `TestClock`                                          | `funscript check`                      |
| Effect run mid-program             | `Effect.runPromise` in a helper             | `run*` only in `entry` modules; `export main` + `runMain`                              | `funscript check`                      |
| Missing/malformed config           | `process.env.X` (`String \| undefined`)     | `Config` + `Schema` + `Redacted`                                                       | `funscript check` + `ConfigError`      |
| Unvalidated brand/cast             | `"1" as UUID`, `input as User`              | schema constructors `UUID("1")` + `Schema.decodeUnknown`                               | parser + compile-time literal check    |
| Leaked goroutine / fire-and-forget | detached promises, goroutines without `ctx` | `Effect.forEach`/`all` with `concurrency`, `forkScoped`; `forkDetach` flagged          | Effect supervision + `funscript check` |
| Bad formatting                     | Prettier/ESLint/config drift                | one canonical formatter                                                                | `funscript fmt --check`                |
| Vite/Vitest setup drift            | per-project config                          | `funscript new` + `funscript dev/test/build`                                           | CLI                                    |
| Unreadable generated code          | macros/IR                                   | readable TypeScript + `funscript emit`                                                 | golden tests                           |
| Runtime lock-in                    | custom runtime                              | no runtime                                                                             | design                                 |

---

## 3. Tooling is part of the pit

A language is not just its grammar. The toolchain decides what is easy.

### 3.1 `funscript check` is the gate

`funscript check` runs, in order:

1. lexing and parsing;
2. resolution (scopes, constructors, arity, exports);
3. FunScript-specific checks:
   - banned JavaScript/TypeScript surface (parser);
   - non-final bare expressions in `effect` blocks;
   - mutability rules: no top-level `mut`, no closure-captured `mut` mutation, no
     reassignment of immutable bindings or non-`mut` fields;
   - schema/type rules: compile-time-only `type` aliases cannot be used in runtime value
     position;
   - duplicate `service` tags across the project;
   - `_tag` field collisions;
   - constructor names that collide across tagged-union `schema` and `error`;
   - variant names that collide with their union `type`;
   - nullary variant values called as functions, or `error` constructors used as bare values;
   - explicit `any` in FunScript-authored types, and `as` in all forms (`as const`, `as T`);
   - schema constructor calls with literal arguments are validated against the schema at
     compile time (`Age(200)` is an error);
   - hidden inputs: `Date.now`, `Date()`, `Math.random`, `performance.now`,
     `crypto.randomUUID` (use `Clock` / `DateTime` / `Random`);
   - environment globals: `process.env`, `import.meta.env`, `Deno.env`, `Bun.env` (use
     `Config`);
   - `Effect.run*` / `Runtime.run*` / `ManagedRuntime` outside modules listed in `entry`;
   - `Effect.forkDetach` outside `entry` modules (error) and `concurrency: "unbounded"`
     (warning);
   - unreachable match arms;
   - known mutating JS methods such as `Array.push`/`splice`/`sort` on non-`mut` bindings
     and callback `forEach` loops (warning; error in strict mode);
   - unused imports? (warning only)
4. emit TypeScript;
5. `tsc --noEmit` with the project's config;
6. map diagnostics back to `.fun`;
7. post-typecheck diagnostics (typed holes `???` showing contextual expected type and local
   scope — warning in `funscript dev`/`funscript check`, error in `funscript build`; nested `Effect`
   returns; `any` leaks in public APIs).

`funscript build` and `funscript test` run `funscript check` first. If the check fails, the build
fails. That is the Go-like contract: the compiler is the first reviewer.

### 3.2 `funscript dev` is the fast loop

- Starts Vite with the FunScript plugin.
- Compiles `.fun` on demand; HMR for web apps.
- Runs a typecheck watcher in parallel.
- Shows syntax/type errors in the terminal and, for Vite apps, in the browser overlay.
- Formats on save through the LSP.

The goal is that the five-second loop catches the same mistakes as CI.

### 3.3 `funscript test` is the safety net

- Discovers `*.test.fun`.
- Runs Vitest with the same Vite plugin used by the app.
- Supports `@effect/vitest` for Effect tests.
- Typechecks test files by default (`--no-check` to skip).
- Uses the same module resolution and environment as the build.

A test file looks like normal FunScript:

```funscript
import { expect, test } from "vitest"
import { Circle, area } from "../src/shapes.fun"

test("area of a circle", () =>
  expect(area(Circle(2))).toBeCloseTo(12.566)
)
```

### 3.4 `funscript fmt` removes the argument

- No config.
- One style.
- `--check` in CI.
- Editor format-on-save through the LSP.

This is the `gofmt` principle: style is not a discussion, it is a command.

### 3.5 `funscript new` starts in the pit

The default scaffold:

```text
my-app/
  package.json
  tsconfig.json          # strict, ES2022, bundler resolution
  vite.config.ts         # @funscript/vite plugin
  src/
    main.fun
  tests/
    main.test.fun
```

It includes:

- Vite + `@funscript/vite`;
- Vitest;
- TypeScript strict mode;
- a formatting-on-save editor config;
- a passing test;
- a `main` that runs with `funscript dev` / `funscript run`;
- no FunScript runtime dependency.

### 3.6 `funscript add` does not invent a registry

`funscript add effect` delegates to the project's package manager (npm, pnpm, or Bun) and
updates `package.json`/the lockfile normally. There is no FunScript package registry and no
new lockfile format. The ecosystem is npm; FunScript is a tool on top.

### 3.7 The editor is part of the toolchain

- `funscript lsp` starts a language server.
- It compiles on save, runs the TypeScript language service on the generated `.ts`, and
  maps diagnostics, hover, and completion positions back to `.fun`.
- The VS Code extension bundles the client and launches the server.
- Syntax highlighting is available immediately through a TextMate grammar.

The editor should show the same errors as `funscript check`, not a parallel universe.

---

## 4. Where the guardrails stop

A pit of success is not a prison. These are the deliberate exits:

| Exit                                | What it allows                                                         | How to audit             |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `_` match arm                       | opt out of exhaustiveness                                              | search for wildcard arms |
| raw TypeScript (backticks)          | anything TypeScript can do, including `new`, classes, `any`, `Promise` | search for backticks     |
| `entry` modules in `funscript.json` | `Effect.run*` / `ManagedRuntime` at a runtime boundary                 | review the `entry` list  |
| `Effect.die`                        | defects outside the typed error channel                                | search for `die`         |
| `Effect.tryPromise`                 | Promise interop at a boundary                                          | search for `tryPromise`  |
| `vite.config.ts`                    | custom build behavior                                                  | normal code review       |
| `tsconfig.json`                     | custom typechecking                                                    | normal code review       |
| `--no-check`                        | skip the type gate in an emergency                                     | CI should forbid it      |

The rule is not “never escape.” The rule is **escape visibly**. Every exit is syntax or
config a reviewer can search for.

Things FunScript does not protect against:

- logic errors (the code does the wrong thing correctly);
- bad types from npm packages;
- `any` that leaks through an external boundary;
- resource leaks inside an Effect that is never run;
- security bugs in dependencies;
- a deliberately wrong `_` arm.

The language can make the common path safe. It cannot make every path correct.

---

## 5. Review questions for every new feature

Before a feature lands, it should pass these questions:

1. **Does the obvious code do the safe thing?**
   If the safe version needs a comment, the feature is not finished.
2. **Is the failure compile-time?**
   Runtime checks are a fallback, not a design.
3. **Is the fix local?**
   A good error points at the line and suggests the edit.
4. **Is the escape hatch explicit?**
   Raw TS, `_`, `die`, the `entry` list — all visible, all greppable.
5. **Does it preserve Effect semantics?**
   No hidden `runSync`, no implicit `await`, no parallel error channel.
6. **Is the output readable?**
   If the emitted TypeScript is ugly, the feature is ugly.
7. **Does it add a second way to do the same thing?**
   One formatter, one build, one test command. Prefer removing a form over adding one.
8. **Does it keep Effect TS as the standard library?**
   No FunScript collections, no FunScript HTTP, no FunScript date library.
9. **Is the tooling included?**
   If it needs a new config file to work, it is not Go-like enough.
10. **Can it be formatted canonically?**
    If two teams would format it differently, the syntax is not settled.

---

## 6. The Go analogy

Go's pit of success is not only the language. It is `gofmt`, `go test`, `go build`,
`go vet`, and the standard project layout. The toolchain removes choices that do not
matter, so teams can spend their decisions on the problem.

FunScript borrows that posture:

| Go                       | FunScript                               |
| ------------------------ | --------------------------------------- |
| `gofmt`                  | `funscript fmt`                         |
| `go build`               | `funscript build` (Vite)                |
| `go test`                | `funscript test` (Vitest)               |
| `go vet`                 | `funscript check`                       |
| `go run`                 | `funscript run`                         |
| `go mod init` / `go get` | `funscript new` / `funscript add` (npm) |
| `gopls`                  | `funscript lsp`                         |
| one standard library     | **Effect TS**                           |
| one build tool           | **Vite**                                |
| one test runner          | **Vitest**                              |

The difference is the ecosystem. Go owns its runtime and standard library. FunScript owns
neither. It owns the notation and the integrated developer experience, and delegates the
rest to TypeScript, Vite, Vitest, Effect, and npm.

That is the trade: less control, much more ecosystem. The pit of success is built on
libraries that already have deep pits of their own.

---

## 7. One-sentence summary

FunScript is designed so that the shortest, most obvious way to write a program is also the
Effect-native way — one loop story, one function form, one object story per job, one
error model, one state model — and that it is exhaustive, typed, dependency-injected,
immutable, formatted, tested, buildable with Vite, and readable as TypeScript when you
walk away.
