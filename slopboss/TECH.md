# Tech Stack & Guidelines: FunScript

## Core Engineering Principle: TS Ecosystem First & Simpler Implementation
- **Never hand-roll custom infrastructure** when established, lightweight npm libraries exist in the TypeScript/JavaScript ecosystem.
- FunScript builds directly on top of TypeScript. Maximize leverage from standard tools, compilers, formatters, protocol libraries, and runtime utilities.
- When facing a choice between writing 300+ lines of custom algorithm (e.g. VLQ encoders, JSON-RPC wire protocols, custom text buffers, doc engines) vs importing a battle-tested npm package (e.g. `@jridgewell/gen-mapping`, `vscode-languageserver`, `magic-string`), **always choose the npm package**.
- Keep all implementations minimal, readable, and direct. Avoid speculative abstractions and premature optimization.

## Interop Leverage: `js` and `ts` Keywords
- **Runtime JS / NPM Interop (`js`)**:
  - `res <- js promiseFn()`: Inside `effect` blocks, lifts any JS Promise into an Effect via `Effect.tryPromise(() => promiseFn())`. Use this directly for all third-party npm library calls instead of writing custom Effect wrapper layers.
  - `export js fnName = (...) => ...`: Compiles to a standard Promise-returning JS function (`Effect.runPromise(...)`). Use this for all UI event handlers (`onClick`, `onInput`), server endpoints, and framework callbacks.
  - `eff |> js`: Direct pipeline conversion of an Effect into a standard JS Promise (`pipe(eff, Effect.runPromise)`).
- **TypeScript Type System Escape Hatch (`ts`)**:
  - Use `ts "..."` inline or indented `ts` blocks for complex TypeScript types (`schema Dict = ts "Record<string, unknown>"`, `type Position = ts "import('vscode-languageserver').Position"`, utility types, and generics).
  - **Do NOT expand FunScript's parser grammar** to duplicate TypeScript's massive type system. When a type is complex or comes from an npm package, use `ts "..."` directly.

## Language Syntax & Control Flow Conventions

### Effect sequencing

Use brace-delimited `effect { ... }` expressions as the canonical style for sequencing
Effect work. Existing indentation-based `effect` blocks remain compatible syntax. In
either form, `<-` binds an Effect result, `_ <-` runs and discards an Effect, and the
final expression is returned.

### 1. Unified `=>` Arrow
FunScript uses `=>` consistently across all arrow contexts to align with TypeScript muscle memory:
- **Function Return Type**: `add = (a: Int, b: Int) => Int { ... }` or `(a: Int, b: Int) => Int`
- **Function Body / Lambdas**: `(a, b) => a + b`
- **Match Arms**: `| Some(x) => x`
- **Explicit Returns at End of Functions**: `=> expr` (explicitly denotes the return value of a function or block, emitting `return expr;`)
- **Early Return**: `when (cond) => Error("failed")`

#### Explicit Return Statements (`=> expr`)
In multi-line function bodies or indented blocks, developers can use `=> expr` at the end (or anywhere to explicitly return) to keep control flow clear and readable:
```funscript
processOrder = (order: Order) => Result<Invoice, Error> {
  when (order.items.isEmpty) => Error("Empty order")

  total = calculateTotal(order.items)
  invoice = createInvoice(order, total)

  # Explicit return at the end:
  => Ok(invoice)
}
```
This mirrors early returns (`when (cond) => ...`) and gives developers unambiguous, explicit control over return values.

### 2. The `when` Keyword (3 Context-Specific Forms)
`when` is a single keyword with three clear forms:
- **Early Return**: `when (condition) => expr`
  If `condition` is true, returns `expr` immediately from enclosing function. If false, execution continues. (Rejected by compiler outside function bodies).
- **Conditional Execution Block**: `when (condition) { ... }` or indented block
  If `condition` is true, executes the enclosed block statements, then continues execution regardless.
- **Match Arm Guard**: `| Pattern when condition => result`
  Selects match case only when both the pattern matches and `condition` evaluates to true.

### 3. Equality Semantics: Structural vs Reference Identity
- **Structural / Value Equality (`==`, `!=`)**:
  - Compares by value and structural content.
  - For Effect `Data` structures (records, schemas, tagged unions), lowers to `Equal.equals(a, b)` from `effect`.
  - For primitive values (`String`, `Number`, `Boolean`), uses value equality (`===` in JS).
- **Reference Identity (`===`, `!==`)**:
  - Compares physical reference identity.
  - Restricted to reference-like objects.

### 4. Match Expressions
All established match variations are preserved:
- **Value Matching**: `match value \n | Some(x) => x \n | None => 0`
- **Subjectless Matching**: `match \n | x > 10 => "high" \n | _ => "normal"`
- **Pipeline Matching**: `value |> match \n | Pattern => result`
- **Or-Patterns**: `| Red | Green | Blue => "Primary"`
- **When Guards**: `| Some(user) when user.isAdmin => "Admin"`

## Type System & Primitive Conventions
- **All Types are PascalCase**: Every type in FunScript must begin with an uppercase letter:
  - Primitives: `String`, `Number`, `Boolean`, `Void`, `Unknown`, `Never`.
  - Collections & Containers: `Array<T>`, `Option<T>`, `Record<K, V>`, `Effect<A, E, R>`.
  - Custom Schemas: `User`, `Shape`, `Todo`.
- **Pure Effect Primitives**: FunScript primitives are backed by Effect modules (`String`, `Number`, `Array`, `Record`, `Option`, `Duration`) and provide pure functional pipeline operators (`trim`, `split`, `lines`, `partition`, `compact`, `omit`, `pick`).
- **Gated JS Prototype Access**: Raw mutable JavaScript methods or Promise interop are strictly gated behind `js` (`<- js`, `export js`, `|> js`).

## Architecture & Stack
- **Language**: TypeScript (ESModules, Node 20+, `"type": "module"`)
- **Runtime Libraries**:
  - `effect` (^3.10.16) for typed effects, Option, Either, Fiber, Context
  - `ts-pattern` (^5.5.0) for pattern matching
  - `mutative` (^1.1.0) for immutable data modification
- **Compiler & Tooling Libraries**:
  - Source Maps: Use `@jridgewell/gen-mapping` or `magic-string` (do NOT write custom VLQ encoders).
  - LSP: Use official `vscode-languageserver` / `vscode-languageserver-textdocument` packages for transport, protocol handling, and diagnostics (do NOT hand-roll JSON-RPC transports or protocol parsers).
  - Formatting: `prettier` (^3.x) with FunScript plugin.
- **Build & Tests**:
  - `typescript` (`tsc`)
  - `vitest` (`npm test`)

## Codebase Structure
- `src/core/`: AST definitions, interfaces, core abstractions
- `src/lexer/`: Tokenizer, indentation tracking, layout rules (including `.funx` JSX tokenization)
- `src/parser/`: Indentation-based syntax parser producing AST + JSX tree parsing
- `src/compiler/` & `src/emitter/`: AST -> TypeScript / TSX emitter with Effect/ts-pattern integrations
- `src/lsp/`: Language Server Protocol implementation using standard LSP libraries
- `src/formatter/`: FunScript source code formatter / pretty printer
- `src/cli/`: Command line tool (`funscript run`, `funscript build`, `funscript fmt`, `funscript lsp`)
- `tests/`: Vitest test suites (lexer, parser, compiler, lsp, formatter, funx)
- `examples/` & `programs/`: Sample programs demonstrating real functional workflows

## .funx Component Guidelines
- `.funx` enables writing UI components directly in FunScript syntax with native JSX elements.
- Emits clean `.tsx` with standard JSX elements so downstream tools (Solid's babel-preset-solid or React/Vite) perform optimal compile-time template extraction (`template()`).
- Keep TSX emission direct: transform FunScript expressions, leave standard JSX intact for downstream bundlers.

## Recommended Library Patterns & Snippets

Dev agents should install and use these exact patterns instead of designing custom solutions:

### 1. Source Maps: `magic-string`
```typescript
import MagicString from "magic-string";

const s = new MagicString(funSource);
// replace / inject emitted expressions
const map = s.generateMap({
  source: filename,
  file: `${filename}.ts`,
  hires: true,
  includeContent: true,
});
// map.toString() produces the .map JSON
```

### 2. LSP Server: `vscode-languageserver/node`
```typescript
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Full,
    definitionProvider: true,
    hoverProvider: true,
  },
}));

documents.listen(connection);
connection.listen();
```

### 3. Diagnostics & Code Frames: `@babel/code-frame`
```typescript
import { codeFrameColumns } from "@babel/code-frame";

const formattedError = codeFrameColumns(
  sourceText,
  { start: { line: err.line, column: err.col } },
  { message: err.message, highlightCode: true }
);
```

## Workflow & Coding Rules
- Every feature or bugfix must have comprehensive Vitest unit/integration tests.
- Favor standard ecosystem libraries over custom wheels.
- Follow functional pipeline-first design (`data |> operator(...)`) with auto-namespace resolution rather than OOP prototype method chaining.
- Follow the base branch `main`. All dev agent work must merge to `main` without breaking existing tests.

## Strictness Architecture: Compiler Verification & Runtime Boundary Validation

### 1. Compile-Time Guarantees Inside FunScript Code
- Inside FunScript code, static type safety is enforced by the compiler.
- `funscript check` runs the TypeScript compiler API on virtual emitted source files and maps diagnostics with `@babel/code-frame`.
- `funscript run` and `funscript build` MUST gate on static type-checking: if type errors are present (e.g. passing a `Number` where `String` is expected), execution halts immediately with a non-zero exit code and formatted error frames.
- `--no-check` explicitly skips static checking for fast prototyping; parsing and runtime schema validation remain active. Keep checks enabled in CI and production verification.
- Auto-injected Effect header imports must be deduplicated against user imports to prevent TS2300 duplicate identifier errors.

### 2. Runtime Validation at the Edges
- Outside code cannot be trusted by the compiler. At the boundaries (the "edges"), runtime validation is mandatory:
  - **`export js name = (params) => ...`**: When FunScript functions are exported to plain JavaScript, the emitter wraps them with runtime parameter checks (`typeof arg !== "string"` or `Schema.decodeUnknownSync`), immediately throwing `TypeError` / `ValidationError` if foreign JS code passes invalid types.
  - **Boundary Schemas**: External data (HTTP JSON, database query rows, CLI argv, environment variables, file I/O) must be decoded with `Schema.decodeUnknown` (typed Effect failure), `Schema.decodeUnknownEither` (Either), or `Schema.decodeUnknownSync` (synchronous exception). Parse JSON text before decoding record schemas, or use `Schema.parseJson`.
  - **Type-only escape hatches**: Complex `ts` aliases have no automatic runtime validator. Supply a schema and explicitly decode foreign values before using them in typed domain code.
  - **Schema Constructors**: Invoking a schema constructor (e.g. `User({ ... })`) validates the input payload against the schema definition at runtime.

## Native Effect Types & Ecosystem Best Practices

### 1. Native Effect Type Mapping Matrix
FunScript types are not an ad-hoc abstraction; they are 1:1 representations of native Effect types and modules:

| FunScript Type | Native Effect Runtime Module | TypeScript Lowered Type | Effect Schema Representation |
| :--- | :--- | :--- | :--- |
| `String` | `effect/String` | `string` | `Schema.String` |
| `Number` | `effect/Number` | `number` | `Schema.Number` |
| `Boolean` | `effect/Boolean` | `boolean` | `Schema.Boolean` |
| `Void` | - | `void` | `Schema.Void` |
| `Unknown` | - | `unknown` | `Schema.Unknown` |
| `Never` | - | `never` | `Schema.Never` |
| `Array<T>` | `effect/Array` | `ReadonlyArray<T>` | `Schema.Array(T)` |
| `Record<K, V>` | `effect/Record` | `Record.ReadonlyRecord<K, V>` | `Schema.Record({ key: K, value: V })` |
| `Option<T>` | `effect/Option` | `Option.Option<T>` | `Schema.Option(T)` |
| `Effect<A, E, R>` | `effect/Effect` | `Effect.Effect<A, E, R>` | - |
| `Duration` | `effect/Duration` | `Duration.Duration` | `Schema.Duration` |
| `schema Name = ...` | `effect/Schema` | `typeof Name.Type` | `Schema.Struct(...)` |
| `schema Enum = ...` | `effect/Data` | `Data.TaggedEnum<...>` | `Data.taggedEnum<...>()` |
| `error Name(...)` | `effect/Schema` | `Name extends Schema.TaggedError` | `Schema.TaggedError` |
| `service Name` | `effect/Context` | `Context.Tag` | `Layer` |

### 2. Best Practices Enforced Across the Language
1. **Zero Drift**: Schemas serve simultaneously as the runtime validator and the static TypeScript type. No separate Zod or duplicate interfaces.
2. **Deep Immutability**: All emitted arrays are `ReadonlyArray`; all schema records emit `readonly` properties. Mutable state is restricted to local `mut (draft) =>` scopes using Mutative or `Effect.Ref` for concurrent fibers.
3. **No `null` or `undefined`**: All absent values must use `Option<T>` (`Some` or `None`). Missing fields in schemas use `Option<T>`.
4. **Structural Value Equality**: `==` and `!=` lower to `Equal.equals` from `effect` for all records, schemas, and tagged unions.
5. **No Untyped Exceptions**: All recoverable failures are typed in the error channel of `Effect<A, E, R>` using `Schema.TaggedError`. JavaScript exceptions are caught at boundaries via `Effect.try` / `Effect.tryPromise`.
6. **Pipeline-First Composition (`|>`)**: Standard operations on collections and data use Effect companion functions (`Array.map`, `Array.filter`, `Option.map`, `String.trim`).

### 5. No `fn` Keyword ("One Way to Define Functions")
Following the "One Way Per Job" core axiom from `docs/pit-of-success.md`, FunScript rejects `fn` and `function`. Functions are strictly immutable bindings initialized with an arrow expression:
```funscript
# Single-line:
add = (a: Number, b: Number) => a + b

# Multi-line with explicit return type:
processOrder = (order: Order) => Result<Invoice, Error> {
  when (order.items.isEmpty) => Error("Empty order")
  total = calculateTotal(order.items)
  => Ok(createInvoice(order, total))
}
```
Attempting to use `fn name(...)` is rejected by the parser with a helpful error directing the author to `name = (params) => ...`.

---

## Tooling & Token Efficiency Standards

All agents and tools must adhere to token-conscious execution to keep AI context lean and prevent rate-limit / token-budget exhaustion:

1. **Non-Interactive / Lean Test Output**:
   - Never use interactive or animated test reporters that re-render progress lines in terminal emulators.
   - Use `vitest run --reporter=basic` (or `--reporter=dot`) for all test execution. This reduces test log tokens by >90% (from 20k+ lines to ~10 lines).
2. **Targeted Verification During Development**:
   - During iterative development, dev agents must execute only the test file relevant to their task (`npx vitest run tests/<feature>.test.ts --reporter=basic`).
   - Run the full test suite (`npm test`) only once as a final verification before squash-merging.
3. **Board File Limits**:
   - Keep active board files bounded: `TASKS.md` should only list active in-progress tasks. Completed tasks must be moved to `ARCHIVE.md`.
   - Never load `ARCHIVE.md` into active agent prompts unless explicitly asked for historical context.
4. **Targeted File Reading**:
   - Use `StartLine` and `EndLine` parameters when reading source files. Avoid whole-file reads of 500+ line files when inspecting a single function or type.
