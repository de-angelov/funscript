# Optional arguments and Effect Option

For a raw JavaScript value where `null` and `undefined` must be handled
separately, use `JSNullish<T>` and its `Success`, `Failure(Null)`, and
`Failure(Undefined)` match patterns; see [Matching JavaScript nullish values](syntax.md#matching-javascript-nullish-values).
`JSNullish<T>` emits `T | null | undefined`, not a tagged Effect `Result`.

Use `?` when omission matters, a default when the callee should always receive
one concrete value, and `Option<T>` when absence is itself a value in the domain.

```funscript
import { Option } from "effect"

// Omitted or undefined input is None; a supplied string is Some(string).
export inspect = (name?: String) => name

// Missing input is replaced at the call boundary. The body sees a Number.
export pageSize = (size: Number = 20) => size

// The caller must provide an Option, and the body sees it unchanged.
export useNickname = (nickname: Option<String>) => nickname

// Omission and an explicitly supplied None are distinct.
export inspectNickname = (nickname?: Option<String>) => nickname

// An Option<String> can be forwarded to an optional String parameter.
export forwardName = (name?: String) => inspect(name)
```

`inspectNickname()` produces `None`, `inspectNickname(Option.some(Option.none()))`
produces `Some(None)`, and `inspectNickname(Option.some(Option.some("Ada")))`
produces `Some(Some("Ada"))` in FunScript. JavaScript callers continue to pass
the inner Option directly. A bare Option passed to an optional `Unknown` or
`Option<T>` parameter can mean either a value or a forwarded argument, and is
rejected as ambiguous. Use `Option.getOrUndefined(value)` to forward explicitly,
or `Option.some(value)` to pass the Option itself as the supplied value.
Forwarding maps `None` to `undefined`.
Automatic parameter forwarding is rejected when the Option may contain
`undefined`, because it would also turn `Some(undefined)` into `None`. Use an
explicit normalization such as `Option.getOrUndefined(value)` when that loss
is intentional, or use a presence-preserving record boundary.

Optional arguments and defaults recognize `undefined`, not `null`. They do not
validate values from JavaScript. Use an Effect Schema decoder at untrusted
boundaries. Default expressions run when the function is called, which can be
before a returned Effect is executed. Optional schema fields become Options
when decoded; `SchemaInput<...>` alone does not perform that decoding.

For a statically known optional JavaScript record field or JSX attribute, an
`Option<T>` can be forwarded directly. The compiler omits the property for
`None` and includes it for `Some(value)`. Ambiguous optional payloads, such as
`Unknown` or `Option<T>`, require an explicit choice.

For an explicit boundary conversion, `optionalProperty` builds a spreadable
record from an Option. `None` omits the property;
`Some(value)` includes it, even when the value is `undefined`.

```funscript
import { optionalProperty } from "funscript/record"

export View = (label?: String) =>
  <Target {...optionalProperty("label", label)} />
```

This helper does not validate the value or convert nested records. Automatic
conversion of entire JSX spreads and construction of decoded schema records
from plain optional field values are not supported.

To preserve the distinction between a missing JavaScript property and a present
property containing `undefined`, use `propertyPresence` from `funscript/record`.
It returns `None` for a missing own property and `Some(value)` for a present one,
including `Some(undefined)` or `Some(null)`. Combine it with `optionalProperty`
for a presence-preserving round trip. It reads a present property once and does
not validate its value; validate untrusted inputs with a schema first.

Ordinary FunScript `?` parameters still convert an omitted or `undefined`
argument to `None`. JavaScript-shaped record parameter fields currently also
collapse missing and `undefined`. Optional schema fields preserve the
distinction: a missing field becomes `None`, while a present `undefined` field
becomes `Some(undefined)`.

When the application intentionally treats both states as absent, normalize
the decoded field once with Effect's existing combinators:

```funscript
normalized = Option.flatMap(props.label, Option.fromUndefinedOr)
```

This converts `Some(undefined)` to `None` while leaving `null` distinct if the
schema permits it.
