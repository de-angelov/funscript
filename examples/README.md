# Examples

These files demonstrate current canonical FunScript syntax. Functions, function types,
and match arms use `=>`; effects use `effect` blocks and services use Effect layers.
Treat [docs/syntax.md](../docs/syntax.md) as the source of truth when writing new code.

| File                    | Shows                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `hello.fun`             | bindings, interpolation, pipelines, an Effect entry point                      |
| `shapes.fun`            | tagged-union `schema`, guards, exhaustive `match`                              |
| `todo-http.fun`         | `effect` blocks, `schema`, retry, layer provision                              |
| `greeter-service.fun`   | services, layers, dependency injection                                         |
| `order-fulfillment.fun` | end-to-end showcase: Effect (concurrency, retry, layers), ts-pattern, Mutative |

The four focused showcases cover the language's core forms: `hello.fun` introduces
bindings and pipelines, `shapes.fun` demonstrates tagged unions and exhaustive matches,
`todo-http.fun` shows schema-validated HTTP effects, and `greeter-service.fun` shows
services and layer-based dependency injection.

The current compiler dependencies are Effect 3.x, ts-pattern 5.x, and TypeScript
5.6+. Static checking gates `run` and `build`; external inputs still require
runtime Schema decoding. See [the strictness contract](../docs/syntax.md#123-static-guarantees-and-runtime-boundaries).

To inspect current syntax and behavior:

```sh
funscript --help
funscript check examples/shapes.fun
funscript fmt examples/shapes.fun --check
```

`funscript check` checks emitted TypeScript and may also report configured lint
warnings; it is not a syntax-only parser check. The CLI does not currently provide
project scaffolding or `add`, `dev`, `test`, or `doctor` wrappers. Use npm and
standard TypeScript tools directly; see [tooling.md](../docs/tooling.md).
