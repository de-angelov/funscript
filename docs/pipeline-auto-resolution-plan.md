# Pipeline Auto-Resolution Plan

## Goal

Allow bare pipeline stages to resolve to the appropriate Effect ecosystem module whenever that resolution is unique or can be proven from TypeScript types. Support the complete pipeline-compatible API surface rather than maintaining small hand-written subsets.

Examples:

```funscript
Effect.succeed(1)
|> map((value) => value + 1) // Effect.map

[1, 2]
|> map((value) => value + 1) // Array.map
```

## Locked language rule

If more than one supported companion module exposes a pipeline operation with the same name, and the compiler cannot prove the input module, compilation must fail with an actionable diagnostic. The user must write an explicit namespace such as `Array.map(...)` or `Effect.map(...)`.

There is no priority fallback for ambiguous names. This prevents a future API addition from silently changing program meaning.

## Current state

- `Effect.*`, `effect { ... }`, and `js` pipeline sources establish an Effect context.
- Within that context, the emitter auto-resolves the currently catalogued Effect operations, including collisions such as `map`, `flatMap`, `zip`, and `flatten`.
- Existing non-Effect resolution still has legacy priority behavior. Replacing it with the rule above is the next compatibility change.

## Decision map

## #1: Define the supported companion-module catalog

Blocked by: none

Status: open

Type: Research

### Question

Which Effect packages participate in automatic resolution, and which exports are valid pipeline stages?

### Answer

Build a catalog from the installed Effect `.d.ts` files. Include only exports that accept the piped module value as their first argument or offer a data-last overload. Initially cover `Array`, `Option`, `Result`, `Either`, `Chunk`, and `Effect`; then evaluate `Schedule`, `Layer`, `Stream`, `Schema`, and other domain modules separately. Exclude constructors, runners, predicates that do not transform the piped value, and unsafe/internal APIs.

The catalog must be generated or verified in tests against the installed Effect version, so upgrades cannot silently leave operations unsupported.

## #2: Replace priority lookup with resolution outcomes

Blocked by: #1

Status: open

Type: Prototype

### Question

How should the emitter choose a namespace without changing the meaning of existing pipelines?

### Answer

Introduce a resolver that returns one of:

- `resolved(module, operation)` when exactly one supported module matches;
- `resolved(module, operation)` when source syntax or inferred TypeScript type proves the module;
- `ambiguous(candidates)` when more than one module matches and the module cannot be proven;
- `unresolved` for ordinary user-defined functions.

An `ambiguous` result is a compiler diagnostic with explicit alternatives, for example: `map is ambiguous for this pipeline; write Array.map(...) or Effect.map(...)`.

## #3: Add TypeScript-directed pipeline inference

Blocked by: #2

Status: open

Type: Prototype

### Question

How can `task |> map(...)` resolve when `task` is an identifier, imported value, or function result rather than an obvious `Effect.*` expression?

### Answer

Use the existing TypeScript checker integration to inspect the type of each pipeline source before final namespace selection. Map known container types to their companion module. Cache the checker/program per compilation for CLI and LSP responsiveness. If the type is `any`, `unknown`, a union across supported modules, or cannot be identified, report ambiguity instead of guessing.

## #4: Roll out modules in compatibility-safe phases

Blocked by: #1, #2, #3

Status: open

Type: Research

### Question

What order controls scope and regression risk?

### Answer

1. Replace legacy priority fallback with explicit ambiguity diagnostics for current modules.
2. Complete `Array`, `Option`, `Result`, `Either`, and `Chunk` catalogs and tests.
3. Complete `Effect` catalog and compatibility aliases.
4. Add `Schedule`, `Layer`, `Stream`, and `Schema` only after independently documenting their pipeline semantics and collisions.

## #5: Verification and tooling behavior

Blocked by: #2, #3, #4

Status: open

Type: Prototype

### Question

What prevents regressions and makes the rule discoverable?

### Answer

Add compiler and type-check tests for every catalogued operation, every collision class, explicit namespaces, inferred local/imported bindings, unknown values, and diagnostics. Add LSP completion/hover guidance showing the explicit alternatives. Add a catalog-versus-installed-Effect API verification test and compilation performance coverage.

## Handoff

Start with ticket #1. Its output should be a machine-readable, version-checked catalog design and a short list of modules intentionally excluded from the first rollout. Do not expand Array alone before ticket #2 removes priority fallback; otherwise the language rule remains inconsistent.
