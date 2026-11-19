# Omittable and nullish interop experiment

This branch tests `Omittable<T>` as an additional declaration spelling for the existing `?` behavior. It is a prototype, not a replacement or compatibility decision. The React and patch examples under `examples/omittable-experiment/` demonstrate props and presence-preserving updates.

`Omittable<T>` works on value parameters, inline record fields and schema fields. The compiler lowers it to the existing optional AST representation, and the formatter retains the new spelling. Existing `?` and type-directed Option forwarding remain available; explicit outgoing conversion is not yet enforced.

`NullOr<T>` and `UndefinedOr<T>` describe JavaScript value unions, including in runtime schema fields. They are erased to TypeScript unions and lower to the corresponding Effect schema constructors in schema fields. Effect's `Option.fromNullOr`, `Option.fromUndefinedOr`, `Option.fromNullishOr`, `Option.getOrNull`, and `Option.getOrUndefined` explicitly normalize or construct nullable values. These functions do not validate untrusted data.

The `funscript/interop` module provides `nullValue()` and `undefinedValue()` for explicitly constructing JS values, plus `optionalProperty`, `optionalProperties` and `propertyPresence`. `optionalProperties` builds a record from a record of Options: None omits a property; Some includes its payload, including null or undefined. `propertyPresence` checks own property presence and preserves a present nullish value. Direct JSX spreads of `optionalProperties` are supported.

Semantics follow existing constructs rather than defining a new uniform contract: optional function arguments normalize omitted and undefined to None and preserve null; inline record reads and schema fields currently normalize missing, undefined, and null to None. The existing inline-record test expects Some(null), so there is a pre-existing test/implementation disagreement. In particular, `Omittable<NullOr<T>>` currently does not guarantee preservation of Some(null) for inline records or schema fields: use a presence-preserving raw interop boundary where that distinction matters. Schemas must be explicitly decoded.

This prototype does not implement strict property-presence contracts, remove `?`, or prohibit implicit forwarding. React render identity and hook dependency behavior need separate evaluation. Generic/function type positions and editor tooling have not been fully evaluated.
