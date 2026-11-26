---
title: Compatibility
description: FunScript's Strict Zero-Alias compatibility policy, pre-1.0 guarantees, breaking syntax rules, pipeline ambiguity diagnostics, and how to migrate.
---

FunScript follows a **Strict Zero-Alias Policy**. Because the project is in active pre-1.0 development (`0.1.x`) with no external production consumers, obsolete constructs, historical shims, and ambiguous heuristics are rejected immediately instead of being carried through long deprecation windows or hidden behind edition flags.

## Policy at a glance

| Area                 | Policy                 | What the compiler does                                      | What you do                                              |
| -------------------- | ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| Effect aliases       | Strict zero-alias      | Removes obsolete aliases; tracks upstream Effect v4 exports | Use canonical Effect v4 names                            |
| Breaking syntax      | Static rejection       | Parse/compile error citing canonical syntax                 | Update code manually using the diagnostic                |
| Pipeline resolution  | Type-directed          | Resolves bare stages from the receiver's inferred type      | Type your pipeline inputs or bind them locally           |
| Pipeline ambiguity   | Zero priority fallback | `PipelineResolutionError` listing every candidate companion | Qualify the stage (`Array.map`) or annotate the receiver |
| Relational operators | Number-only            | Rejects non-numeric comparisons                             | Use Effect `Order` for strings and domain types          |
| Explicit returns     | Explicit invariant     | Rejects trailing bare expressions in blocks                 | End multi-statement blocks with `=> value`               |

## Pre-1.0 guarantees

- Language syntax, the typechecker, the compiler, and standard library bindings evolve rapidly.
- Documented language features are stable within a minor release, but breaking changes may land **across** minor versions (for example `0.1.0` to `0.2.0`) to fix design defects, improve type safety, or sync with Effect.
- No transitional wrappers, compatibility flags, or multi-release shims are maintained for obsolete constructs.

## Effect aliases

Companion modules (`Array`, `Chunk`, `Duration`, `Effect`, `Layer`, `Option`, `Result`, `Schedule`, `Schema`, `Stream`, `String`, `Struct`) are imported directly from `"effect"`. When upstream Effect renames an export, FunScript adopts the new name immediately and drops the old one without a grace period.

```funscript
# Obsolete (rejected)
export recover = task |> catchAll((err) => Effect.succeed("fallback"))

# Canonical Effect v4
export recover = task |> catch((err) => Effect.succeed("fallback"))
```

The same applies to fiber forking: use `forkChild`, not `fork`.

## Breaking syntax rules

### Explicit returns

Multi-statement function blocks and `effect` blocks must end with an explicit `=> value`. A trailing bare expression is a parse error.

```funscript
# Rejected: Function block must end with an explicit '=> returnValue'
sum = (a: Number, b: Number) => {
  a + b
}

# Canonical
sum = (a: Number, b: Number) => {
  => a + b
}
```

Single-expression lambdas such as `(a, b) => a + b` are unaffected.

### Numeric-only relational operators

`<`, `<=`, `>`, and `>=` only accept proven numeric operands. Comparing strings, records, or domain types is rejected; use Effect `Order` instead.

```funscript
# Rejected: Operator '<' cannot be applied to types 'string' and 'string'
isEarlier = (a: String, b: String) => a < b

# Canonical
import { Order, String } from "effect"
isEarlier = (a: String, b: String) => Order.lessThan(String.Order)(a, b)
```

### Value equality vs. reference identity

Use `#=` and `#!` for structural value equality (compiled to `Equal.equals`). Use `@=` for reference identity, and only on non-primitive reference types.

```funscript
# Rejected: Reference identity '@=' cannot be used with primitive values
isSame = (a: Number, b: Number) => a @= b

# Canonical
isSame = (a: Number, b: Number) => a #= b
```

## Pipeline resolution and ambiguity

Bare pipeline stages resolve to companion module methods based on the inferred type of the receiver. The compiler never defaults to `Array` or `Effect` just because they are common: every catalog entry competes on equal footing.

```funscript
# Source: receiver is a proven array
export incremented = [1, 2, 3] |> map((x) => x + 1)

# Emitted TypeScript
export const incremented = Array.map([1, 2, 3], (x) => (x + 1));
```

When the receiver is unproven (`any`, `unknown`, or a diverging union), the bare stage is ambiguous and the compiler raises a `PipelineResolutionError`:

```
map is ambiguous for this pipeline; write Array.map(...) or Option.map(...) or Result.map(...) or ...
```

Resolve it in one of two ways:

```funscript
# A. Explicit companion qualification (recommended)
export processArray = (data) => data |> Array.map((x) => x + 1)

# B. Prove the receiver type
export processArray = (data: Array<Number>) => data |> map((x) => x + 1)

export processOption = () => {
  item = Option.some(10)
  => item |> map((x) => x + 1)
}
```

The LSP helps here: hover over an ambiguous stage lists the candidate companions, and completions suggest explicit qualified forms.

## Migration guidance

There is no automated migration command. Unattended CLI codemods were declined because they risk silent semantic corruption. Migrate by hand, letting the compiler diagnostics drive each change:

1. Run `funscript check` and read each diagnostic; it cites the canonical replacement.
2. Replace obsolete Effect aliases with their Effect v4 names (`catchAll` → `catch`, `fork` → `forkChild`).
3. Add `=> value` to the end of multi-statement function and `effect` blocks.
4. Rewrite string or domain comparisons with the matching Effect `Order` instance.
5. Switch primitive comparisons from `@=` to `#=`.
6. Qualify ambiguous pipeline stages (for example `Array.map`) or annotate receiver types.
7. Re-run `funscript check` and `funscript fmt --check` until clean.

## Related documentation

- [Syntax](/guides/syntax/) — canonical authoring reference.
- [Tooling](/guides/tooling/) — CLI commands and workflow.
- `docs/compatibility.md` in the repository — full policy text and rationale.
