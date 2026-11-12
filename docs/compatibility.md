# Language and Ecosystem Compatibility Policy

This document defines FunScript's compatibility policy across three key evolutionary areas:
1. **Effect compatibility aliases** and upstream synchronization.
2. **Breaking language and syntax changes** and deprecation lifecycle.
3. **Type-directed pipeline companion resolution** and ambiguity diagnostics without priority fallback.

Under the human-approved project policy ([TASK-102](tooling.md#language-compatibility-policy)), FunScript adopts a **Strict Zero-Alias Policy**. Because FunScript is in active early development with zero external production consumers, obsolete constructs, historical shims, and ambiguous heuristics are rejected immediately rather than maintained across long deprecation windows or hidden behind edition flags.

---

## 1. Core Compatibility Guarantees and Project Status

### Pre-1.0 Development Status
FunScript is currently version `0.1.x`. During pre-1.0 development:
- The language syntax, typechecker, compiler, and standard library bindings evolve rapidly.
- Backwards compatibility guarantees apply to verified and documented language features within minor releases, but breaking changes may be introduced across minor versions (e.g. `0.1.0` to `0.2.0`) to correct design defects, improve type safety, or synchronize with the Effect ecosystem.
- No historical shims, compiler flags, or multi-release transitional wrappers are maintained for obsolete constructs.

### The Strict Zero-Alias Invariant
The Strict Zero-Alias invariant guarantees that:
- **No legacy alias accumulation:** FunScript does not retain parallel naming schemes or multiple syntactic ways to express the same underlying construct.
- **Immediate upstream alignment:** Public module member names match the installed Effect v4 ecosystem exports directly.
- **Fail-fast compile-time diagnostics:** Deprecated, obsolete, or ambiguous forms produce immediate, actionable compile-time errors citing canonical alternatives.
- **Lean compiler surface:** The compiler, parser, and emitter remain clean and maintainable without technical debt from dead compatibility layers.

---

## 2. Effect Aliases and Upstream Synchronization

### Upstream Effect Ecosystem Alignment
FunScript is built natively on the Effect ecosystem (targeting Effect v4+). Companion modules (`Array`, `Chunk`, `Duration`, `Effect`, `Layer`, `Option`, `Result`, `Schedule`, `Schema`, `Stream`, `String`, `Struct`) are imported directly from `"effect"`.

### Deprecation Lifecycle for Effect Aliases
When upstream Effect renames, restructures, or deprecates module exports:
1. **Immediate Canonical Adoption:** FunScript adopts the new canonical export name in compiler companion catalogs and documentation.
2. **Zero Retention Windows:** Obsolete Effect aliases are not retained behind deprecation warnings or long grace periods. They are removed immediately.
3. **Audit of Legacy Exceptions:** Any temporary compatibility entries in [`EFFECT_PIPELINE_COMPATIBILITY_ALIASES`](../src/emitter/pipeline-catalog.ts) (such as historical `catchAll` mapping to `catch`) are explicit legacy exceptions undergoing active audit and scheduled removal. They must never serve as precedent for introducing new aliases.

### Code Examples: Effect Aliases

#### Example: Effect Error Recovery
Effect v4 renamed `catchAll` to `catch`. In FunScript:

```funscript
# Audited compatibility alias (compiles to Effect.catch; slated for removal):
export recover = task |> catchAll((err) => Effect.succeed("fallback"))

# Canonical Effect v4 operation:
export recover = task |> catch((err) => Effect.succeed("fallback"))
```

#### Example: Fiber Forking
Effect v4 uses `forkChild` for spawning managed child fibers:

```funscript
# Obsolete Effect alias (rejected):
export spawned = effect {
  fiber <- task |> fork
  => fiber
}

# Canonical Effect v4 operation:
export spawned = effect {
  fiber <- task |> forkChild
  => fiber
}
```

#### Example: Comparison Operations on Values
Historical `Number` comparison aliases (e.g., `greaterThan`, `lessThan`) have been completely removed in favor of native comparison operators for numbers and explicit `Order` instances for other domains:

```funscript
# Obsolete helper alias (rejected):
isPositive = (n: Number) => n |> greaterThan(0)

# Canonical FunScript native comparison:
isPositive = (n: Number) => n > 0
```

---

## 3. Breaking Language and Syntax Changes Protocol

### Protocol Principles
When language syntax, grammar, or AST semantics evolve:
1. **Static Rejection:** Deprecated syntax is rejected at parse time or during semantic validation.
2. **Actionable Diagnostics:** Error messages must cite the canonical replacement and highlight the exact source span.
3. **No Silent Semantic Shifts:** The compiler never silently converts legacy syntax into new syntax if runtime semantics could diverge or mask developer intent.
4. **No Automated CLI Codemods (TASK-104 & TASK-166):** Unattended CLI migration commands (such as `funscript migrate`) have been formally declined to avoid silent semantic corruption. Safe programmatic migration is provided via `src/tooling/migrate.ts` for unambiguous function blocks, while ambiguous constructs (such as trailing bindings and ambiguous effects) are strictly flagged with diagnostics for developer review.

### Major Implemented Syntax Rules and Protocols

#### Explicit Return Invariant
All multi-statement function blocks and `effect` blocks require an explicit `=> value` return. Trailing bare expressions without `=>` are rejected by the parser:

```funscript
# Outdated syntax (rejected: ParseError - Function block must end with an explicit '=> returnValue'):
sum = (a: Number, b: Number) => {
  a + b
}

# Canonical syntax:
sum = (a: Number, b: Number) => {
  => a + b
}
```
*Note:* Single-expression lambda bodies (`(a, b) => a + b`) remain valid expression bodies and do not require `=>`.

#### Numeric-Only Relational Operators
The relational operators `<`, `<=`, `>`, and `>=` are strictly restricted to proven numeric operands. Applying relational operators to strings, records, or domain types is statically rejected:

```funscript
# Invalid (rejected: Operator '<' cannot be applied to types 'string' and 'string'):
isEarlier = (a: String, b: String) => a < b

# Canonical domain ordering via Effect Order:
import { Order, String } from "effect"
isEarlier = (a: String, b: String) => Order.lessThan(String.Order)(a, b)
```

#### Value Equality vs. Reference Identity
Value equality uses `#=` and `#!` (compiling to `Equal.equals`). Reference identity uses `@=` and is restricted to non-primitive reference types:

```funscript
# Invalid (rejected: Reference identity '@=' cannot be used with primitive values):
isSame = (a: Number, b: Number) => a @= b

# Canonical structural value equality:
isSame = (a: Number, b: Number) => a #= b
```

---

## 4. Type-Directed Pipeline Companion Resolution and Ambiguity Policy

### How Pipeline Resolution Works
FunScript pipelines (`value |> stage(...)`) allow bare stage names to resolve to companion module methods based on the inferred type of the receiver expression:
1. **Type Inference Pass:** In `inferPipelineCompanions`, the compiler analyzes the pipeline input expression within the TypeScript compilation context.
2. **Proven Receivers:** If the receiver expression has a proven type corresponding to an Effect companion module (`Array`, `Option`, `Result`, `Effect`, `Stream`, `Chunk`, `Layer`, `Schedule`, `Schema`, `Record`, `String`, `DateTime`, `HashMap`, `HashSet`), bare operations in [`PIPELINE_COMPANION_CATALOG`](../src/emitter/pipeline-catalog.ts) are automatically dispatched to that companion module.

For example, when the receiver is a proven array:
```funscript
# Source:
export incremented = [1, 2, 3] |> map((x) => x + 1)

# Emitted TypeScript:
export const incremented = Array.map([1, 2, 3], (x) => (x + 1));
```

### The Zero Priority Fallback Policy
FunScript strictly rejects priority fallback, default companion weighting, and heuristic guessing:
- The compiler **never** defaults to `Array` or `Effect` simply because they are common companions.
- Every companion module in the catalog participates on equal footing.
- If the receiver type is unproven, untyped (e.g. `any`, `unknown`), or a mixed union where companions diverge, the bare stage name is treated as ambiguous.

### Ambiguity Diagnostics Contract
When a bare stage matches multiple candidate modules in [`PIPELINE_COMPANION_CATALOG`](../src/emitter/pipeline-catalog.ts) and the receiver cannot be proven to a single companion, the compiler throws a `PipelineResolutionError`:

```
<name> is ambiguous for this pipeline; write <Module1>.<name>(...) or <Module2>.<name>(...)
```

### Code Examples: Pipeline Ambiguity

#### Ambiguous Bare Stage (Compile Error)
In the function below, `data` has an unannotated/unproven parameter type:

```funscript
# Ambiguous bare call without a proven receiver type:
export process = (data) => data |> map((x) => x + 1)
```

**Compiler Diagnostic:**
```
PipelineResolutionError: map is ambiguous for this pipeline; write Array.map(...) or Option.map(...) or Result.map(...) or Chunk.map(...) or Effect.map(...) or Schedule.map(...) or Stream.map(...)
```

#### Disambiguation Approaches
Developers resolve ambiguity by providing explicit companion qualification or type annotations:

**Approach A: Explicit Companion Call (Recommended)**
```funscript
export processArray = (data) => data |> Array.map((x) => x + 1)
export processOption = (data) => data |> Option.map((x) => x + 1)
```

**Approach B: Proven Receiver Type via Type Annotation or Local Binding**
```funscript
export processArray = (data: Array<Number>) => data |> map((x) => x + 1)

export processOption = () => {
  item = Option.some(10)
  => item |> map((x) => x + 1)
}
```

### Tooling and LSP Integration
The Language Server Protocol (LSP) implementation supports developers when encountering ambiguous stages:
- **Hover Help:** Hovering over an ambiguous bare stage displays documentation listing all candidate companion modules and their explicit calling syntax.
- **Completions:** Autocompletion actively suggests explicit qualified alternatives (e.g., `Array.map`, `Option.map`, `Effect.map`) when typing pipeline stages.

---

## 5. Policy Summary Matrix

| Domain | Policy | Compiler / Tooling Behavior | Developer Action |
| --- | --- | --- | --- |
| **Effect Aliases** | Strict Zero-Alias | Immediate removal; synchronized with upstream Effect v4 public exports. | Use canonical Effect v4 operation names. |
| **Breaking Syntax** | Static Rejection | Parse/compile error citing canonical syntax; zero codemod rewrite risk. | Update syntax manually using compiler diagnostic guidance. |
| **Pipeline Resolution** | Type-Directed | Resolved via receiver type inference using TypeScript compilation context. | Write idiomatic pipelines with typed inputs or local bindings. |
| **Pipeline Ambiguity** | Zero Priority Fallback | `PipelineResolutionError` listing all candidate companions; no guessing. | Explicitly qualify bare stages (e.g. `Array.map`) or annotate receiver. |
| **Relational Operators** | Number-Only | Statically reject non-numeric comparisons with actionable error. | Use explicit Effect `Order` instances for string and domain types. |
| **Explicit Returns** | Explicit Invariant | Parser rejects trailing bare expressions in function and effect blocks. | Terminate multi-statement blocks with `=> returnValue`. |

---

## 6. Related Documentation

- [Language Syntax Guide](syntax.md) — Authoritative reference for implemented language syntax and rules.
- [Tooling Guide](tooling.md) — CLI commands, package scripts, and migration decisions.
- [Language Catalogue](reference/language.md) — Generated reference for hover documentation.
- [Design Survey: Compatibility Policy Options](design-compatibility-policy.md) — Historical survey leading to the TASK-102 decision.
