# FunScript Dogfooding Report: Applications, Edge Cases & Ergonomics

## 1. Executive Summary

This dogfooding exercise stress-tested FunScript across realistic, non-trivial applications spanning backend API consumption, CLI state management with copy-on-write drafts, and reactive UI component authoring in `.funx`.

Three complete applications were built and verified:

1. **GitHub REST API Client (`programs/05-github-api-client.fun` & `examples/github-api-client.fun`)**: REST API client leveraging foreign Promise interop via `js`, runtime JSON schema decoding via `Schema.Struct` and `Schema.decodeUnknownSync`, functional pipelines with `|>`, Effect tagged error declarations, and exhaustive pattern matching on response states (`Success`, `RateLimited`, `NotFound`, `ServerError`).
2. **Markdown Task Manager CLI (`programs/06-markdown-task-manager.fun` & `examples/markdown-task-manager.fun`)**: Local task manager featuring Mutative `draft` state updates, Effect file system I/O, `when` early returns (`when (title == "") => ...`), conditional block execution (`when (idx != -1) { ... }`), and explicit returns (`=> expr`).
3. **Reactive UI Widget Component (`programs/07-reactive-widget.funx` & `examples/reactive-widget.funx`)**: Native JSX component compiling to `.tsx`, typed props, tagged union view states, attribute string template interpolation (`className="widget-card variant-${props.variant}"`), child expressions, and conditional rendering.

In addition to building and executing these applications, extensive stress testing uncovered **8 critical compiler/runtime edge cases and ergonomic friction points**, detailed below with minimal reproducible examples, analysis, and recommendations.

---

## 2. Realistic Applications Built

### 2.1 GitHub REST API Client (`05-github-api-client.fun`)

- **Location**: `programs/05-github-api-client.fun` (mirrored at `examples/github-api-client.fun`)
- **Key Features Demonstrated**:
  - `export schema Repository = { ... }` for API response structure.
  - `export schema ApiResponse = Success | RateLimited | NotFound | ServerError` tagged union.
  - `export error GithubApiError(statusCode: Number, message: String)` for Effect typed errors.
  - `js executeFetch(...)` in `effect` block to lift foreign async Promises into typed fibers.
  - Pipeline decoding: `raw.json |> Schema.decodeUnknownSync(Repository)`.
  - Exhaustive pattern matching (`match res | Success(repo) => ...`).

### 2.2 Markdown Task Manager CLI (`06-markdown-task-manager.fun`)

- **Location**: `programs/06-markdown-task-manager.fun` (mirrored at `examples/markdown-task-manager.fun`)
- **Key Features Demonstrated**:
  - State management using Mutative copy-on-write draft scopes: `manager.tasks |> mut (draft) => draft.push(newTask) \n draft`.
  - Early returns with `when (cond) => expr`.
  - Conditional block execution with `when (cond) { ... }`.
  - Explicit return statements with `=> expr`.
  - File system persistence via Node fs promises lifted into Effect fibers.

### 2.3 Reactive UI Widget Component (`07-reactive-widget.funx`)

- **Location**: `programs/07-reactive-widget.funx` (mirrored at `examples/reactive-widget.funx`)
- **Key Features Demonstrated**:
  - `.funx` to `.tsx` component compilation.
  - Typed props via `WidgetProps = { title: String, initialCount: Number, step: Number, min: Number, max: Number, variant: String }`.
  - Pattern matching directly returning JSX branches (`renderStatusBadge`).
  - JSX attribute template interpolation: `className="widget-card variant-${props.variant}"`.
  - Conditional child rendering: `{props.initialCount == props.max and <p>Maximum boundary reached!</p>}`.
  - Event callback bindings (`onClick={() => Console.log(...)}`).

---

## 3. Discovered Edge Cases & Minimal Reproductions

### Edge Case 1: Pipeline Placeholder `_` in Non-Call Expressions Emits Undeclared `__placeholder`

- **Symptom**: Using `_` in arithmetic, binary, or unary pipeline stages emits bare `__placeholder` instead of wrapping into a lambda `(__p) => ...`.
- **Minimal Repro**:
  ```funscript
  res = x |> _ + 1
  ```
- **Emitted Code**:
  ```typescript
  const res = pipe(x, __placeholder + 1);
  ```
- **Runtime Error**: `ReferenceError: __placeholder is not defined`.
- **Root Cause**: `src/emitter/emitter.ts` line 468 only checks `resolvedStage.kind === "CallExpression" && resolvedStage.args.some(a => a.kind === "Placeholder")`. Any non-call pipeline stage leaves `__placeholder` unwrapped.
- **Recommendation**: In `emitPipelineExpression`, inspect arbitrary expressions for `Placeholder` nodes and wrap in `(__p) => emittedExpr`.

---

### Edge Case 2: Relational Comparison Operators (`<`, `>`, `<=`, `>=`) Missing in Expression Grammar

- **Symptom**: Expressions like `x < 10`, `x > 0`, or `count <= max` fail to parse with `ParseError: Unexpected token '>'`.
- **Minimal Repro**:
  ```funscript
  when (x > 0) => "positive"
  ```
- **Parser Error**: `Expected ')' after when condition (got '>', expected ))`.
- **Root Cause**: In `src/parser/parser.ts`, `parseEquality` directly calls `parseAdditive`. Relational operators (`<`, `>`, `<=`, `>=`) are never checked in the binary expression precedence chain because `<` was reserved for generics and JSX tags.
- **Current Workaround**: Developers must call `x |> greaterThan(0)` or `Number.lessThanOrEqualTo(0)`.
- **Recommendation**: Add `parseRelational` between `parseEquality` and `parseAdditive`, disambiguating `<` as an operator when not in type argument or JSX tag opening position.

---

### Edge Case 3: `when` Statements Unhandled Inside `EffectBlockExpression`

- **Symptom**: Writing a `when` statement (early return or block) inside an `effect` block fails parsing with `Unexpected token 'when'`.
- **Minimal Repro**:
  ```funscript
  main = effect
    when (flag == true) => 0
    1
  ```
- **Parser Error**: `Unexpected token 'when' (when) at line 2, col 3`.
- **Root Cause**: While `src/emitter/emitter.ts` line 857 has `if (s.kind === "WhenStatement") return ...`, `parseEffectBlock` in `src/parser/parser.ts` line 1425 only parses `<-`, mutable assignment, or binding declarations. It treats `when` as a non-final bare expression and throws.
- **Recommendation**: Add `if (this.check(TokenType.WHEN)) { body.push(this.parseWhenStatement()); continue; }` to `parseEffectBlock`.

---

### Edge Case 4: Deep Structural Equality (`==`) on Schema Records vs Tagged Enums

- **Symptom**: Comparing two schema record instances with identical contents returns `false` at runtime.
- **Minimal Repro**:
  ```funscript
  schema Point = {
    x: Number
    y: Number
  }

  p1: Point = { x: 1, y: 2 }
  p2: Point = { x: 1, y: 2 }
  isEqual = p1 == p2
  ```
- **Emitted Code**: `Equal.equals(p1, p2)`.
- **Runtime Value**: `false`.
- **Root Cause**: FunScript record schemas emit plain JavaScript object literals `{ x: 1, y: 2 }`. Effect's `Equal.equals` only performs deep structural equality on objects implementing the `Equal.Equal` interface (symbols `Equal.symbol` and `Hash.symbol`, e.g. `Data.struct` or `Data.TaggedEnum`). Plain objects fall back to reference equality (`===`).
- **Contrast**: `s1 = Active(1); s2 = Active(1); s1 == s2` correctly returns `true` because `Data.TaggedEnum` implements `Equal.Equal`.
- **Recommendation**: When emitting RecordSchema instances or constructors, wrap record creation in `Data.struct(...)` so `Equal.equals` performs recursive structural comparison as intended by TECH.md.

---

### Edge Case 5: `export error` Emits Class Requiring `new` in a Language Without `new`

- **Symptom**: `export error MyError(code: Number)` emits `class MyError extends Schema.TaggedError...`. Calling `MyError(404)` in FunScript emits `MyError(404)` without `new` or named fields, causing `TypeError: Value of type 'typeof MyError' is not callable. Did you mean to include 'new'?`.
- **Minimal Repro**:
  ```funscript
  export error NotFound(id: Number)
  err = NotFound(1)
  ```
- **Root Cause**: FunScript has no `new` keyword in its grammar. Schema.TaggedError produces a class constructor expecting `new NotFound({ id: 1 })`.
- **Current Workaround**: Use `ts` escape hatch: `ts "export const makeNotFound = (id: number) => new NotFound({ id });"`.
- **Recommendation**: Emitter should emit a callable constructor companion function alongside the class:
  ```typescript
  export const NotFound = (id: number) => new NotFound$Class({ id });
  ```

---

### Edge Case 6: Duplicate Header Imports in `funscript check` (TS2300)

- **Symptom**: When a user imports symbols from `"effect"` (e.g. `import { Effect, Console } from "effect"`), and the compiler auto-injects imports (e.g. `import { Context, Data, Effect, Schema, pipe } from "effect";`), TypeScript reports `error TS2300: Duplicate identifier 'Effect'`.
- **Minimal Repro**:
  ```funscript
  import { Effect, Console } from "effect"
  export val = 42
  ```
- **Diagnostics**: `Duplicate identifier 'Effect'`.
- **Root Cause**: The emitter unconditionally prepends `this.effectImports` to the file header without deduplicating or merging with user-written `ImportDeclaration` statements in the AST.
- **Recommendation**: Collect user import specifiers and filter them out of `this.effectImports` before generating the header import line.

---

### Edge Case 7: `Array<T>` Inside Record Schema Emits Bare `Array` Crashing Schema.Struct

- **Symptom**: Defining a field with `Array<Task>` inside `schema Foo = { tasks: Array<Task> }` causes `Schema.Struct` to crash at runtime: `TypeError: Cannot read properties of undefined (reading '_tag')`.
- **Minimal Repro**:
  ```funscript
  schema Task = {
    id: Number
  }

  schema Manager = {
    items: Array<Task>
  }
  ```
- **Emitted Code**:
  ```typescript
  const Manager = Schema.Struct({ items: Array });
  ```
- **Root Cause**: In `src/emitter/emitter.ts:279`, `emitSchemaTypeField` does not check for `tName === "Array"`, falling back to `return tName`. This passes JavaScript's global `Array` constructor to `Schema.Struct`, which expects an Effect `Schema` instance with AST metadata.
- **Recommendation**: In `emitSchemaTypeField`:
  ```typescript
  if (tName === "Array" && typeNode.typeArgs) {
    return `Schema.Array(${this.emitSchemaTypeField(typeNode.typeArgs[0])})`;
  }
  ```

---

### Edge Case 8: Mutative Property and Index Assignments Rejected in `mut (draft) =>`

- **Symptom**: Inside `mut (draft) =>` recipes, direct property mutations (`draft.status = "done"`) and indexed assignments (`draft[0] = item`) fail with `ParseError: Unexpected token '='`.
- **Minimal Repro**:
  ```funscript
  updated = user |> mut (draft) =>
    draft.name = "Alice"
    draft
  ```
- **Root Cause**: The statement parser in `src/parser/parser.ts` only recognizes assignment if `peek().type === IDENTIFIER && peekAhead(1).type === EQ && this.mutableVariables.has(...)`. Member access `draft.name` has `.` at peekAhead(1), so it enters `parseExpression` which treats `=` as an invalid operator.
- **Current Workaround**: Use method calls (`draft.push(...)`, `draft.splice(...)`) or record update syntax `{ ...user, name: "Alice" }`.
- **Recommendation**: In statement parsing within `mut` scopes, parse assignments whose target is a member expression (`draft.foo.bar = expr`) or index expression (`draft[idx] = expr`).

---

## 4. Ergonomics Review

### 4.1 What Feels Natural & Delightful

- **Unified `=>` Arrow**: Having `=>` across return types, lambda bodies, match arms, and explicit returns aligns smoothly with TypeScript muscle memory.
- **Pipeline-First Composition (`|>`)**: Pipelining operations (`items |> map(handler) |> filter(handler) |> join("\n")`) with auto-namespace resolution is significantly cleaner and more readable than method chaining or nested calls.
- **Tagged Unions & Exhaustive Matching**: FunScript's `schema Enum = Variant1 | Variant2(...)` coupled with `ts-pattern` emission provides seamless sum types and exhaustive match guarantees.
- **Direct `.funx` JSX Integration**: Authoring components directly with native HTML/JSX elements while leveraging FunScript expressions, conditional rendering, and pattern matching inside JSX feels like a massive productivity boost for UI developers.
- **`ts` Escape Hatch**: The inline and block `ts` escape hatches provide an indispensable pragmatic bridge when calling unmodeled npm libraries, adding global JSX declarations, or bridging type definitions without waiting for compiler grammar changes.

### 4.2 What Causes Friction

- **Absence of Binary `<` and `>`**: Having to write `Number.greaterThan(50)` or `n |> lessThanOrEqualTo(0)` for simple arithmetic comparisons is surprising and cumbersome.
- **Lack of Dot-Path Assignment in `mut`**: Mutative's primary value proposition is drafting with standard JavaScript mutation syntax (`draft.items[i].done = true`). Having to fall back to `draft.splice` inside `mut` diminishes ergonomics.
- **Manual Error Constructors**: Because `export error` requires `new` in TypeScript, developers cannot simply write `Effect.fail(MyError(code, msg))` without a `ts` bridge.
- **Header Import Conflicts in `funscript check`**: Having to carefully avoid importing `Effect` or `Schema` if the emitter also emits them creates unnecessary cognitive load.

---

## 5. Concrete Recommendations & Next Steps

1. **Implement Relational Operators (`<`, `>`, `<=`, `>=`)**: Introduce `parseRelational` with grammar disambiguation so standard numeric and date comparisons can be written directly in expressions and `when` conditions.
2. **Support `when` in `effect` Blocks**: Update `parseEffectBlock` to support `WhenStatement`, allowing early returns and conditional checks directly within effect workflows.
3. **Enhance Record Schema Equality**: Emit `Data.struct(...)` for record schemas so that `==` evaluates structural equality recursively as specified in TECH.md.
4. **Auto-Generate Factory Functions for Tagged Errors**: Emit `export const ErrorName = (fields) => new ErrorName$Class(fields)` for all `error` declarations.
5. **Support Member and Index Assignment in Statements**: Expand assignment parsing to allow `target.prop = val` and `target[idx] = val` within mutable and `mut (draft)` scopes.
6. **Fix `Array<T>` Schema Emission**: Map `Array<T>` to `Schema.Array(...)` in `emitSchemaTypeField`.
7. **Merge User & Auto Header Imports**: Deduplicate generated imports against AST imports to eliminate TS2300 diagnostics.

---

## 6. Backlog Tasks Filed

The following tasks have been filed in `BACKLOG.md`:

- **TASK-031**: Fix Relational Comparison Operators (`<`, `>`, `<=`, `>=`) in Expression Precedence
- **TASK-032**: Support `when` Statements in `EffectBlockExpression`
- **TASK-033**: Auto-generate TaggedError Callable Constructors & Fix `Array<T>` Schema Field Emission
- **TASK-034**: Support Member & Index Assignments in `mut (draft)` Scopes & Merge Header Imports
