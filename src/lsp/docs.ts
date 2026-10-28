/**
 * FunScript Language Documentation Catalog & Markdown Hover Generator
 */

export type DocCategory = "keyword" | "primitive" | "effect" | "operator" | "schema";

export interface DocItem {
  name: string;
  category: DocCategory;
  signature: string;
  summary: string;
  description: string;
  snippet: string;
  seeAlso?: string[];
  aliases?: string[];
}

type DocDef = [
  category: DocCategory,
  signature: string,
  summary: string,
  description: string,
  snippet: string,
  seeAlso?: string[],
  aliases?: string[],
];

const DOC_MAP: Record<string, DocDef> = {
  "service": ["keyword", "service ServiceName\n  methodName: (param: Type) -> Effect<Success, Error>", "Declares a dependency-injected service interface.", "Defines a service contract that compiles to an Effect `Context.Service` tag.\n\nCalls to service methods (such as `UserRepo.find(id)`) inside `effect` blocks automatically resolve the service from Context and track its dependency in the Effect `R` channel. Implementations are supplied at runtime via `Layer.succeed`, `Layer.effect`, or `Layer.scoped`.", "export service UserRepo\n  find: (id: string) -> Effect<User, NotFound>\n  save: (user: User) -> Effect<void>\n\nexport UserRepoLive =\n  Layer.succeed(UserRepo, {\n    find: (id) -> Effect.succeed({ id, name: \"Ada\" }),\n    save: (user) -> Effect.void,\n  })", ["Layer", "Context", "effect", "Effect"]],
  "record": ["keyword", "schema Name = { field: Type }\n# or expression:\n{ key: value, ...spread, path.nested: value }", "Declares an immutable record schema or constructs an immutable record.", "FunScript records are deeply immutable by default.\n\nRecord updates support shallow spread (`{ ...user, age: 37 }`) and deep nested dot-path updates (`{ ...order, shipping.carrier: \"DHL\" }`). Deep updates compile to Mutative's structural-sharing `create(...)` to guarantee both performance and purity without manual nested spreads.", "export schema User = {\n  id: string\n  name: string\n  address: { city: string, zip: string }\n}\n\nupdateCity = (user: User, newCity: string) ->\n  { ...user, address.city: newCity }", ["schema", "mut", "variant"]],
  "variant": ["keyword", "schema TypeName =\n  | VariantA(param: Type)\n  | VariantB", "Declares a tagged union variant constructor within a schema.", "Declares a variant case of a discriminated union algebraic data type.\n\nUnder the hood, variants compile to Effect `Data.TaggedEnum` and `Schema.Union`. Each variant can be instantiated directly as a constructor function (e.g. `Circle(10)`) or constant (`None`) and pattern-matched exhaustively with `match`.", "export schema Shape =\n  | Circle(radius: number)\n  | Rect(width: number, height: number)\n\narea = (s: Shape) ->\n  match s\n    | Circle(r) -> Math.PI * r * r\n    | Rect(w, h) -> w * h", ["schema", "match", "error"]],
  "effect": ["keyword", "effect\n  result <- effectfulCall\n  _ <- logCall\n  finalExpression", "Introduces an effectful computation block with generator semantics.", "Delimits an Effect workflow that compiles to `Effect.gen(function* () { ... })`.\n\nInside an `effect` block:\n- `result <- effect` binds the success value of an Effect (equivalent to `yield*`).\n- `_ <- effect` executes an Effect and discards its result.\n- Plain statements evaluate sequentially, and the block automatically returns its final expression.\n- Early exits or error handling use typed error combinators or `Effect.fail`.", "getUserProfile = (id: string) ->\n  effect\n    user <- UserRepo.find(id)\n    _ <- Console.log(\"Found: \" + user.name)\n    user.name", ["Effect", "service", "fail", "<-"]],
  "match": ["keyword", "match value\n  | Pattern1 -> result1\n  | Pattern2 when guard -> result2\n  | _ -> fallback", "Unified pattern matching and conditional branching construct.", "`match` is the sole branching construct in FunScript, replacing `if`, `else`, and `switch`.\n\nFeatures:\n- Exhaustive structural pattern matching on tagged variants, literals, records, and arrays (via `ts-pattern`).\n- Compile-time exhaustiveness checking when the wildcard `_` arm is omitted.\n- Subjectless boolean branching (`match | condition -> expr | _ -> default`).\n- Pattern guards via `when` and or-patterns via `| A | B ->`.", "describe = (shape: Shape) ->\n  match shape\n    | Circle(r) when r <= 0 -> \"Degenerate circle\"\n    | Circle(r) -> \"Circle with radius \" + r\n    | Rect(w, h) -> \"Rectangle of \" + w + \"x\" + h", ["variant", "when", "schema"]],
  "mut": ["keyword", "mut draft = initialValue\n# or in pipeline:\nvalue |> mut (draft) -> draft.field = newValue", "Declares a local mutable draft or mutable variable.", "FunScript bindings and data structures are immutable by default. The `mut` keyword enables explicit, controlled copy-on-write mutation backed by Mutative's `create(...)`.\n\nRules:\n- Local reassignments are only permitted on `mut` bindings.\n- Pipeline drafts (`|> mut (draft) -> ...`) create isolated draft scopes.\n- Top-level `mut` and closure-captured mutable mutation across fibers are prohibited.", "addItems = (list: Array<string>, item: string) ->\n  list |> mut (draft) ->\n    draft.push(item)", ["record", "|>"]],
  "fail": ["keyword", "Effect.fail(error: E): Effect<never, E, never>\n# in effect block:\n_ <- Effect.fail(ErrorType(reason))", "Constructs an Effect that fails with a recoverable typed error.", "FunScript eliminates unchecked exceptions, `throw`, and `try/catch`. All recoverable failures are modeled as typed values in the Effect `E` channel.\n\n`fail` (or `Effect.fail`) produces an Effect that terminates execution along the error channel. Callers must handle the typed error exhaustively using `match`, `Effect.catchTag`, or `Effect.catchAll`.", "findAccount = (id: string) ->\n  match db.lookup(id)\n    | Some(acc) -> Effect.succeed(acc)\n    | None -> Effect.fail(AccountNotFound(id))", ["effect", "error", "Effect.succeed", "Effect.catchTag"], ["Effect.fail"]],
  "schema": ["keyword", "schema Name = { field: Type }\n# or tagged union:\nschema Name = | CaseA | CaseB(v: Type)", "Unified declaration for record shapes, tagged unions, refinements, and type signatures.", "Declares data models backed by Effect's `@effect/schema` and `Data.TaggedEnum`.\n\nA single `schema` declaration generates both the runtime validator/constructor and the static TypeScript type definition, avoiding dual declaration boilerplate.", "export schema Order = {\n  id: string\n  total: number\n  items: Array<string>\n}", ["record", "variant", "error"]],
  "error": ["keyword", "error ErrorName(field: Type, ...)", "Declares a typed error schema backed by Schema.TaggedError.", "Defines a domain error with a discriminator `_tag` matching the error name.\n\nBecause errors are typed values rather than unchecked runtime exceptions, they appear explicitly in the `E` channel of `Effect<A, E, R>` and can be matched by tag.", "export error NotFound(id: string)\nexport error Unauthorized(reason: string)\n\nlookup = (id: string) ->\n  Effect.fail(NotFound(id))", ["fail", "schema", "Effect.catchTag"]],
  "import": ["keyword", "import { Name } from \"module\"", "Imports bindings, services, types, or schemas from another module.", "Standard ESM import statement in FunScript. Imports can load values, types, or services from neighboring `.fun` files or npm packages like `effect`.", "import { Effect, Console, pipe } from \"effect\"", ["export", "from"]],
  "export": ["keyword", "export declaration = ...\nexport schema Name = ...\nexport service Name ...", "Exports a binding, schema, error, or service from the module.", "Exposes module members to other files. All exports in FunScript are named exports; default exports are disallowed to keep naming consistent and refactorable.", "export greet = (name: string) -> \"Hello, \" + name\nexport schema User = { id: string, name: string }", ["import"]],
  "when": ["keyword", "| Pattern when condition -> result", "Pattern match guard condition within a match arm.", "Adds a boolean predicate to a `match` arm. The arm matches only if both the structural pattern matches and the `when` condition evaluates to `true`.", "categorizeAge = (age: number) ->\n  match age\n    | a when a < 13 -> \"child\"\n    | a when a < 20 -> \"teen\"\n    | _ -> \"adult\"", ["match"]],
  "and": ["keyword", "expr1 and expr2", "Logical short-circuit conjunction operator (&&).", "Evaluates to `true` if both operands are truthy. Short-circuits if the left operand is falsy. FunScript uses the English word `and` instead of `&&`.", "isValid = (n: number) ->\n  n >= 0 and n <= 100", ["or", "not"]],
  "or": ["keyword", "expr1 or expr2", "Logical short-circuit disjunction operator (||).", "Evaluates to `true` if either operand is truthy. Short-circuits if the left operand is truthy. FunScript uses the English word `or` instead of `||`.", "canProceed = (user: User) ->\n  user.isAdmin or user.isOwner", ["and", "not"]],
  "not": ["keyword", "not expression", "Logical negation operator (!).", "Inverts a boolean expression. Evaluates to `true` if the expression is falsy, and `false` otherwise. FunScript uses `not` instead of `!`.", "isEmpty = (list: Array<string>) ->\n  not (list.length > 0)", ["and", "or"]],
  "true": ["keyword", "true: boolean", "Boolean literal representing truth.", "The primitive boolean value representing true.", "isEnabled: boolean = true", ["false", "boolean"]],
  "false": ["keyword", "false: boolean", "Boolean literal representing falsehood.", "The primitive boolean value representing false.", "isDone: boolean = false", ["true", "boolean"]],
  "from": ["keyword", "import { X } from \"module\"", "Specifies the module source in import and export declarations.", "Specifies the source file path or npm package name for `import` and `export { ... } from` statements.", "import { Effect } from \"effect\"", ["import", "export"]],
  "js": ["keyword", "res <- js promiseFn()\nexport js fn = (...) -> ...\neff |> js", "JavaScript and npm interop keyword for seamless async interop.", "Lifts JS Promises into Effects inside effect blocks (`res <- js promiseFn()`), compiles exported functions to Promise-returning JS functions (`export js fn`), or pipes Effects to JS Promises (`eff |> js`).", "fetchData = (url: string) ->\n  effect\n    res <- js fetch(url)\n    data <- js res.json()\n    data", ["ts", "effect", "export"]],
  "ts": ["keyword", "schema Dict = ts \"Record<string, unknown>\"\ntype Position = ts \"import('vscode-languageserver').Position\"", "TypeScript type system escape hatch for complex types.", "Allows embedding arbitrary TypeScript types without expanding FunScript's core grammar. Useful for generics, utility types, and third-party library types.", "schema Options = {\n  metadata: ts \"Record<string, unknown>\"\n}", ["js", "schema"]],
  "string": ["primitive", "type string", "UTF-16 text string primitive type.", "Represents immutable textual data. FunScript strings support string interpolation via curly brace syntax `\"{status}: {message}\"` and multiline string literals.", "greeting: string = \"Hello, FunScript!\"", ["NonEmptyString", "number", "boolean"]],
  "number": ["primitive", "type number", "Double-precision IEEE 754 floating point and integer numeric primitive.", "Represents all numbers in FunScript, including floating-point values and integers. Can be refined to integers via `Int` schema.", "count: number = 42\nratio: number = 3.14159", ["Int", "string", "boolean"]],
  "boolean": ["primitive", "type boolean = true | false", "Primitive boolean logic type.", "Represents logical truth values (`true` or `false`).", "ready: boolean = true", ["true", "false", "and", "or", "not"]],
  "void": ["primitive", "type void", "Represents the absence of a meaningful return value.", "Used as the return type for side-effecting operations that do not produce a useful value, such as `Console.log` or mutating operations yielding `Effect<void>`.", "logInfo: (msg: string) -> Effect<void>", ["never", "unknown"]],
  "unknown": ["primitive", "type unknown", "The type-safe counterpart of any; represents an uninspected value.", "Top type representing values whose type is not statically known (e.g. from external API payloads). Must be narrowed via `Schema.decodeUnknown` or `match` before access.", "parsePayload = (raw: unknown) -> Schema.decodeUnknown(User)(raw)", ["never", "schema"]],
  "never": ["primitive", "type never", "The bottom type representing values that never occur.", "Uninhabited type used for functions that never return, effects that cannot fail (`Effect<A, never>`), or unreachable branches in exhaustive pattern matching.", "unreachable = (x: never): never -> x", ["unknown", "void"]],
  "Array": ["primitive", "type Array<T>", "Ordered sequence of elements of type T.", "Standard sequence collection. In FunScript, Arrays are deeply immutable unless operated on inside an explicit `mut` draft. Compatible with Effect's `Array` module combinators (`Array.map`, `Array.filter`).", "numbers: Array<number> = [1, 2, 3, 4, 5]", ["Chunk", "Record", "mut"]],
  "Record": ["primitive", "type Record<K extends string | number | symbol, V>", "Dictionary map of keys to values.", "Key-value dictionary mapping string keys to values of type `V`.", "scores: Record<string, number> = { alice: 100, bob: 95 }", ["HashMap", "record", "Array"]],
  "Option": ["primitive", "type Option<A> = Some<A> | None", "Data type modeling the presence or absence of a value.", "FunScript disallows `null` and `undefined`. Optional values are represented strictly with `Option<A>` from Effect, containing either `Some(value)` or `None`. Eliminates null pointer exceptions.", "findUser = (id: string): Option<User> ->\n  match id\n    | \"1\" -> Option.some({ id: \"1\", name: \"Ada\" })\n    | _ -> Option.none()", ["Some", "None", "Either"]],
  "Some": ["primitive", "Option.some<A>(value: A): Option<A>", "Constructs an Option containing a defined value.", "Represents the presence of a value in an `Option` container.", "hasName = Option.some(\"Ada\")", ["Option", "None"]],
  "None": ["primitive", "Option.none(): Option<never>", "Represents the absence of a value in an Option.", "Represents an empty `Option` container, replacing `null` and `undefined`.", "emptyVal = Option.none()", ["Option", "Some"]],
  "Either": ["primitive", "type Either<R, L> = Right<R> | Left<L>", "Disjoint union representing either a success (Right) or a failure (Left).", "Functional data structure representing values with two possibilities: `Left(error)` for failures or `Right(value)` for successful computations.", "divide = (a: number, b: number): Either<number, string> ->\n  match\n    | b == 0 -> Either.left(\"Division by zero\")\n    | _ -> Either.right(a / b)", ["Option", "Effect"]],
  "Ref": ["primitive", "type Ref<A>", "Fiber-safe concurrent mutable reference cell.", "Effect's primitive for shared, concurrent state across fibers. All read and write operations (`Ref.get`, `Ref.set`, `Ref.update`) return Effects, ensuring atomic and lock-free thread safety.", "counterRef <- Ref.make(0)\n_ <- Ref.update(counterRef, (n) -> n + 1)\ncurrent <- Ref.get(counterRef)", ["effect", "Effect"]],
  "Duration": ["primitive", "type Duration", "Representation of an elapsed time interval.", "Effect's type representing a time duration, constructed with `Duration.millis`, `Duration.seconds`, `Duration.minutes`, etc. Used for timeouts, delays, and scheduling.", "waitFiveSec = Effect.sleep(Duration.seconds(5))", ["Schedule", "DateTime"]],
  "DateTime": ["primitive", "type DateTime", "Immutable representation of an absolute point in time.", "Effect's modern date-time module replacing JavaScript's mutable `Date`.", "now <- DateTime.now", ["Duration"]],
  "Int": ["primitive", "schema Int = number |> Schema.int()", "Refinement schema constraining numbers to 32-bit integers.", "A refined numeric schema that validates numbers to be whole integers without fractional parts.", "schema Age = Int |> Schema.between(0, 120)", ["number", "schema"]],
  "UUID": ["primitive", "schema UUID = string |> Schema.UUID", "Refinement schema validating RFC 4122 compliant UUID strings.", "Validates and types canonical UUID strings (such as `123e4567-e89b-12d3-a456-426614174000`).", "userId: UUID = UUID(\"550e8400-e29b-41d4-a716-446655440000\")", ["string", "schema"]],
  "NonEmptyString": ["primitive", "schema NonEmptyString = string |> Schema.nonEmptyString()", "Refinement schema validating strings with length greater than zero.", "Guarantees at compile and run time that a string contains at least one character.", "schema Username = NonEmptyString", ["string", "schema"]],
  "Chunk": ["primitive", "type Chunk<A>", "High-performance, immutable indexed sequence from Effect.", "A fast, persistent sequential data structure with O(1) prepend, append, and slice operations, optimized for streaming and batch processing.", "items = Chunk.make(1, 2, 3)", ["Array"]],
  "HashMap": ["primitive", "type HashMap<K, V>", "Persistent immutable hash map data structure from Effect.", "Efficient immutable hash map with structural hashing and equality.", "map = HashMap.make([\"key\", 42])", ["Record", "HashSet"]],
  "HashSet": ["primitive", "type HashSet<A>", "Persistent immutable set data structure from Effect.", "Efficient immutable collection of unique elements with structural hashing and equality.", "set = HashSet.make(1, 2, 3)", ["HashMap"]],
  "Effect": ["effect", "type Effect<Success, Error = never, Requirements = never>", "Core Effect type representing a lazy, concurrent computation.", "The foundational abstraction in FunScript.\n\nAn `Effect<A, E, R>` represents a blueprint for a workflow that:\n- Requires an environment/context `R`\n- May fail with a typed error `E`\n- May succeed with a value `A`\n\nEffects are lazy, composable, cancellable, and fibers-based.", "type UserFlow = Effect<User, NotFound, UserRepo>", ["service", "effect", "Layer", "Context"]],
  "Effect.succeed": ["effect", "Effect.succeed<A>(value: A): Effect<A>", "Creates an Effect that succeeds immediately with the provided value.", "Wraps a pure value in an Effect that succeeds synchronously without errors or dependencies.", "pureValue = Effect.succeed(42)", ["Effect.fail", "Effect.sync"], ["succeed"]],
  "Effect.sync": ["effect", "Effect.sync<A>(evaluate: () -> A): Effect<A>", "Wraps a lazy, synchronous side effect into an Effect.", "Defers execution of a synchronous function until the Effect is run, capturing any uncaught throws as defects.", "randomNum = Effect.sync(-> Math.random())", ["Effect.succeed", "Effect.tryPromise"], ["sync"]],
  "Effect.tryPromise": ["effect", "Effect.tryPromise<A, E>(options: { try: () -> Promise<A>, catch: (err: unknown) -> E }): Effect<A, E>", "Bridges an asynchronous Promise-based API into a typed Effect.", "Safely converts external Promise calls into FunScript Effects. Catches Promise rejections and maps them into typed domain errors in the `E` channel.", "fetchData = (url: string) ->\n  Effect.tryPromise({\n    try: () -> fetch(url),\n    catch: (err) -> NetworkError(String(err)),\n  })", ["Effect", "effect"]],
  "Effect.map": ["effect", "Effect.map<A, B>(self: Effect<A, E, R>, f: (a: A) -> B): Effect<B, E, R>", "Transforms the success value of an Effect using a pure function.", "Applies the mapping function `f` to the successful result of `self` without altering errors or dependencies.", "lengthEffect =\n  Effect.succeed(\"hello\")\n  |> Effect.map((s) -> s.length)", ["Effect.flatMap", "Effect.andThen"], ["map"]],
  "Effect.flatMap": ["effect", "Effect.flatMap<A, B, E2, R2>(self: Effect<A, E, R>, f: (a: A) -> Effect<B, E2, R2>): Effect<B, E | E2, R | R2>", "Chains another Effectful computation onto the success of this Effect.", "Sequentially composes two Effectful actions where the second depends on the result of the first.", "step =\n  UserRepo.find(id)\n  |> Effect.flatMap((user) -> EmailService.sendWelcome(user))", ["Effect.map", "Effect.andThen"], ["flatMap"]],
  "Effect.andThen": ["effect", "Effect.andThen<A, B>(self: Effect<A, E, R>, next: Effect<B, E2, R2> | ((a: A) -> B)): Effect<...>", "Sequentially composes effects or functions.", "Versatile combinator that chains an Effect or a pure function after another Effect succeeds.", "action =\n  Effect.succeed(10)\n  |> Effect.andThen((n) -> n * 2)", ["Effect.map", "Effect.flatMap"], ["andThen"]],
  "Effect.catchAll": ["effect", "Effect.catchAll<A, E, R, B, E2, R2>(self: Effect<A, E, R>, handler: (err: E) -> Effect<B, E2, R2>): Effect<A | B, E2, R | R2>", "Recovers from any error in the Effect's error channel.", "Catches all typed errors in `E` and invokes a recovery function that returns an alternative Effect.", "safeQuery =\n  riskyQuery\n  |> Effect.catchAll((err) -> Effect.succeed(defaultFallback))", ["Effect.catchTag", "fail"], ["catchAll"]],
  "Effect.catchTag": ["effect", "Effect.catchTag(tag: string, handler: (err: Tagged) -> Effect<...>): Effect<...>", "Recovers from a specific tagged error matching _tag.", "Selectively catches errors matching a specific discriminant tag (from `error` schemas). Leaves all other errors intact in the `E` channel.", "workflow =\n  UserRepo.find(id)\n  |> Effect.catchTag(\"NotFound\", (_err) -> Effect.succeed(guestUser))", ["error", "Effect.catchAll"], ["catchTag"]],
  "Effect.all": ["effect", "Effect.all(effects: Array<Effect<...>>, options?: { concurrency?: number }): Effect<Array<...>>", "Executes multiple Effects concurrently or sequentially and combines results.", "Gathers multiple effects into a single Effect that collects all success values in an array or struct.", "combined <- Effect.all([\n  UserRepo.find(\"1\"),\n  OrderRepo.find(\"100\"),\n], { concurrency: \"unbounded\" })", ["Effect.forEach"], ["all"]],
  "Effect.forEach": ["effect", "Effect.forEach(elements: Iterable<A>, f: (a: A) -> Effect<B, E, R>, options?: { concurrency?: number }): Effect<Array<B>, E, R>", "Iterates over an iterable, applying an effectful function to each element.", "Replaces imperative loops for effectful iteration. Can run sequentially or concurrently using the `concurrency` option.", "results <- Effect.forEach(userIds, (id) -> UserRepo.find(id), {\n  concurrency: 5,\n})", ["Effect.all"], ["forEach"]],
  "Effect.die": ["effect", "Effect.die(defect: unknown): Effect<never>", "Halts fiber execution immediately with an unrecoverable defect.", "Terminates the current fiber with an uncatchable defect (system bug or assertion failure).", "Effect.die(new Error(\"Fatal database corruption\"))", ["Effect.orDie", "fail"], ["die"]],
  "Effect.orDie": ["effect", "Effect.orDie<A, E, R>(self: Effect<A, E, R>): Effect<A, never, R>", "Demotes all typed errors in E into fatal defects.", "Converts recoverable errors in the `E` channel into defects, asserting that the operation cannot fail.", "safeVal = riskyOp |> Effect.orDie", ["Effect.die"], ["orDie"]],
  "Effect.retry": ["effect", "Effect.retry(policy: Schedule): Effect<...>", "Retries a failing Effect according to a Schedule policy.", "Automatically re-executes an Effect upon failure until the schedule policy dictates termination.", "fetchWithRetry =\n  apiCall\n  |> Effect.retry(Schedule.exponential(Duration.millis(100)))", ["Schedule", "Effect.repeat"], ["retry"]],
  "Effect.repeat": ["effect", "Effect.repeat(policy: Schedule): Effect<...>", "Repeats a successful Effect according to a Schedule policy.", "Repeatedly executes an Effect as long as the Schedule allows.", "pollStatus = checkHealth |> Effect.repeat(Schedule.spaced(Duration.seconds(10)))", ["Schedule", "Effect.retry"], ["repeat"]],
  "Effect.timeout": ["effect", "Effect.timeout(duration: Duration): Effect<Option<A>>", "Enforces a maximum execution time on an Effect.", "Aborts the Effect if it does not finish within the specified duration.", "safeFetch = slowRequest |> Effect.timeout(Duration.seconds(3))", ["Duration"], ["timeout"]],
  "Effect.fork": ["effect", "Effect.fork<A, E>(self: Effect<A, E, R>): Effect<Fiber<A, E>, never, R>", "Spawns an Effect onto a new concurrent background fiber.", "Starts background execution of an Effect in an isolated green fiber.", "fiber <- Effect.fork(backgroundTask)", ["Effect.forkScoped"], ["fork"]],
  "Effect.forkScoped": ["effect", "Effect.forkScoped<A, E>(self: Effect<A, E, R>): Effect<Fiber<A, E>, never, R | Scope>", "Forks a fiber bound to the current Scope's lifetime.", "Spawns a fiber that is automatically interrupted and cleaned up when the enclosing Scope closes.", "scopedFiber <- Effect.forkScoped(longLivedService)", ["Effect.fork", "Effect.scoped"], ["forkScoped"]],
  "Effect.scoped": ["effect", "Effect.scoped<A, E, R>(self: Effect<A, E, R | Scope>): Effect<A, E, R>", "Provides a new Scope to an Effect and closes it upon completion.", "Creates an execution boundary for resources requiring deterministic cleanup (like files or sockets).", "Effect.scoped(useTemporaryResource)", ["Effect.forkScoped", "Layer.scoped"], ["scoped"]],
  "Effect.runPromise": ["effect", "Effect.runPromise<A, E>(effect: Effect<A, E, never>): Promise<A>", "Runs an Effect at the application boundary, returning a Promise.", "Evaluates the Effect workflow to completion and resolves the resulting Promise with the success value. Only permitted in application entrypoints (`main`).", "Effect.runPromise(mainProgram)", ["Effect.runSync"], ["runPromise"]],
  "Effect.runSync": ["effect", "Effect.runSync<A>(effect: Effect<A, never, never>): A", "Synchronously executes an Effect that cannot fail and has no requirements.", "Executes an Effect synchronously. Throws if the Effect contains asynchronous fibers or unresolved failures.", "result = Effect.runSync(pureCalculation)", ["Effect.runPromise"], ["runSync"]],
  "Layer": ["effect", "type Layer<Out, Error = never, In = never>", "Recipes for constructing, composing, and providing services.", "A `Layer<Out, E, In>` specifies how to construct services `Out` given dependencies `In`. Layers enable modular dependency injection, memoization, parallel construction, and resource management.", "export AppLive =\n  UserRepoLive\n  |> Layer.provide(DatabaseLive)", ["service", "Layer.succeed", "Layer.effect"]],
  "Layer.succeed": ["effect", "Layer.succeed<T>(tag: Service<T>, implementation: T): Layer<T>", "Builds a Layer that provides a service with a static implementation.", "Supplies a pre-constructed service implementation directly without asynchronous setup.", "export GreeterLive =\n  Layer.succeed(Greeter, {\n    greet: (name) -> Effect.succeed(\"Hello \" + name),\n  })", ["Layer", "Layer.effect", "service"]],
  "Layer.effect": ["effect", "Layer.effect<T, E, R>(tag: Service<T>, build: Effect<T, E, R>): Layer<T, E, R>", "Builds a Layer that constructs a service via an Effect.", "Allows effectful setup (e.g. connecting to a database, reading config) when instantiating a service.", "export DbLive =\n  Layer.effect(Database, effect\n    conn <- createConnection()\n    { query: (sql) -> conn.execute(sql) }\n  )", ["Layer", "Layer.succeed", "service"]],
  "Layer.scoped": ["effect", "Layer.scoped<T, E, R>(tag: Service<T>, build: Effect<T, E, R | Scope>): Layer<T, E, R>", "Builds a Layer with managed lifecycle and resource cleanup.", "Binds the constructed service to a Scope. The service will be automatically torn down when the layer is released.", "Layer.scoped(ConnectionPool, acquirePool)", ["Layer", "Effect.scoped"]],
  "Context": ["effect", "type Context<Services>", "Type-safe environment container for service tags and instances.", "Represents the dependency environment `R` in `Effect<A, E, R>`.", "context = Context.empty()", ["service", "Layer"]],
  "Schedule": ["effect", "type Schedule<Env, In, Out>", "Recurrence policy defining repetition and retry behavior.", "Configures delays, intervals, exponential backoffs, and iteration bounds for `retry` and `repeat`.", "policy = Schedule.exponential(Duration.millis(100)) |> Schedule.compose(Schedule.recurs(5))", ["Effect.retry", "Effect.repeat", "Duration"]],
  "pipe": ["effect", "pipe(value, f1, f2, ...): Result", "Chains values through functions from left to right.", "Utility function for data-first function composition. In FunScript, the `|>` pipeline operator is preferred syntax and compiles down to `pipe` calls.", "res = pipe(\n  5,\n  (n) -> n * 2,\n  (n) -> n + 1\n)", ["|>"]],
  "|>": ["operator", "expression |> function(args...)", "Pipeline composition operator.", "Passes the value of the left expression as the first argument (or into placeholder `_`) of the right expression. Compiles to `pipe(...)` or direct function invocation.", "formatted =\n  data\n  |> Array.filter((x) -> x > 0)\n  |> Array.map((x) -> x * 2)", ["pipe"]],
  "<-": ["operator", "binding <- effectExpression", "Effect bind operator inside effect blocks.", "Extracts the success value from an Effect within an `effect` block, short-circuiting on failure. Desugars to `yield*` in `Effect.gen`.", "effect\n  user <- UserRepo.find(id)\n  user.name", ["effect", "Effect"]],
  "->": ["operator", "(param: Type) -> body", "Function and lambda declaration arrow.", "Declares pure functions and lambdas in FunScript. FunScript functions automatically return their last evaluated expression without needing a `return` keyword.", "add = (a: number, b: number): number -> a + b", ["effect"]],
  "???": ["operator", "??? [optionalMessage]", "Typed hole placeholder for incomplete code.", "A hole placeholder that satisfies any type at compile time but raises a diagnostic or throws an uncatchable defect at runtime if reached. Ideal for rapid prototyping.", "todoImplementation = (input: string): Result -> ??? \"implement parser\"", ["never"]],
};

export const DOC_CATALOG: Record<string, DocItem> = {};

for (const [name, [category, signature, summary, description, snippet, seeAlso, aliases]] of Object.entries(DOC_MAP)) {
  DOC_CATALOG[name] = {
    name,
    category,
    signature,
    summary,
    description,
    snippet,
    ...(seeAlso ? { seeAlso } : {}),
    ...(aliases ? { aliases } : {}),
  };
}

/**
 * Formats a DocItem into a standardized Markdown string for LSP Hover responses.
 */
export function formatDocToMarkdown(item: DocItem): string {
  const parts: string[] = [];
  parts.push("```funscript\n" + item.signature + "\n```");
  parts.push("***");
  parts.push(`**${item.name}** (\`${item.category}\`) — ${item.summary}`);
  if (item.description) parts.push(item.description);
  if (item.snippet) parts.push("### Example\n```funscript\n" + item.snippet + "\n```");
  if (item.seeAlso && item.seeAlso.length > 0) {
    parts.push(`**See also:** ${item.seeAlso.map((s) => "`" + s + "`").join(", ")}`);
  }
  return parts.join("\n\n");
}

const EXACT_MAP = new Map<string, DocItem>();
const LOWER_MAP = new Map<string, DocItem>();

for (const [key, item] of Object.entries(DOC_CATALOG)) {
  EXACT_MAP.set(key, item);
  const lower = key.toLowerCase();
  if (!LOWER_MAP.has(lower) || key === lower) {
    LOWER_MAP.set(lower, item);
  }
  if (item.aliases) {
    for (const alias of item.aliases) {
      EXACT_MAP.set(alias, item);
      const aliasLower = alias.toLowerCase();
      if (!LOWER_MAP.has(aliasLower) || alias === aliasLower) {
        LOWER_MAP.set(aliasLower, item);
      }
    }
  }
}

export function getDocItem(keyword: string): DocItem | null {
  if (!keyword || typeof keyword !== "string") return null;
  const trimmed = keyword.trim();
  if (trimmed.length === 0) return null;

  if (EXACT_MAP.has(trimmed)) return EXACT_MAP.get(trimmed)!;
  const lower = trimmed.toLowerCase();
  if (LOWER_MAP.has(lower)) return LOWER_MAP.get(lower)!;
  if (!trimmed.startsWith("Effect.") && EXACT_MAP.has("Effect." + trimmed)) {
    return EXACT_MAP.get("Effect." + trimmed)!;
  }
  if (!lower.startsWith("effect.") && LOWER_MAP.has("effect." + lower)) {
    return LOWER_MAP.get("effect." + lower)!;
  }
  return null;
}

export function getHoverDocumentation(keyword: string): string | null {
  const item = getDocItem(keyword);
  return item ? formatDocToMarkdown(item) : null;
}

export function getAllDocKeywords(): string[] {
  return Object.keys(DOC_CATALOG);
}
