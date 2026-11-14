# Interop ergonomics: Country Rank 2 design exercise

**Status: proposal, not implemented language syntax or a compatibility promise.**
Examples below describe a possible target. The current compiler contract remains
[syntax.md](syntax.md); current optional-argument behavior is in
[optional-arguments.md](optional-arguments.md). The examples are based on
`de-angelov/country-rank2` at `e98d74b` and FunScript at `58416b1`.

## Goal and boundary

Make routine TypeScript integration feel ordinary while keeping the difference between
static types, untrusted data, and actual runtime validation visible. Prefer one clear
representation at each boundary over additional special cases. A successful design
must be teachable without explaining compiler provenance or declaration metadata.

## 1. Forwarding optional inputs

In `app/routes/top-liked/top-liked.server.fun`, `loadTopLikedRouteData` rebuilds an
options object and calls `Option.getOrUndefined` on four fields. In
`app/countries/redis-totals.server.fun`, forwarding an optional argument requires the
same conversion. Whole-record forwarding to verified FunScript targets already works
in some cases; it must not be described as universally unsupported.

Desired call-site shape, assuming matching compatible contracts:

```funscript
export loadTopLikedRouteData = (options: TopLikedOptions) =>
  mapped = countryReader.readTopLikedCountries(options) |> Effect.map(wrapTopLikedCountries)
  => Effect.runPromise(mapped)
```

For forwarding a single optional parameter, the candidate is `resolveOptions(options)`
when `options` originates from an optional parameter and the destination is a statically
resolved optional parameter of the same input type. This is **not** a general implicit
conversion from an arbitrary `Option<T>`: it must not reinterpret a domain Option,
`Unknown`, or `Some(None)`. Provenance through aliases, higher-order functions,
overloads and generic calls needs a design and evidence before acceptance. If this
cannot be made predictable, retain an explicit conversion rather than guessing.

Acceptance cases:

- Omitted, `undefined`, false, zero, empty string and `null` preserve current behavior;
  `null` is a supplied value only when permitted by the declared type.
- `Option<T>` passed as a value and `Option<Option<T>>` remain values; no accidental
  unwrap or silent change to the existing `Unknown` behavior.
- Record forwarding preserves the original object and its missing-versus-present keys;
  it neither evaluates defaults again nor changes identity. For defaulted records or
  transformations where this cannot be guaranteed, reject with a precise remedy.
- Named, namespace, re-exported and package-declaration targets have the same semantics
  when provable. Ambiguous, external or dynamically resolved targets produce a diagnostic
  rather than a conversion based on a guess. Callback, container and union cases are
  explicitly covered rather than silently widened.
- Side effects and getters are evaluated exactly once; emitted JavaScript, React props,
  type errors and source-mapped diagnostics are regression-tested.

Open decision: provenance-based conversion adds a hidden rule. Compare it with an
explicit, concise conversion operation and with changing the internal representation;
choose only after prototyping all three against this application. Changing existing
calls that currently compile with different behavior requires the compatibility policy,
a targeted diagnostic and a migration plan, not a silent semantic shift.

## 2. Redis: errors and data are separate boundaries

`app/lib/redis.server.fun` wraps `client.connect()` with `Effect.tryPromise` and maps
the error; `app/countries/redis-totals.server.fun` handles failure with a fallback.
An ergonomic candidate for the connection part uses the existing `js` boundary:

```funscript
connectClient = (config: RedisConfig) =>
  effect {
    client <- Effect.try(() => options.clientFactory(config))
    _ <- js client.connect()
    => client
  } |> Effect.mapError(toConnectionError)
```

This is a proposed app simplification to verify, not evidence that the existing adapter
is incorrect. Connection failures must still map to the application's declared error.
A successful connection does not validate data subsequently read from Redis. For a
value expected to conform to a domain schema, the intended flow is explicitly:

```funscript
raw <- js client.get(key)
value <- Schema.decodeUnknownEffect(VoteTotals)(raw)
```

This sketch requires verification against the installed Effect API and the actual Redis
wire format: a Redis string may need JSON parsing before schema decoding. Nullable
results from `js` may be wrapped in `Option`, which must be handled before decoding.
No implicit trust in a TypeScript declaration, no automatic JSON parsing, and no silent
conversion of schema failures into connection failures are assumed.

Acceptance cases: synchronous throw, rejected Promise, absent key, malformed JSON,
schema-invalid data and valid data each have distinct, documented behavior; errors
retain useful causes; no external service is needed for tests. Add a real-package
integration test and a small application-level example before calling the syntax verified.
Services and Layers remain useful for shared dependencies; a one-off integration should
not require them merely to call and validate a foreign API.

## 3. Reusable React props contracts

`RankingOrderControlsProps` in
`app/components/ranking-order-controls/ranking-order-controls.funx` is written as a
`schema`, but its callback field makes it a compile-time contract with no decoder.
The nearby `TopDisliked` props are an inline optional record. A proposed explicit form:

```funscript
export contract RankingOrderControlsProps = {
  order?: RankingOrder
  currentOrder?: RankingOrder
  onOrderChange?: (order: RankingOrder) => Void
}

export RankingOrderControls = (props: RankingOrderControlsProps) =>
  # Optional reads remain Option values under the current model.
  # ...
```

`contract` is illustrative new syntax. It describes a TypeScript-compatible shape,
produces no runtime validator and supports callback-free props equally. A data `schema`
continues to mean a runtime schema and decoder; unsupported function fields must yield
an actionable error instead of silently changing the whole declaration's meaning.
Interop with React must retain ordinary JS optional props and type-check callbacks.

Acceptance cases: export/import and declaration emission across packages; callback-free
and callback-containing props; inline and named forms; React JSX attributes and safe
spreads; optional callback type mismatch; `null` versus missing; and attempted decoder
use on a contract. Verify JS consumers receive ordinary props and that declaration
metadata survives supported tooling. Do not assume `contract` validates JS input.

This changes the meaning of existing callback-containing `schema` declarations. Before
implementation, inventory usages and issue a specific diagnostic pointing to the new
form under the project's pre-1.0 compatibility policy; no silent behavior change or
indefinite alias is proposed.

## Decision sequence

1. Write runnable fixtures from the three app cases and record current output and errors.
2. Prototype alternatives for optional forwarding, including the ambiguity cases above;
   select only if the rule is predictable and preserves the current safety guarantees.
3. Decide explicit contract syntax and migration, then implement parser, type checking,
   emit, formatting, LSP, docs and package-declaration tests together.
4. Try the Redis sketch against real declarations and invalid inputs; adopt only a
   shorter idiom that retains distinct error and validation behavior.
5. Run the compiler suite and Country Rank 2 typecheck, tests, build and idiomatic check
   with a freshly packed compiler. Record the compiler commit and compare generated
   JavaScript and user-facing diagnostics. Until then this document is design input,
   not a claim that these gaps are fixed.

## Follow-up: callback boundary prototype

The user subsequently proposed runtime guarantees for callbacks at untrusted edges.
This supersedes the assumption above that callbacks must always be separated into a
`contract`; the declaration syntax and migration decision remain open. The executable
[prototype](prototypes/callback-boundary.mjs) explores one direction: a foreign
callback receives an encoded value and returns an encoded value; FunScript callers
use decoded values. Run it from the repository root with:

```sh
node docs/prototypes/callback-boundary.mjs
```

Using Effect 4.1.2, the prototype checks callable input, encodes a transformed
argument, calls the foreign function and decodes its result. It checks that invalid
arguments do not invoke the callback, invalid results fail, receiver `this` is passed
through, and callback identity changes. The Effect-returning version defers the
callback until the Effect runs, retains the original failure, and adds boundary errors
for encoding, invocation and result decoding. Tests use `FiniteFromString` to ensure
that encoding and decoding are not accidentally reversed.

This is an isolated JavaScript experiment, not generated compiler output, a React
integration, or a complete schema codec. Its sync callback preserves thrown exceptions;
its Effect version maps invocation throws to a boundary error. That difference is a
prototype choice, not an adopted language rule. It also does not address the opposite
boundary direction, method ownership, rest and multiple arguments, schema services,
Promise callbacks, serialization, or JSON. A React `Void` callback normally permits
any JavaScript return value that is ignored; requiring a particular return would break
that convention. DOM events and methods may not have serializable schemas. A wrapped
callback passed to add/remove listeners must have stable identity for the same boundary
and lifetime, and a wrapper can change observable identity even if cached.

Before implementing, prototype actual React props and an Effect-returning service on
both sides of the edge. Specify whether `User` means a decoded domain value or its
encoded JavaScript representation, and verify encoding direction for transformed and
optional schemas. Define thrown errors, Effect defects and typed error unions separately;
never silently add a possible failure to an unchanged callback type. Explicitly choose
whether decoding a callback schema always wraps or whether an explicit boundary operation
opts in. Migration must account for existing callback-containing schemas that currently
produce type-only contracts, and must not silently change their runtime representation.

## Dogfooding: vote callback with current compiler

[`examples/fixtures/vote-callback-boundary.fun`](../examples/fixtures/vote-callback-boundary.fun)
models Country Rank 2's vote request and totals with one schema per data shape. A
statically typed foreign Effect callback returns an untrusted result; `checkedEffect`
encodes the request, invokes the callback lazily and decodes its result. The example
maps both storage and boundary failures once into `VoteError`, preserving the original
failure in `cause`; ordinary callers use the resulting `VoteHandler`. It is an isolated
fixture inspired by the app, not a modification or end-to-end test of its vote route.

The fixture shows the remaining boilerplate: `VoteHandler` is still a type-only contract,
so it has no generated decoder; the user must repeat the callback input and return
shape in `createVoteHandler`, assemble `Schema.Tuple([VoteRequest])`, call
`checkedEffect`, and provide the error mapping. The callback itself is statically typed:
its error and Effect service requirements are trusted, not validated from an arbitrary
unknown JavaScript value. The helper does not authenticate or validate storage behavior.

A candidate generated boundary could derive the tuple and result schemas from the callback
signature and ask for the mapping once, but must expose its actual error and service
requirements and distinguish schema-decode failure from later callback failure. The exact
syntax is still a design sketch. In particular, mapping every error into a new `VoteError`
as this fixture does wraps existing domain errors too; a production helper should let the
caller decide whether to preserve or transform them. Runtime `VoteHandler` generation,
identity, synchronous callback error semantics and migration of existing contracts remain
unimplemented.
