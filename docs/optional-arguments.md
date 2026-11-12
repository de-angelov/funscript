# Optional arguments and Effect Option

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

// Optional parameters are Options inside the function. Unwrap the outer Option
// explicitly before forwarding to a function with an optional parameter.
export forwardName = (name?: String) => inspect(Option.getOrUndefined(name))
```

`inspectNickname()` produces `None`, `inspectNickname(Option.none())` produces
`Some(None)`, and `inspectNickname(Option.some("Ada"))` produces
`Some(Some("Ada"))`. These rules also apply when the input type is `Unknown`:
an Option object supplied as the value is wrapped like any other value.

This changes the previous implicit forwarding behavior. Replace calls such as
`inspect(name)` where `name` is an `Option<String>` with
`inspect(Option.getOrUndefined(name))`. For `Unknown` parameters, TypeScript
cannot detect every affected call, so review direct Option forwarding manually.
The conversion maps `None` to `undefined`; use a domain-specific mapping if
`undefined` is itself a meaningful value.

Optional arguments and defaults recognize `undefined`, not `null`. They do not
validate values from JavaScript. Use an Effect Schema decoder at untrusted
boundaries. Default expressions run when the function is called, which can be
before a returned Effect is executed. Optional schema fields become Options
when decoded; `SchemaInput<...>` alone does not perform that decoding.
