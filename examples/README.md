# Examples

These files demonstrate FunScript features. The syntax reference uses `=>` arrows,
PascalCase types, and `name = (params) => ...` function bindings. Older fixtures
may still require migration; use the compiler checks before running them.

| File                    | Shows                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `hello.fun`             | bindings, interpolation, pipelines, an Effect entry point                      |
| `shapes.fun`            | tagged-union `schema`, guards, exhaustive `match`                              |
| `todo-http.fun`         | `effect` blocks, `schema`, retry, layer provision                              |
| `greeter-service.fun`   | services, layers, dependency injection                                         |
| `order-fulfillment.fun` | end-to-end showcase: Effect (concurrency, retry, layers), ts-pattern, Mutative |

The current compiler dependencies are Effect 3.x, ts-pattern 5.x, and TypeScript
5.6+. Static checking gates `run` and `build`; external inputs still require
runtime Schema decoding. See [the strictness contract](../docs/syntax.md#123-static-guarantees-and-runtime-boundaries).
