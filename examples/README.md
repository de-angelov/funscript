# FunScript Examples

This directory contains the canonical collection of runnable FunScript examples, showcases, and full-stack applications. Every runnable example is checked by static type analysis and validated by automated tests (`npm run test:examples`).

The four core canonical showcases (`hello.fun`, `shapes.fun`, `todo-http.fun`, and `greeter-service.fun`) serve as references for standard FunScript syntax (functions, schemas, effects, services, and matching).

## Directory Layout

```text
examples/
├── README.md                     # This documentation and usage guide
├── schema-types.d.ts             # Ambient TypeScript type declarations for schema imports
│
├── [Standalone Examples]
│   ├── bank-account.fun          # Tagged unions, pattern matching, immutable updates
│   ├── fibonacci.fun             # Recursive pipelines and numeric comparison guards
│   ├── github-api-client.fun     # REST client, Promise interop, runtime Schema decoding, tagged errors
│   ├── greeter-service.fun       # Effect services, context tags, and layer composition
│   ├── hello.fun                 # Basic bindings, string interpolation, pipelines, Effect entrypoint
│   ├── js-ts-interop.fun         # TypeScript type escapes, foreign Promise interop, fibers
│   ├── markdown-task-manager.fun # Mutative draft updates, `when` early returns, file I/O
│   ├── order-fulfillment.fun     # Full e-commerce workflow: concurrency, retry, fibers, ts-pattern
│   ├── pipeline-helpers.fun      # es-toolkit helpers: string slug/casing, math clamp/round, timing
│   ├── shapes.fun                # Tagged-union `schema`, guards, exhaustive `match`
│   ├── todo-http.fun             # HTTP service simulation, effect blocks, retry, layers
│   ├── todo-service.fun          # In-memory todo repository service and layer injection
│   └── ts-schema-validation.fun  # Foreign TypeScript schema import (`from ts<Type>`), validation
│
├── [JSX & Reactive UI Components (.funx)]
│   ├── reactive-widget.funx      # Native JSX component compiling to TSX, typed props, template literals
│   └── todo-dashboard.funx       # Full reactive dashboard app with composed components and state drafts
│
├── solid-demo/                   # Multi-file Solid.js integration showcase
│   ├── app.ts                    # Solid app runner importing compiled FunScript domain logic
│   ├── domain.fun                # FunScript business domain models and services
│   ├── domain.ts                 # Type bindings for domain logic
│   └── solid-in-funscript.fun    # FunScript implementation using Solid reactive primitives
│
└── fixtures/                     # Compiler & formatter test fixtures (separate from runnable examples)
    ├── 01-basic-bindings.fun
    ├── 02-functions-and-pipelines.fun
    ├── 03-schemas-and-unions.fun
    ├── 04-pattern-matching.fun
    ├── 05-mutative-updates.fun
    └── 06-effects-and-services.fun
```

## Example Catalog

| File | Features & Demonstrations |
| --- | --- |
| `bank-account.fun` | Tagged union actions (`Deposit`, `Withdraw`, `Freeze`), pattern matching with numeric guards, immutable record updates |
| `fibonacci.fun` | Recursive functions with pattern matching, numeric comparison helpers, pipeline chaining with `\|>` |
| `github-api-client.fun` | REST API client with foreign `js` Promise interop, runtime `Schema.Struct` decoding, Effect tagged error classes, exhaustive pattern matching |
| `greeter-service.fun` | Canonical showcase: Effect service definitions, context tags, layer creation (`Layer.succeed`), dependency injection |
| `hello.fun` | Canonical showcase: Variable bindings, string template interpolation (`"Hello {name}"`), pipeline transformations, Effect entry point |
| `js-ts-interop.fun` | Raw TypeScript type escapes (`ts { ... }`), foreign JS Promise lifting (`js promiseFn`), async Effect fibers |
| `markdown-task-manager.fun` | CLI state management using Mutative copy-on-write `draft` blocks, `when` early returns, conditional execution, Effect file I/O |
| `order-fulfillment.fun` | End-to-end e-commerce showcase combining Effect concurrency (`Effect.all`), retry schedules, fiber forking, ts-pattern matching, and Mutative drafts |
| `pipeline-helpers.fun` | Pipeline data-last helpers powered by `es-toolkit`: string utilities (`slug`, `camelCase`, `snakeCase`), math operations (`clamp`, `round`), and timing helpers |
| `reactive-widget.funx` | Native `.funx` JSX component emitting `.tsx`, typed props, tagged union view states, template literals in attributes (`className="btn-${variant}"`) |
| `shapes.fun` | Canonical showcase: Tagged-union `schema` definitions (`Circle`, `Rect`, `Point`), guard conditions, exhaustive `match` expressions |
| `solid-demo/` | Multi-file Solid.js framework integration showing how compiled FunScript modules interoperate seamlessly with modern TypeScript ecosystems |
| `todo-dashboard.funx` | Interactive multi-component JSX dashboard featuring stat cards, filter buttons, item rows, and Mutative state draft updates |
| `todo-http.fun` | Canonical showcase: Service simulation with `effect` blocks, runtime schema parsing, retry policies with backoff, layer provision |
| `todo-service.fun` | Repository service pattern using Effect services, layers, and TypeScript helper escape hatches |
| `ts-schema-validation.fun` | Importing external TypeScript type definitions using `from ts<Type>`, Schema decoding, validation error reporting |

## Running and Verifying Examples

### 1. Static Type Checking

Verify syntax and TypeScript types for an example:

```sh
node ./dist/cli/index.js check examples/shapes.fun
node ./dist/cli/index.js check examples/reactive-widget.funx
```

### 2. Formatting

Check or format examples according to canonical style rules:

```sh
# Check formatting
node ./dist/cli/index.js fmt --check examples/shapes.fun

# Format in place
node ./dist/cli/index.js fmt examples/shapes.fun
```

### 3. Execution

Execute any runnable FunScript program directly via the CLI:

```sh
node ./dist/cli/index.js run examples/fibonacci.fun
node ./dist/cli/index.js run examples/order-fulfillment.fun
node ./dist/cli/index.js run examples/github-api-client.fun
node ./dist/cli/index.js run examples/todo-dashboard.funx
```

### 4. Compilation & Build

Compile FunScript files into standalone TypeScript (`.ts`) or React TSX (`.tsx`):

```sh
# Build a single file
node ./dist/cli/index.js build examples/hello.fun --out dist/hello.ts

# Build JSX component to TSX
node ./dist/cli/index.js build examples/reactive-widget.funx --out dist/reactive-widget.tsx

# Build all funx components to an output directory
node ./dist/cli/index.js build examples/reactive-widget.funx examples/todo-dashboard.funx --outDir dist/ui
```
