# Omittable React interop experiment

This branch tests `Omittable<T>` as an additional declaration spelling for the existing `?` behavior. It is a prototype, not a replacement or compatibility decision. See `examples/omittable-experiment/ranking-controls.funx` for a small React example based on Country Rank2.

`Omittable<T>` works on value parameters, inline record fields and schema fields. The compiler lowers it to the existing optional AST representation, and the formatter retains the new spelling. Existing `?` remains accepted. Existing type-directed Option forwarding is unchanged; this experiment does not yet enforce explicit outgoing conversion.

`optionalProperties` from `funscript/record` builds a record from a record of Options. None omits a property; Some includes its payload, including null or undefined. Existing `optionalProperty` and `propertyPresence` remain available. Effect's Option conversion functions can convert JS nullish values.

Semantics follow existing constructs rather than defining a new uniform contract: optional function arguments normalize omitted and undefined to None and preserve null; inline record reads and schema fields currently normalize missing, undefined, and null to None. The existing inline-record test expects Some(null), so there is a pre-existing test/implementation disagreement. Schemas must be explicitly decoded. This is a material design decision to revisit before adopting the spelling.

The prototype does not implement NullOr/UndefinedOr syntax, special constructors, strict property-presence contracts, or a prohibition on implicit forwarding. React render identity and hook dependency behavior need separate evaluation. Generic/function type positions and editor tooling have not been fully evaluated.

The batch helper currently needs a local binding before spreading into JSX: direct use in JSX causes TypeScript contextual inference to infer the full HTML prop set.
