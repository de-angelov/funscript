# Review: FunScript architecture proposal

> **Status:** Review note, not a language contract.
> **Date:** 2026-11-06
> **Scope:** Review of the proposed priorities for generics, record forwarding, variadic
> interop, Effect channels, Redis caching, diagnostics, and the proposed feature-admission
> rule. Grounded against the local repository state on the date above.

## Verdict

The direction is right, but one architectural mistake runs through the proposal: it asks the
FunScript compiler to **infer** things that TypeScript already infers. FunScript is a
source-to-source notation with `tsc` as the only type oracle. If the proposal is implemented
literally, it will grow a second checker and violate the property that keeps the language
tractable.

Reframe the work as **preservation + delegation**. The compiler's job is mostly negative:
don't erase, don't widen, don't reject. It may parse, emit, and query `tsc`; it should not
infer or decide assignability on its own.

## 1. "Inference" is mostly a negative requirement

| Proposal ask | What actually has to happen | Who infers |
| --- | --- | --- |
| `connect<Client>` returns exact `Client` | Parse/emit `<Client extends Base>`; don't replace `Client` with `Base` | `tsc` |
| Callback return flows into `Effect` | Emit the callback signature verbatim | `tsc` |
| `Effect<A,E,R>` through `map`/`flatMap`/`gen` | Emit the calls and `Effect.gen`; preserve the channels | `tsc` |
| Imported generic types | Reference the imported symbol; don't convert it | `tsc` |
| Pino overloads/variadics | Emit the call; don't arity-check imported functions | `tsc` |
| `Record.omit` exact shape | Emit `Omit<T,K>` / `DistributiveOmit<T,K>`; don't widen | `tsc` |

The compiler should follow one rule: **parse, emit, query; never infer.** When it needs an
assignability decision, it can ask the TypeScript checker on the emitted TypeScript, as
`funscript check` already does. That keeps one type oracle and one set of semantics.

The acceptance test for each feature should be: write the target TypeScript by hand in a `ts`
block, then assert the FunScript version emits a type-identical signature. Today the `ts`
block is the oracle; the feature removes the escape, it does not add semantics.

## 2. The current compiler is further behind than the proposal assumes

Verified against the local repository:

- `TypeParameter` is name-only; there is no `extends` constraint
  (`src/ast/types.ts`).
- `parseTypeParameters` is wired only into `schema` declarations. Generic lambdas like
  `<A>(x: A) => ...` are a parse error.
- The emitter never emits type parameters. `schema Box<A> = { value: A }` emits `value: A`
  with `A` unbound. Generic **declarations** are effectively greenfield.
- `EffectTypeNode` parses its arguments with `parsePrimaryType`, so
  `Effect<A, E1 | E2, R1 | R2>` does not parse. The improved Redis signature cannot be
  written today.
- There are no qualified type names (`React.ButtonHTMLAttributes`) or `typeof` type queries
  (`ComponentProps<typeof Button>`).
- There is no value-level `Record.omit`. The existing `omit`/`pick` rewrite targets
  `Schema.Struct.omit/pick`; Effect's `Record` module has no `omit`.
- JSX spread attributes (`<Button {...props} />`) are not parsed.
- `.funx` checking injects `IntrinsicElements { [element: string]: any }` when no JSX
  namespace exists (`src/compiler/check.ts`), so JSX props are unchecked by default. The
  React acceptance test needs a real JSX type environment.

Good news: this is concrete parser/AST/emitter work, not a second type system. But
"step 3: constrained generics" is actually step 1, and it is larger than the document
implies.

## 3. `Record.omit` and prop forwarding

The exactness the proposal wants is already a TypeScript operation:

```ts
export const omit = <T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> => ...
```

`tsc` infers the exact remaining shape. The compiler only has to preserve the call and not
widen the result to `Record<string, unknown>`. It does **not** need to understand the
transformation structurally.

Two caveats:

- `Omit` is not distributive over unions. React polymorphic props are often discriminated
  unions; `Omit<Union, K>` collapses them and loses variant correlation. Use
  `DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never` in the helper's return
  type and test it with a union of props.
- `Omit` preserves optionality and `readonly` (because `Pick` is homomorphic), but it does
  not remove keys from index signatures and does not close an open object type. Decide
  whether "exact" means "known keys removed" or "no excess keys." TypeScript object types
  are open; those are different guarantees.

Drop the "verified record" qualifier. A record built from a typed value is already statically
known; structural assignability is the guarantee. Reserve "verified" for values that passed a
runtime schema decode (`Unknown` → schema). Otherwise the language grows a second type
universe and a tax on every prop forward.

The proposed diagnostic is aimed at the wrong hazard. Optionality is not the danger; unknown
keys and values are. A record with a subset of correctly typed props is assignable.
`Record<string, unknown>` is not. Write the error around provenance:

```text
Cannot spread `forwarded` into <button>.
`forwarded` has type `Record<string, unknown>`; its keys are not statically known.
Expected: ButtonHTMLAttributes<HTMLButtonElement>
Suggestion: derive it with Record.omit from a typed props value, or decode it at the boundary.
```

Requiring a schema input view to spread props would make runtime validation mandatory in a
hot path, contradicting "runtime validation only when explicitly requested."

React details matter: `ButtonHTMLAttributes` does not include `ref`; use
`ComponentPropsWithRef<"button">` or `ComponentProps<typeof Button>`. React 19 makes `ref` a
regular prop; React 18 treats it specially. `aria-label` is a hyphenated key. The repository
currently has no React dependency, and `.funx` is framework-agnostic with `jsx: Preserve` and
a fake `React.createElement`. Add a real React fixture before writing React acceptance tests,
or test the type algebra against a minimal local props interface first.

Finally, `Record.omit` should be a library/type helper, not a compiler intrinsic. The compiler
already rewrites `omit`/`pick` to `Schema.Struct`; adding a value-level `Record.omit` to the
companion catalog would make the compiler own a standard-library function. Start with a `ts`
helper; upstream it to Effect if it proves general.

## 4. Variadics and overloads

Calls to imported functions are already delegated to `tsc`; `check.ts` mostly collects
TypeScript diagnostics and does not do its own arity checking. Pino's
`logger.info("...", country, count)` should work today if the import and call parse. Add a
fixture; don't add variadic syntax.

The real issue is foreign `any`. Pino-style overloads typically end in `...args: any[]`, so
the check proves overload selection, not format-string safety. Define an `any` policy: allow
`any` in imported signatures, but treat imported `any` as `Unknown` at the FunScript
boundary, or require an explicit adapter. Otherwise `any` leaks through inference and defeats
the "no `any`" rule.

Authoring rest parameters is a separate question. Defer it; call-site interop does not need
it.

## 5. Effect

Effect is already first-class at the type level: `Effect<A,E,R>` lowers to
`Effect.Effect<A,E,R>`, and `effect { ... }` lowers to `Effect.gen`. The compiler does not
need a semantic model of the three channels. `tsc` does it. Don't special-case
`map`/`flatMap`/`gen`.

The hard part is subtraction, not inference: `Effect.provide` removes services from `R`
(`Exclude<R, ROut>`), and `catchTag` removes errors from `E`. Effect's declarations encode
this. If FunScript ever synthesizes `provide` or layer wiring, it must preserve the result
type, not recompute it.

`Effect.gen` inference is a property of Effect's `gen` signature, not a FunScript feature.
Keep the lowering; don't add channel-specific rules.

Deferring higher-kinded types is fine for the surface, but check that imported
`TypeLambda`/type-class types can be referenced. `Effect.all` and `traverse` do not require
you to author HKT; they require you not to block it.

## 6. Redis: the example is a soundness test, not just an inference test

The signature is under-specified. `factory: () => Client` is a thunk, not an Effect, and
`Effect<Client, RedisError>` has `R = never`. If the factory can fail or needs config, the
target should be:

```ts
const connect = <Client extends RedisConnectableClient, E, R>(
  factory: () => Effect.Effect<Client, E, R>,
): Effect.Effect<Client, E | RedisError, R | RedisConfig> => ...
```

That actually tests callback-return and channel inference. The current example tests only
generic thunk inference.

The shared-cache requirement conflicts with exact `Client`:

- A module-level cache is monomorphic. If it stores `Effect<RedisConnectableClient>`,
  returning `Effect<Client>` is unsound because `Effect` is covariant in success:
  `Effect<Base>` is not an `Effect<Sub>`. A cast would be a lie, not a widening.
- If `connect` creates a fresh `Effect.cached` per call, callers do not share across call
  sites.
- If `connect` returns the memoized inner effect, the type is
  `Effect<Effect<Client, E, R>>`, not `Effect<Client, E, R>`.

Options: (a) a `Layer`/service per client type, using the layer's memoization for sharing and
`Scope` for lifecycle; (b) a hoisted `Effect.cached` at the call site, returning
`Effect<Effect<Client, ...>>`; (c) a keyed `Cache`/`ScopedCache` with a typed key and an
existential value plus a typed accessor (requires a cast or a dependent key); (d) return the
base interface. Recommend (a) for the shared connection and (b) for the low-level constructor.

Caching semantics also need correction. In the pinned Effect 4.1.1 source, `Effect.cached`
stores any non-interrupt exit, **including failures**, with an infinite TTL. Verified: a
failing effect evaluated twice through `cached` executes once. That directly contradicts
"failures clear the cached in-flight state so later callers can retry."

Use `cachedWithTTL` with an exit-dependent TTL:

```ts
const cached = yield* Effect.cachedWithTTL(connect, (exit) =>
  Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
);
```

Verified: this gives one execution on success and a fresh attempt after failure. Or use
`cachedInvalidateWithTTL` and invalidate explicitly.

Lifecycle: `Effect.cached` has no finalizer or `Scope`; a cached Redis connection never
closes. Use `Layer.scoped` + `acquireRelease` or `ScopedCache` if shutdown and test isolation
matter. They do.

Also distinguish failure to **acquire** the connection from failure while **using** it. The
former should clear the cache; the latter should not necessarily discard a healthy client.
Interruption is never cached; define what waiters see when the first caller is interrupted.
Defects should not poison the cache.

Because FunScript bans top-level `mut`, the cache must be a service or layer. That is a
feature: it forces the right design. The API should be a `Redis` service or `RedisLive` layer,
not a free `connect` with hidden global state.

A real acceptance test should assert: exact `Client` (not `RedisConnectableClient`), `E`
union, `R` union, single-flight under concurrent callers, retry after a failed connect, no
retry after interruption, and close on scope exit.

## 7. Diagnostics: source maps do not fix `tsc`

Source maps help stack traces and editor navigation. They do **not** remap `tsc` CLI
diagnostics. Plain `tsc` sees generated `.ts` files and reports generated paths. Only a
diagnostic interceptor (as `funscript check` does) or a TypeScript plugin can remap. Decide
whether plain `tsc` is a supported workflow. If yes, you need a plugin or wrapper; if no, say
so and make `funscript check`/LSP the supported path. That also explains the
stale-generated-view and custom-`outDir` issues: they are artifacts of the on-disk workflow,
not the in-memory checker.

Attach provenance to emitted nodes — file, span, kind — not just VLQ mappings. The mapper
should prefer the nearest origin for synthesized nodes (`pipe`, `Effect.gen`, type aliases,
schema constructors). Curate a small set of custom diagnostics keyed by TypeScript error code
plus AST pattern, with fallback to the original TS message. Don't rewrite all errors; TS
message changes will break you.

Watch/cache invalidation is a build-system track: content hashes, compiler-option/version
invalidation, dependency graph. It is not a language feature.

## 8. Roadmap and the decision rule

The roadmap should start with foundations, not generics:

0. Type-conformance harness and diagnostic provenance.
1. Schema semantics (input/decoded views, optionality, unknown keys, literal unions, decoder
   generation).
2. Generic preservation: AST constraints, parser `extends`, emitter output, generic lambdas,
   function-type params, union types inside type arguments.
3. Interop delegation: imported signatures, foreign `any` policy, overload/variadic fixtures,
   JSX type environment and spread attributes.
4. Record algebra: `Omit`/`DistributiveOmit`, union props, optional/readonly preservation,
   negative tests.
5. Effect/Redis layer spike.
6. Migration and tooling.

Diagnostics should be continuous from step 0, not step 5.

Two internal contradictions should be resolved explicitly:

- The document says "no reimplementation of the TypeScript checker," but "build the interop
  type layer" and "infer through Effect's channels" read like one. State the boundary:
  **parse, emit, query; never infer.**
- The document says diagnostics before syntax, but the roadmap puts diagnostics last. Move it
  earlier.

The decision rule also needs a third clause. As written, "a semantic guarantee TypeScript
cannot provide, or substantial FP simplification" would reject variadic interop and imported
overloads, which the proposal explicitly wants. Amend it:

> A new surface feature must (1) provide a static guarantee `tsc` cannot, (2) remove measured
> ceremony from real programs, or (3) preserve a foreign signature/semantic users depend on.
> It must name its owner, acceptance test, cost, and exit path. If a library function or
> type-only helper can do it, it must be one.

Apply that rule to the roadmap: "build an interop type layer" fails clauses 1 and 2;
"preserve imported signatures" passes clause 3. The distinction should be explicit.

A few table entries also need scoping to avoid reversing existing decisions:

- "Mutable variables: No" → no **shared/module-level** mutable variables; local `mut` is
  explicit and scoped.
- "Automatic `_tag` injection: No" → no `_tag` in arbitrary records; tagged unions still use
  `Data.TaggedEnum`.
- "Full TypeScript conditional-type syntax: No" → no **authoring**; emit and reference
  conditional/mapped types internally. `Omit` and `Exclude` already require this.
- "General-purpose type aliases for data: Prefer schemas" → runtime-representable data uses
  schemas; static-only types (functions, generics, imported types) use type aliases or `ts`.

## Bottom line

The instincts are good: immutable records, no rest syntax, variadic calls as interop, Effect
as a semantic type, interop guarantees, diagnostic investment. The disagreement is about
**where the work lives**.

Rewrite the proposal around one sentence: *FunScript preserves TypeScript's types and
delegates inference to `tsc`; its own work is syntax, provenance, and diagnostics.* That
shrinks the roadmap, removes the second-checker risk, and turns the Redis example from an
inference feature into a design probe — which is exactly what it should be.

## Verification notes

The repository-specific claims above were checked against the local checkout:

- `src/ast/types.ts` — `TypeParameter` has only `name`; no constraint field.
- `src/parser/parser.ts` — `parseTypeParameters` is called from schema declarations only;
  generic lambdas and function-type type parameters are not parsed.
- `src/emitter/emitter.ts` — no `typeParams` emission; `omit`/`pick` pipeline rewriting
  targets `Schema.Struct`.
- `src/compiler/check.ts` — default JSX intrinsics inject
  `[element: string]: any`; `jsx: Preserve`.
- Effect `4.1.1` — `Effect.cached` caches non-interrupt failures (verified at runtime);
  `cachedWithTTL` with an exit-dependent TTL gives success-forever/failure-retry.
