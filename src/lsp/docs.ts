/**
 * FunScript Language Documentation Database & Markdown Hover Generator
 *
 * Provides structured documentation, type/syntax signatures, descriptions,
 * and code snippets for FunScript keywords, built-in types, and Effect operators.
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

export const DOC_CATALOG: Record<string, DocItem> = {
  // ==========================================
  // FunScript Keywords
  // ==========================================
  service: {
    name: "service",
    category: "keyword",
    signature: "service ServiceName\n  methodName: (param: Type) -> Effect<Success, Error>",
    summary: "Declares a dependency-injected service interface.",
    description:
      "Defines a service contract that compiles to an Effect `Context.Service` tag.\n\n" +
      "Calls to service methods (such as `UserRepo.find(id)`) inside `effect` blocks automatically " +
      "resolve the service from Context and track its dependency in the Effect `R` channel. " +
      "Implementations are supplied at runtime via `Layer.succeed`, `Layer.effect`, or `Layer.scoped`.",
    snippet:
      "export service UserRepo\n" +
      "  find: (id: string) -> Effect<User, NotFound>\n" +
      "  save: (user: User) -> Effect<void>\n\n" +
      "export UserRepoLive =\n" +
      "  Layer.succeed(UserRepo, {\n" +
      "    find: (id) -> Effect.succeed({ id, name: \"Ada\" }),\n" +
      "    save: (user) -> Effect.void,\n" +
      "  })",
    seeAlso: ["Layer", "Context", "effect", "Effect"],
  },

  record: {
    name: "record",
    category: "keyword",
    signature: "schema Name = { field: Type }\n# or expression:\n{ key: value, ...spread, path.nested: value }",
    summary: "Declares an immutable record schema or constructs an immutable record.",
    description:
      "FunScript records are deeply immutable by default.\n\n" +
      "Record updates support shallow spread (`{ ...user, age: 37 }`) and deep nested dot-path updates " +
      "(`{ ...order, shipping.carrier: \"DHL\" }`). Deep updates compile to Mutative's structural-sharing " +
      "`create(...)` to guarantee both performance and purity without manual nested spreads.",
    snippet:
      "export schema User = {\n" +
      "  id: string\n" +
      "  name: string\n" +
      "  address: { city: string, zip: string }\n" +
      "}\n\n" +
      "updateCity = (user: User, newCity: string) ->\n" +
      "  { ...user, address.city: newCity }",
    seeAlso: ["schema", "mut", "variant"],
  },

  variant: {
    name: "variant",
    category: "keyword",
    signature: "schema TypeName =\n  | VariantA(param: Type)\n  | VariantB",
    summary: "Declares a tagged union variant constructor within a schema.",
    description:
      "Declares a variant case of a discriminated union algebraic data type.\n\n" +
      "Under the hood, variants compile to Effect `Data.TaggedEnum` and `Schema.Union`. " +
      "Each variant can be instantiated directly as a constructor function (e.g. `Circle(10)`) " +
      "or constant (`None`) and pattern-matched exhaustively with `match`.",
    snippet:
      "export schema Shape =\n" +
      "  | Circle(radius: number)\n" +
      "  | Rect(width: number, height: number)\n\n" +
      "area = (s: Shape) ->\n" +
      "  match s\n" +
      "    | Circle(r) -> Math.PI * r * r\n" +
      "    | Rect(w, h) -> w * h",
    seeAlso: ["schema", "match", "error"],
  },

  effect: {
    name: "effect",
    category: "keyword",
    signature: "effect\n  result <- effectfulCall\n  _ <- logCall\n  finalExpression",
    summary: "Introduces an effectful computation block with generator semantics.",
    description:
      "Delimits an Effect workflow that compiles to `Effect.gen(function* () { ... })`.\n\n" +
      "Inside an `effect` block:\n" +
      "- `result <- effect` binds the success value of an Effect (equivalent to `yield*`).\n" +
      "- `_ <- effect` executes an Effect and discards its result.\n" +
      "- Plain statements evaluate sequentially, and the block automatically returns its final expression.\n" +
      "- Early exits or error handling use typed error combinators or `Effect.fail`.",
    snippet:
      "getUserProfile = (id: string) ->\n" +
      "  effect\n" +
      "    user <- UserRepo.find(id)\n" +
      "    _ <- Console.log(\"Found: \" + user.name)\n" +
      "    user.name",
    seeAlso: ["Effect", "service", "fail", "<-"],
  },

  match: {
    name: "match",
    category: "keyword",
    signature: "match value\n  | Pattern1 -> result1\n  | Pattern2 when guard -> result2\n  | _ -> fallback",
    summary: "Unified pattern matching and conditional branching construct.",
    description:
      "`match` is the sole branching construct in FunScript, replacing `if`, `else`, and `switch`.\n\n" +
      "Features:\n" +
      "- Exhaustive structural pattern matching on tagged variants, literals, records, and arrays (via `ts-pattern`).\n" +
      "- Compile-time exhaustiveness checking when the wildcard `_` arm is omitted.\n" +
      "- Subjectless boolean branching (`match | condition -> expr | _ -> default`).\n" +
      "- Pattern guards via `when` and or-patterns via `| A | B ->`.",
    snippet:
      "describe = (shape: Shape) ->\n" +
      "  match shape\n" +
      "    | Circle(r) when r <= 0 -> \"Degenerate circle\"\n" +
      "    | Circle(r) -> \"Circle with radius \" + r\n" +
      "    | Rect(w, h) -> \"Rectangle of \" + w + \"x\" + h",
    seeAlso: ["variant", "when", "schema"],
  },

  mut: {
    name: "mut",
    category: "keyword",
    signature: "mut draft = initialValue\n# or in pipeline:\nvalue |> mut (draft) -> draft.field = newValue",
    summary: "Declares a local mutable draft or mutable variable.",
    description:
      "FunScript bindings and data structures are immutable by default. The `mut` keyword enables " +
      "explicit, controlled copy-on-write mutation backed by Mutative's `create(...)`.\n\n" +
      "Rules:\n" +
      "- Local reassignments are only permitted on `mut` bindings.\n" +
      "- Pipeline drafts (`|> mut (draft) -> ...`) create isolated draft scopes.\n" +
      "- Top-level `mut` and closure-captured mutable mutation across fibers are prohibited.",
    snippet:
      "addItems = (list: Array<string>, item: string) ->\n" +
      "  list |> mut (draft) ->\n" +
      "    draft.push(item)",
    seeAlso: ["record", "|>"],
  },

  fail: {
    name: "fail",
    category: "keyword",
    signature: "Effect.fail(error: E): Effect<never, E, never>\n# in effect block:\n_ <- Effect.fail(ErrorType(reason))",
    summary: "Constructs an Effect that fails with a recoverable typed error.",
    description:
      "FunScript eliminates unchecked exceptions, `throw`, and `try/catch`. All recoverable failures " +
      "are modeled as typed values in the Effect `E` channel.\n\n" +
      "`fail` (or `Effect.fail`) produces an Effect that terminates execution along the error channel. " +
      "Callers must handle the typed error exhaustively using `match`, `Effect.catchTag`, or `Effect.catchAll`.",
    snippet:
      "findAccount = (id: string) ->\n" +
      "  match db.lookup(id)\n" +
      "    | Some(acc) -> Effect.succeed(acc)\n" +
      "    | None -> Effect.fail(AccountNotFound(id))",
    seeAlso: ["effect", "error", "Effect.succeed", "Effect.catchTag"],
    aliases: ["Effect.fail"],
  },

  schema: {
    name: "schema",
    category: "keyword",
    signature: "schema Name = { field: Type }\n# or tagged union:\nschema Name = | CaseA | CaseB(v: Type)",
    summary: "Unified declaration for record shapes, tagged unions, refinements, and type signatures.",
    description:
      "Declares data models backed by Effect's `@effect/schema` and `Data.TaggedEnum`.\n\n" +
      "A single `schema` declaration generates both the runtime validator/constructor and the " +
      "static TypeScript type definition, avoiding dual declaration boilerplate.",
    snippet:
      "export schema Order = {\n" +
      "  id: string\n" +
      "  total: number\n" +
      "  items: Array<string>\n" +
      "}",
    seeAlso: ["record", "variant", "error"],
  },

  error: {
    name: "error",
    category: "keyword",
    signature: "error ErrorName(field: Type, ...)",
    summary: "Declares a typed error schema backed by Schema.TaggedError.",
    description:
      "Defines a domain error with a discriminator `_tag` matching the error name.\n\n" +
      "Because errors are typed values rather than unchecked runtime exceptions, they appear " +
      "explicitly in the `E` channel of `Effect<A, E, R>` and can be matched by tag.",
    snippet:
      "export error NotFound(id: string)\n" +
      "export error Unauthorized(reason: string)\n\n" +
      "lookup = (id: string) ->\n" +
      "  Effect.fail(NotFound(id))",
    seeAlso: ["fail", "schema", "Effect.catchTag"],
  },

  import: {
    name: "import",
    category: "keyword",
    signature: "import { Name } from \"module\"",
    summary: "Imports bindings, services, types, or schemas from another module.",
    description:
      "Standard ESM import statement in FunScript. Imports can load values, types, or services " +
      "from neighboring `.fun` files or npm packages like `effect`.",
    snippet: "import { Effect, Console, pipe } from \"effect\"",
    seeAlso: ["export", "from"],
  },

  export: {
    name: "export",
    category: "keyword",
    signature: "export declaration = ...\nexport schema Name = ...\nexport service Name ...",
    summary: "Exports a binding, schema, error, or service from the module.",
    description:
      "Exposes module members to other files. All exports in FunScript are named exports; " +
      "default exports are disallowed to keep naming consistent and refactorable.",
    snippet:
      "export greet = (name: string) -> \"Hello, \" + name\n" +
      "export schema User = { id: string, name: string }",
    seeAlso: ["import"],
  },

  when: {
    name: "when",
    category: "keyword",
    signature: "| Pattern when condition -> result",
    summary: "Pattern match guard condition within a match arm.",
    description:
      "Adds a boolean predicate to a `match` arm. The arm matches only if both the structural " +
      "pattern matches and the `when` condition evaluates to `true`.",
    snippet:
      "categorizeAge = (age: number) ->\n" +
      "  match age\n" +
      "    | a when a < 13 -> \"child\"\n" +
      "    | a when a < 20 -> \"teen\"\n" +
      "    | _ -> \"adult\"",
    seeAlso: ["match"],
  },

  and: {
    name: "and",
    category: "keyword",
    signature: "expr1 and expr2",
    summary: "Logical short-circuit conjunction operator (&&).",
    description:
      "Evaluates to `true` if both operands are truthy. Short-circuits if the left operand is falsy. " +
      "FunScript uses the English word `and` instead of `&&`.",
    snippet:
      "isValid = (n: number) ->\n" +
      "  n >= 0 and n <= 100",
    seeAlso: ["or", "not"],
  },

  or: {
    name: "or",
    category: "keyword",
    signature: "expr1 or expr2",
    summary: "Logical short-circuit disjunction operator (||).",
    description:
      "Evaluates to `true` if either operand is truthy. Short-circuits if the left operand is truthy. " +
      "FunScript uses the English word `or` instead of `||`.",
    snippet:
      "canProceed = (user: User) ->\n" +
      "  user.isAdmin or user.isOwner",
    seeAlso: ["and", "not"],
  },

  not: {
    name: "not",
    category: "keyword",
    signature: "not expression",
    summary: "Logical negation operator (!).",
    description:
      "Inverts a boolean expression. Evaluates to `true` if the expression is falsy, and `false` otherwise. " +
      "FunScript uses `not` instead of `!`.",
    snippet:
      "isEmpty = (list: Array<string>) ->\n" +
      "  not (list.length > 0)",
    seeAlso: ["and", "or"],
  },

  true: {
    name: "true",
    category: "keyword",
    signature: "true: boolean",
    summary: "Boolean literal representing truth.",
    description: "The primitive boolean value representing true.",
    snippet: "isEnabled: boolean = true",
    seeAlso: ["false", "boolean"],
  },

  false: {
    name: "false",
    category: "keyword",
    signature: "false: boolean",
    summary: "Boolean literal representing falsehood.",
    description: "The primitive boolean value representing false.",
    snippet: "isDone: boolean = false",
    seeAlso: ["true", "boolean"],
  },

  from: {
    name: "from",
    category: "keyword",
    signature: "import { X } from \"module\"",
    summary: "Specifies the module source in import and export declarations.",
    description: "Specifies the source file path or npm package name for `import` and `export { ... } from` statements.",
    snippet: "import { Effect } from \"effect\"",
    seeAlso: ["import", "export"],
  },

  js: {
    name: "js",
    category: "keyword",
    signature: "res <- js promiseFn()\nexport js fn = (...) -> ...\neff |> js",
    summary: "JavaScript and npm interop keyword for seamless async interop.",
    description:
      "Lifts JS Promises into Effects inside effect blocks (`res <- js promiseFn()`), " +
      "compiles exported functions to Promise-returning JS functions (`export js fn`), " +
      "or pipes Effects to JS Promises (`eff |> js`).",
    snippet:
      "fetchData = (url: string) ->\n" +
      "  effect\n" +
      "    res <- js fetch(url)\n" +
      "    data <- js res.json()\n" +
      "    data",
    seeAlso: ["ts", "effect", "export"],
  },

  ts: {
    name: "ts",
    category: "keyword",
    signature: "schema Dict = ts \"Record<string, unknown>\"\ntype Position = ts \"import('vscode-languageserver').Position\"",
    summary: "TypeScript type system escape hatch for complex types.",
    description:
      "Allows embedding arbitrary TypeScript types without expanding FunScript's core grammar. " +
      "Useful for generics, utility types, and third-party library types.",
    snippet:
      "schema Options = {\n" +
      "  metadata: ts \"Record<string, unknown>\"\n" +
      "}",
    seeAlso: ["js", "schema"],
  },

  // ==========================================
  // Standard Primitives & Built-in Types
  // ==========================================
  string: {
    name: "string",
    category: "primitive",
    signature: "type string",
    summary: "UTF-16 text string primitive type.",
    description:
      "Represents immutable textual data. FunScript strings support string interpolation via " +
      "curly brace syntax `\"{status}: {message}\"` and multiline string literals.",
    snippet: "greeting: string = \"Hello, FunScript!\"",
    seeAlso: ["NonEmptyString", "number", "boolean"],
  },

  number: {
    name: "number",
    category: "primitive",
    signature: "type number",
    summary: "Double-precision IEEE 754 floating point and integer numeric primitive.",
    description:
      "Represents all numbers in FunScript, including floating-point values and integers. " +
      "Can be refined to integers via `Int` schema.",
    snippet: "count: number = 42\nratio: number = 3.14159",
    seeAlso: ["Int", "string", "boolean"],
  },

  boolean: {
    name: "boolean",
    category: "primitive",
    signature: "type boolean = true | false",
    summary: "Primitive boolean logic type.",
    description: "Represents logical truth values (`true` or `false`).",
    snippet: "ready: boolean = true",
    seeAlso: ["true", "false", "and", "or", "not"],
  },

  void: {
    name: "void",
    category: "primitive",
    signature: "type void",
    summary: "Represents the absence of a meaningful return value.",
    description:
      "Used as the return type for side-effecting operations that do not produce a useful value, " +
      "such as `Console.log` or mutating operations yielding `Effect<void>`.",
    snippet: "logInfo: (msg: string) -> Effect<void>",
    seeAlso: ["never", "unknown"],
  },

  unknown: {
    name: "unknown",
    category: "primitive",
    signature: "type unknown",
    summary: "The type-safe counterpart of any; represents an uninspected value.",
    description:
      "Top type representing values whose type is not statically known (e.g. from external API payloads). " +
      "Must be narrowed via `Schema.decodeUnknown` or `match` before access.",
    snippet: "parsePayload = (raw: unknown) -> Schema.decodeUnknown(User)(raw)",
    seeAlso: ["never", "schema"],
  },

  never: {
    name: "never",
    category: "primitive",
    signature: "type never",
    summary: "The bottom type representing values that never occur.",
    description:
      "Uninhabited type used for functions that never return, effects that cannot fail (`Effect<A, never>`), " +
      "or unreachable branches in exhaustive pattern matching.",
    snippet: "unreachable = (x: never): never -> x",
    seeAlso: ["unknown", "void"],
  },

  Array: {
    name: "Array",
    category: "primitive",
    signature: "type Array<T>",
    summary: "Ordered sequence of elements of type T.",
    description:
      "Standard sequence collection. In FunScript, Arrays are deeply immutable unless operated on " +
      "inside an explicit `mut` draft. Compatible with Effect's `Array` module combinators (`Array.map`, `Array.filter`).",
    snippet: "numbers: Array<number> = [1, 2, 3, 4, 5]",
    seeAlso: ["Chunk", "Record", "mut"],
  },

  Record: {
    name: "Record",
    category: "primitive",
    signature: "type Record<K extends string | number | symbol, V>",
    summary: "Dictionary map of keys to values.",
    description: "Key-value dictionary mapping string keys to values of type `V`.",
    snippet: "scores: Record<string, number> = { alice: 100, bob: 95 }",
    seeAlso: ["HashMap", "record", "Array"],
  },

  Option: {
    name: "Option",
    category: "primitive",
    signature: "type Option<A> = Some<A> | None",
    summary: "Data type modeling the presence or absence of a value.",
    description:
      "FunScript disallows `null` and `undefined`. Optional values are represented strictly with `Option<A>` " +
      "from Effect, containing either `Some(value)` or `None`. Eliminates null pointer exceptions.",
    snippet:
      "findUser = (id: string): Option<User> ->\n" +
      "  match id\n" +
      "    | \"1\" -> Option.some({ id: \"1\", name: \"Ada\" })\n" +
      "    | _ -> Option.none()",
    seeAlso: ["Some", "None", "Either"],
  },

  Some: {
    name: "Some",
    category: "primitive",
    signature: "Option.some<A>(value: A): Option<A>",
    summary: "Constructs an Option containing a defined value.",
    description: "Represents the presence of a value in an `Option` container.",
    snippet: "hasName = Option.some(\"Ada\")",
    seeAlso: ["Option", "None"],
  },

  None: {
    name: "None",
    category: "primitive",
    signature: "Option.none(): Option<never>",
    summary: "Represents the absence of a value in an Option.",
    description: "Represents an empty `Option` container, replacing `null` and `undefined`.",
    snippet: "emptyVal = Option.none()",
    seeAlso: ["Option", "Some"],
  },

  Either: {
    name: "Either",
    category: "primitive",
    signature: "type Either<R, L> = Right<R> | Left<L>",
    summary: "Disjoint union representing either a success (Right) or a failure (Left).",
    description:
      "Functional data structure representing values with two possibilities: `Left(error)` for failures " +
      "or `Right(value)` for successful computations.",
    snippet:
      "divide = (a: number, b: number): Either<number, string> ->\n" +
      "  match\n" +
      "    | b == 0 -> Either.left(\"Division by zero\")\n" +
      "    | _ -> Either.right(a / b)",
    seeAlso: ["Option", "Effect"],
  },

  Ref: {
    name: "Ref",
    category: "primitive",
    signature: "type Ref<A>",
    summary: "Fiber-safe concurrent mutable reference cell.",
    description:
      "Effect's primitive for shared, concurrent state across fibers. All read and write operations " +
      "(`Ref.get`, `Ref.set`, `Ref.update`) return Effects, ensuring atomic and lock-free thread safety.",
    snippet:
      "counterRef <- Ref.make(0)\n" +
      "_ <- Ref.update(counterRef, (n) -> n + 1)\n" +
      "current <- Ref.get(counterRef)",
    seeAlso: ["effect", "Effect"],
  },

  Duration: {
    name: "Duration",
    category: "primitive",
    signature: "type Duration",
    summary: "Representation of an elapsed time interval.",
    description:
      "Effect's type representing a time duration, constructed with `Duration.millis`, " +
      "`Duration.seconds`, `Duration.minutes`, etc. Used for timeouts, delays, and scheduling.",
    snippet: "waitFiveSec = Effect.sleep(Duration.seconds(5))",
    seeAlso: ["Schedule", "DateTime"],
  },

  DateTime: {
    name: "DateTime",
    category: "primitive",
    signature: "type DateTime",
    summary: "Immutable representation of an absolute point in time.",
    description: "Effect's modern date-time module replacing JavaScript's mutable `Date`.",
    snippet: "now <- DateTime.now",
    seeAlso: ["Duration"],
  },

  Int: {
    name: "Int",
    category: "primitive",
    signature: "schema Int = number |> Schema.int()",
    summary: "Refinement schema constraining numbers to 32-bit integers.",
    description: "A refined numeric schema that validates numbers to be whole integers without fractional parts.",
    snippet: "schema Age = Int |> Schema.between(0, 120)",
    seeAlso: ["number", "schema"],
  },

  UUID: {
    name: "UUID",
    category: "primitive",
    signature: "schema UUID = string |> Schema.UUID",
    summary: "Refinement schema validating RFC 4122 compliant UUID strings.",
    description: "Validates and types canonical UUID strings (such as `123e4567-e89b-12d3-a456-426614174000`).",
    snippet: "userId: UUID = UUID(\"550e8400-e29b-41d4-a716-446655440000\")",
    seeAlso: ["string", "schema"],
  },

  NonEmptyString: {
    name: "NonEmptyString",
    category: "primitive",
    signature: "schema NonEmptyString = string |> Schema.nonEmptyString()",
    summary: "Refinement schema validating strings with length greater than zero.",
    description: "Guarantees at compile and run time that a string contains at least one character.",
    snippet: "schema Username = NonEmptyString",
    seeAlso: ["string", "schema"],
  },

  Chunk: {
    name: "Chunk",
    category: "primitive",
    signature: "type Chunk<A>",
    summary: "High-performance, immutable indexed sequence from Effect.",
    description:
      "A fast, persistent sequential data structure with O(1) prepend, append, and slice operations, " +
      "optimized for streaming and batch processing.",
    snippet: "items = Chunk.make(1, 2, 3)",
    seeAlso: ["Array"],
  },

  HashMap: {
    name: "HashMap",
    category: "primitive",
    signature: "type HashMap<K, V>",
    summary: "Persistent immutable hash map data structure from Effect.",
    description: "Efficient immutable hash map with structural hashing and equality.",
    snippet: "map = HashMap.make([\"key\", 42])",
    seeAlso: ["Record", "HashSet"],
  },

  HashSet: {
    name: "HashSet",
    category: "primitive",
    signature: "type HashSet<A>",
    summary: "Persistent immutable set data structure from Effect.",
    description: "Efficient immutable collection of unique elements with structural hashing and equality.",
    snippet: "set = HashSet.make(1, 2, 3)",
    seeAlso: ["HashMap"],
  },

  // ==========================================
  // Effect Functions & Combinators
  // ==========================================
  Effect: {
    name: "Effect",
    category: "effect",
    signature: "type Effect<Success, Error = never, Requirements = never>",
    summary: "Core Effect type representing a lazy, concurrent computation.",
    description:
      "The foundational abstraction in FunScript.\n\n" +
      "An `Effect<A, E, R>` represents a blueprint for a workflow that:\n" +
      "- Requires an environment/context `R`\n" +
      "- May fail with a typed error `E`\n" +
      "- May succeed with a value `A`\n\n" +
      "Effects are lazy, composable, cancellable, and fibers-based.",
    snippet: "type UserFlow = Effect<User, NotFound, UserRepo>",
    seeAlso: ["service", "effect", "Layer", "Context"],
  },

  "Effect.succeed": {
    name: "Effect.succeed",
    category: "effect",
    signature: "Effect.succeed<A>(value: A): Effect<A>",
    summary: "Creates an Effect that succeeds immediately with the provided value.",
    description: "Wraps a pure value in an Effect that succeeds synchronously without errors or dependencies.",
    snippet: "pureValue = Effect.succeed(42)",
    seeAlso: ["Effect.fail", "Effect.sync"],
    aliases: ["succeed"],
  },

  "Effect.sync": {
    name: "Effect.sync",
    category: "effect",
    signature: "Effect.sync<A>(evaluate: () -> A): Effect<A>",
    summary: "Wraps a lazy, synchronous side effect into an Effect.",
    description: "Defers execution of a synchronous function until the Effect is run, capturing any uncaught throws as defects.",
    snippet: "randomNum = Effect.sync(-> Math.random())",
    seeAlso: ["Effect.succeed", "Effect.tryPromise"],
    aliases: ["sync"],
  },

  "Effect.tryPromise": {
    name: "Effect.tryPromise",
    category: "effect",
    signature: "Effect.tryPromise<A, E>(options: { try: () -> Promise<A>, catch: (err: unknown) -> E }): Effect<A, E>",
    summary: "Bridges an asynchronous Promise-based API into a typed Effect.",
    description:
      "Safely converts external Promise calls into FunScript Effects. Catches Promise rejections " +
      "and maps them into typed domain errors in the `E` channel.",
    snippet:
      "fetchData = (url: string) ->\n" +
      "  Effect.tryPromise({\n" +
      "    try: () -> fetch(url),\n" +
      "    catch: (err) -> NetworkError(String(err)),\n" +
      "  })",
    seeAlso: ["Effect", "effect"],
  },

  "Effect.map": {
    name: "Effect.map",
    category: "effect",
    signature: "Effect.map<A, B>(self: Effect<A, E, R>, f: (a: A) -> B): Effect<B, E, R>",
    summary: "Transforms the success value of an Effect using a pure function.",
    description: "Applies the mapping function `f` to the successful result of `self` without altering errors or dependencies.",
    snippet:
      "lengthEffect =\n" +
      "  Effect.succeed(\"hello\")\n" +
      "  |> Effect.map((s) -> s.length)",
    seeAlso: ["Effect.flatMap", "Effect.andThen"],
    aliases: ["map"],
  },

  "Effect.flatMap": {
    name: "Effect.flatMap",
    category: "effect",
    signature: "Effect.flatMap<A, B, E2, R2>(self: Effect<A, E, R>, f: (a: A) -> Effect<B, E2, R2>): Effect<B, E | E2, R | R2>",
    summary: "Chains another Effectful computation onto the success of this Effect.",
    description: "Sequentially composes two Effectful actions where the second depends on the result of the first.",
    snippet:
      "step =\n" +
      "  UserRepo.find(id)\n" +
      "  |> Effect.flatMap((user) -> EmailService.sendWelcome(user))",
    seeAlso: ["Effect.map", "Effect.andThen"],
    aliases: ["flatMap"],
  },

  "Effect.andThen": {
    name: "Effect.andThen",
    category: "effect",
    signature: "Effect.andThen<A, B>(self: Effect<A, E, R>, next: Effect<B, E2, R2> | ((a: A) -> B)): Effect<...>",
    summary: "Sequentially composes effects or functions.",
    description: "Versatile combinator that chains an Effect or a pure function after another Effect succeeds.",
    snippet:
      "action =\n" +
      "  Effect.succeed(10)\n" +
      "  |> Effect.andThen((n) -> n * 2)",
    seeAlso: ["Effect.map", "Effect.flatMap"],
    aliases: ["andThen"],
  },

  "Effect.catchAll": {
    name: "Effect.catchAll",
    category: "effect",
    signature: "Effect.catchAll<A, E, R, B, E2, R2>(self: Effect<A, E, R>, handler: (err: E) -> Effect<B, E2, R2>): Effect<A | B, E2, R | R2>",
    summary: "Recovers from any error in the Effect's error channel.",
    description: "Catches all typed errors in `E` and invokes a recovery function that returns an alternative Effect.",
    snippet:
      "safeQuery =\n" +
      "  riskyQuery\n" +
      "  |> Effect.catchAll((err) -> Effect.succeed(defaultFallback))",
    seeAlso: ["Effect.catchTag", "fail"],
    aliases: ["catchAll"],
  },

  "Effect.catchTag": {
    name: "Effect.catchTag",
    category: "effect",
    signature: "Effect.catchTag(tag: string, handler: (err: Tagged) -> Effect<...>): Effect<...>",
    summary: "Recovers from a specific tagged error matching _tag.",
    description:
      "Selectively catches errors matching a specific discriminant tag (from `error` schemas). " +
      "Leaves all other errors intact in the `E` channel.",
    snippet:
      "workflow =\n" +
      "  UserRepo.find(id)\n" +
      "  |> Effect.catchTag(\"NotFound\", (_err) -> Effect.succeed(guestUser))",
    seeAlso: ["error", "Effect.catchAll"],
    aliases: ["catchTag"],
  },

  "Effect.all": {
    name: "Effect.all",
    category: "effect",
    signature: "Effect.all(effects: Array<Effect<...>>, options?: { concurrency?: number }): Effect<Array<...>>",
    summary: "Executes multiple Effects concurrently or sequentially and combines results.",
    description: "Gathers multiple effects into a single Effect that collects all success values in an array or struct.",
    snippet:
      "combined <- Effect.all([\n" +
      "  UserRepo.find(\"1\"),\n" +
      "  OrderRepo.find(\"100\"),\n" +
      "], { concurrency: \"unbounded\" })",
    seeAlso: ["Effect.forEach"],
    aliases: ["all"],
  },

  "Effect.forEach": {
    name: "Effect.forEach",
    category: "effect",
    signature: "Effect.forEach(elements: Iterable<A>, f: (a: A) -> Effect<B, E, R>, options?: { concurrency?: number }): Effect<Array<B>, E, R>",
    summary: "Iterates over an iterable, applying an effectful function to each element.",
    description:
      "Replaces imperative loops for effectful iteration. Can run sequentially or concurrently " +
      "using the `concurrency` option.",
    snippet:
      "results <- Effect.forEach(userIds, (id) -> UserRepo.find(id), {\n" +
      "  concurrency: 5,\n" +
      "})",
    seeAlso: ["Effect.all"],
    aliases: ["forEach"],
  },

  "Effect.die": {
    name: "Effect.die",
    category: "effect",
    signature: "Effect.die(defect: unknown): Effect<never>",
    summary: "Halts fiber execution immediately with an unrecoverable defect.",
    description: "Terminates the current fiber with an uncatchable defect (system bug or assertion failure).",
    snippet: "Effect.die(new Error(\"Fatal database corruption\"))",
    seeAlso: ["Effect.orDie", "fail"],
    aliases: ["die"],
  },

  "Effect.orDie": {
    name: "Effect.orDie",
    category: "effect",
    signature: "Effect.orDie<A, E, R>(self: Effect<A, E, R>): Effect<A, never, R>",
    summary: "Demotes all typed errors in E into fatal defects.",
    description: "Converts recoverable errors in the `E` channel into defects, asserting that the operation cannot fail.",
    snippet: "safeVal = riskyOp |> Effect.orDie",
    seeAlso: ["Effect.die"],
    aliases: ["orDie"],
  },

  "Effect.retry": {
    name: "Effect.retry",
    category: "effect",
    signature: "Effect.retry(policy: Schedule): Effect<...>",
    summary: "Retries a failing Effect according to a Schedule policy.",
    description: "Automatically re-executes an Effect upon failure until the schedule policy dictates termination.",
    snippet:
      "fetchWithRetry =\n" +
      "  apiCall\n" +
      "  |> Effect.retry(Schedule.exponential(Duration.millis(100)))",
    seeAlso: ["Schedule", "Effect.repeat"],
    aliases: ["retry"],
  },

  "Effect.repeat": {
    name: "Effect.repeat",
    category: "effect",
    signature: "Effect.repeat(policy: Schedule): Effect<...>",
    summary: "Repeats a successful Effect according to a Schedule policy.",
    description: "Repeatedly executes an Effect as long as the Schedule allows.",
    snippet: "pollStatus = checkHealth |> Effect.repeat(Schedule.spaced(Duration.seconds(10)))",
    seeAlso: ["Schedule", "Effect.retry"],
    aliases: ["repeat"],
  },

  "Effect.timeout": {
    name: "Effect.timeout",
    category: "effect",
    signature: "Effect.timeout(duration: Duration): Effect<Option<A>>",
    summary: "Enforces a maximum execution time on an Effect.",
    description: "Aborts the Effect if it does not finish within the specified duration.",
    snippet: "safeFetch = slowRequest |> Effect.timeout(Duration.seconds(3))",
    seeAlso: ["Duration"],
    aliases: ["timeout"],
  },

  "Effect.fork": {
    name: "Effect.fork",
    category: "effect",
    signature: "Effect.fork<A, E>(self: Effect<A, E, R>): Effect<Fiber<A, E>, never, R>",
    summary: "Spawns an Effect onto a new concurrent background fiber.",
    description: "Starts background execution of an Effect in an isolated green fiber.",
    snippet: "fiber <- Effect.fork(backgroundTask)",
    seeAlso: ["Effect.forkScoped"],
    aliases: ["fork"],
  },

  "Effect.forkScoped": {
    name: "Effect.forkScoped",
    category: "effect",
    signature: "Effect.forkScoped<A, E>(self: Effect<A, E, R>): Effect<Fiber<A, E>, never, R | Scope>",
    summary: "Forks a fiber bound to the current Scope's lifetime.",
    description: "Spawns a fiber that is automatically interrupted and cleaned up when the enclosing Scope closes.",
    snippet: "scopedFiber <- Effect.forkScoped(longLivedService)",
    seeAlso: ["Effect.fork", "Effect.scoped"],
    aliases: ["forkScoped"],
  },

  "Effect.scoped": {
    name: "Effect.scoped",
    category: "effect",
    signature: "Effect.scoped<A, E, R>(self: Effect<A, E, R | Scope>): Effect<A, E, R>",
    summary: "Provides a new Scope to an Effect and closes it upon completion.",
    description: "Creates an execution boundary for resources requiring deterministic cleanup (like files or sockets).",
    snippet: "Effect.scoped(useTemporaryResource)",
    seeAlso: ["Effect.forkScoped", "Layer.scoped"],
    aliases: ["scoped"],
  },

  "Effect.runPromise": {
    name: "Effect.runPromise",
    category: "effect",
    signature: "Effect.runPromise<A, E>(effect: Effect<A, E, never>): Promise<A>",
    summary: "Runs an Effect at the application boundary, returning a Promise.",
    description:
      "Evaluates the Effect workflow to completion and resolves the resulting Promise with the success value. " +
      "Only permitted in application entrypoints (`main`).",
    snippet: "Effect.runPromise(mainProgram)",
    seeAlso: ["Effect.runSync"],
    aliases: ["runPromise"],
  },

  "Effect.runSync": {
    name: "Effect.runSync",
    category: "effect",
    signature: "Effect.runSync<A>(effect: Effect<A, never, never>): A",
    summary: "Synchronously executes an Effect that cannot fail and has no requirements.",
    description: "Executes an Effect synchronously. Throws if the Effect contains asynchronous fibers or unresolved failures.",
    snippet: "result = Effect.runSync(pureCalculation)",
    seeAlso: ["Effect.runPromise"],
    aliases: ["runSync"],
  },

  Layer: {
    name: "Layer",
    category: "effect",
    signature: "type Layer<Out, Error = never, In = never>",
    summary: "Recipes for constructing, composing, and providing services.",
    description:
      "A `Layer<Out, E, In>` specifies how to construct services `Out` given dependencies `In`. " +
      "Layers enable modular dependency injection, memoization, parallel construction, and resource management.",
    snippet:
      "export AppLive =\n" +
      "  UserRepoLive\n" +
      "  |> Layer.provide(DatabaseLive)",
    seeAlso: ["service", "Layer.succeed", "Layer.effect"],
  },

  "Layer.succeed": {
    name: "Layer.succeed",
    category: "effect",
    signature: "Layer.succeed<T>(tag: Service<T>, implementation: T): Layer<T>",
    summary: "Builds a Layer that provides a service with a static implementation.",
    description: "Supplies a pre-constructed service implementation directly without asynchronous setup.",
    snippet:
      "export GreeterLive =\n" +
      "  Layer.succeed(Greeter, {\n" +
      "    greet: (name) -> Effect.succeed(\"Hello \" + name),\n" +
      "  })",
    seeAlso: ["Layer", "Layer.effect", "service"],
  },

  "Layer.effect": {
    name: "Layer.effect",
    category: "effect",
    signature: "Layer.effect<T, E, R>(tag: Service<T>, build: Effect<T, E, R>): Layer<T, E, R>",
    summary: "Builds a Layer that constructs a service via an Effect.",
    description: "Allows effectful setup (e.g. connecting to a database, reading config) when instantiating a service.",
    snippet:
      "export DbLive =\n" +
      "  Layer.effect(Database, effect\n" +
      "    conn <- createConnection()\n" +
      "    { query: (sql) -> conn.execute(sql) }\n" +
      "  )",
    seeAlso: ["Layer", "Layer.succeed", "service"],
  },

  "Layer.scoped": {
    name: "Layer.scoped",
    category: "effect",
    signature: "Layer.scoped<T, E, R>(tag: Service<T>, build: Effect<T, E, R | Scope>): Layer<T, E, R>",
    summary: "Builds a Layer with managed lifecycle and resource cleanup.",
    description: "Binds the constructed service to a Scope. The service will be automatically torn down when the layer is released.",
    snippet: "Layer.scoped(ConnectionPool, acquirePool)",
    seeAlso: ["Layer", "Effect.scoped"],
  },

  Context: {
    name: "Context",
    category: "effect",
    signature: "type Context<Services>",
    summary: "Type-safe environment container for service tags and instances.",
    description: "Represents the dependency environment `R` in `Effect<A, E, R>`.",
    snippet: "context = Context.empty()",
    seeAlso: ["service", "Layer"],
  },

  Schedule: {
    name: "Schedule",
    category: "effect",
    signature: "type Schedule<Env, In, Out>",
    summary: "Recurrence policy defining repetition and retry behavior.",
    description: "Configures delays, intervals, exponential backoffs, and iteration bounds for `retry` and `repeat`.",
    snippet: "policy = Schedule.exponential(Duration.millis(100)) |> Schedule.compose(Schedule.recurs(5))",
    seeAlso: ["Effect.retry", "Effect.repeat", "Duration"],
  },

  pipe: {
    name: "pipe",
    category: "effect",
    signature: "pipe(value, f1, f2, ...): Result",
    summary: "Chains values through functions from left to right.",
    description:
      "Utility function for data-first function composition. In FunScript, the `|>` pipeline operator " +
      "is preferred syntax and compiles down to `pipe` calls.",
    snippet:
      "res = pipe(\n" +
      "  5,\n" +
      "  (n) -> n * 2,\n" +
      "  (n) -> n + 1\n" +
      ")",
    seeAlso: ["|>"],
  },

  // ==========================================
  // Syntax Operators
  // ==========================================
  "|>": {
    name: "|>",
    category: "operator",
    signature: "expression |> function(args...)",
    summary: "Pipeline composition operator.",
    description:
      "Passes the value of the left expression as the first argument (or into placeholder `_`) " +
      "of the right expression. Compiles to `pipe(...)` or direct function invocation.",
    snippet:
      "formatted =\n" +
      "  data\n" +
      "  |> Array.filter((x) -> x > 0)\n" +
      "  |> Array.map((x) -> x * 2)",
    seeAlso: ["pipe"],
  },

  "<-": {
    name: "<-",
    category: "operator",
    signature: "binding <- effectExpression",
    summary: "Effect bind operator inside effect blocks.",
    description:
      "Extracts the success value from an Effect within an `effect` block, short-circuiting on failure. " +
      "Desugars to `yield*` in `Effect.gen`.",
    snippet:
      "effect\n" +
      "  user <- UserRepo.find(id)\n" +
      "  user.name",
    seeAlso: ["effect", "Effect"],
  },

  "->": {
    name: "->",
    category: "operator",
    signature: "(param: Type) -> body",
    summary: "Function and lambda declaration arrow.",
    description:
      "Declares pure functions and lambdas in FunScript. FunScript functions automatically return " +
      "their last evaluated expression without needing a `return` keyword.",
    snippet: "add = (a: number, b: number): number -> a + b",
    seeAlso: ["effect"],
  },

  "???": {
    name: "???",
    category: "operator",
    signature: "??? [optionalMessage]",
    summary: "Typed hole placeholder for incomplete code.",
    description:
      "A hole placeholder that satisfies any type at compile time but raises a diagnostic or " +
      "throws an uncatchable defect at runtime if reached. Ideal for rapid prototyping.",
    snippet: "todoImplementation = (input: string): Result -> ??? \"implement parser\"",
    seeAlso: ["never"],
  },
};

/**
 * Formats a DocItem into a rich, standardized Markdown string for LSP Hover responses.
 */
export function formatDocToMarkdown(item: DocItem): string {
  const parts: string[] = [];

  // Syntax code block
  parts.push("```funscript\n" + item.signature + "\n```");

  // Divider and Title line
  parts.push("***");
  parts.push(`**${item.name}** (\`${item.category}\`) — ${item.summary}`);

  // Detailed description
  if (item.description) {
    parts.push(item.description);
  }

  // Example snippet
  if (item.snippet) {
    parts.push("### Example\n```funscript\n" + item.snippet + "\n```");
  }

  // Related topics
  if (item.seeAlso && item.seeAlso.length > 0) {
    const links = item.seeAlso.map((s) => `\`${s}\``).join(", ");
    parts.push(`**See also:** ${links}`);
  }

  return parts.join("\n\n");
}

// Build secondary lowercase map only for entries that don't collide,
// prioritizing exact keys first.
const EXACT_MAP = new Map<string, DocItem>();
const LOWER_MAP = new Map<string, DocItem>();

for (const [key, item] of Object.entries(DOC_CATALOG)) {
  EXACT_MAP.set(key, item);

  // If LOWER_MAP does not have it, or if current key is lowercase (keyword priority), set it
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

/**
 * Retrieves the DocItem for a given keyword, built-in type, or Effect function,
 * or null if not found.
 */
export function getDocItem(keyword: string): DocItem | null {
  if (!keyword || typeof keyword !== "string") {
    return null;
  }

  const trimmed = keyword.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // 1. Exact match (case-sensitive)
  if (EXACT_MAP.has(trimmed)) {
    return EXACT_MAP.get(trimmed)!;
  }

  // 2. Case-insensitive match (keywords prioritized)
  const lower = trimmed.toLowerCase();
  if (LOWER_MAP.has(lower)) {
    return LOWER_MAP.get(lower)!;
  }

  // 3. Effect prefix match (e.g. "succeed" -> "Effect.succeed")
  if (!trimmed.startsWith("Effect.") && EXACT_MAP.has("Effect." + trimmed)) {
    return EXACT_MAP.get("Effect." + trimmed)!;
  }
  if (!lower.startsWith("effect.") && LOWER_MAP.has("effect." + lower)) {
    return LOWER_MAP.get("effect." + lower)!;
  }

  return null;
}

/**
 * Returns formatted Markdown hover documentation for a keyword, built-in primitive,
 * or Effect operator, or null if no documentation exists.
 */
export function getHoverDocumentation(keyword: string): string | null {
  const item = getDocItem(keyword);
  if (!item) {
    return null;
  }
  return formatDocToMarkdown(item);
}

/**
 * Returns a list of all documented identifiers in the catalog.
 */
export function getAllDocKeywords(): string[] {
  return Object.keys(DOC_CATALOG);
}
