# Examples

These files are **design fixtures**, not runnable code yet. They define the target feel
of FunScript and will become the first golden tests for the compiler.

| File | Shows |
| --- | --- |
| `hello.fun` | bindings, interpolation, pipelines, an Effect entry point |
| `shapes.fun` | tagged-union `schema`, guards, exhaustive `match` |
| `todo-http.fun` | `effect` blocks, `schema`, retry, layer provision |
| `greeter-service.fun` | services, layers, dependency injection |
| `order-fulfillment.fun` | end-to-end showcase: Effect (concurrency, retry, layers), ts-pattern, Mutative |

The generated TypeScript for these programs has been checked against
Effect 4.0.6, ts-pattern 5.9.2, and TypeScript 7.0.2 during the design phase.
