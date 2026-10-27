# FunScript tooling

**Goal:** Go-like batteries included, TypeScript ecosystem underneath.

One command. One default for each concern. No configuration until a project genuinely
needs it. The toolchain is part of the language design, not an afterthought.

```text
funscript new       scaffold a project
funscript dev       Vite dev server + typecheck
funscript build     check + Vite production build
funscript preview   serve the production build
funscript test      Vitest, discovers *.test.fun
funscript check     parse + resolve + tsc + project checks
funscript fmt       canonical formatter
funscript run       compile and execute a script
funscript add       delegate to npm/pnpm/bun
funscript emit      emit readable TypeScript
funscript lsp       language server
funscript doctor    diagnose the toolchain
```

---

## 1. The defaults

| Concern | Default | Under the hood |
| --- | --- | --- |
| Build / dev server | **Vite** | `@funscript/vite` plugin |
| Production preview | **Vite preview** | `dist/` served by Vite |
| Tests | **Vitest** | same Vite pipeline |
| Types | **TypeScript** | `tsc --noEmit` + language service |
| Format | **funscript fmt** | canonical, no config |
| Packages | npm / pnpm / Bun | no new registry or lockfile |
| Editor | **funscript lsp** | TypeScript language service |
| Runtime | **Effect TS** | no FunScript runtime |
| Entry | `src/main.fun` | `funscript run` convention |
| Test files | `*.test.fun` | Vitest discovery |
| Output | `dist/` | Vite build |

If a project needs something else, the generated `vite.config.ts` and `tsconfig.json`
are ordinary, editable config files. There is no FunScript-specific build format to learn or
escape.

### 1.1 The compiler owns the surface

FunScript is Effect-first. The parser rejects the JavaScript/TypeScript features that
undermine the model: `let`/`var`, reassigning immutable bindings (local mutation uses
explicit `mut`), `for`/`while`, `class`/`new`/`this`, `throw`/`try`/`catch`, `return`,
`async`/`await`, `Promise` as a FunScript-authored effect type, `null`, `undefined`, explicit
`any`, `interface`/`enum`/`namespace`/`data`, `if`/`else`/`switch`/ternary (`match` is the
single branching construct), `function`, runtime `typeof`/`instanceof`/`in`/`delete`/`eval`,
semicolons, and the symbol spellings `&&`/`||`/`!`/`===`/`!==`.

There is no ESLint/Prettier configuration to debate and no second loop, function, or
object-creation form to lint. The compiler is the style guide. Raw TypeScript is the only
escape hatch, and it is explicit.

---

## 2. `funscript new`

```text
funscript new my-app
cd my-app
funscript dev
```

Default scaffold:

```text
my-app/
  package.json
  tsconfig.json
  vite.config.ts
  .gitignore
  README.md
  src/
    main.fun
  tests/
    main.test.fun
```

`.gitignore` includes `node_modules/`, `dist/`, and `.funscript-cache/`.

`package.json` scripts:

```json
{
  "scripts": {
    "dev": "funscript dev",
    "build": "funscript build",
    "preview": "funscript preview",
    "test": "funscript test",
    "check": "funscript check",
    "fmt": "funscript fmt"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import funscript from "@funscript/vite";

export default defineConfig({
  plugins: [funscript()],
});
```

`tsconfig.json` defaults:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

`funscript` builds a virtual TypeScript program from the `.fun` import graph; plain `tsc`
does not discover `.fun` files. The `tsconfig.json` is the type policy, not the file
walker. The compiler API (or the `.funscript-cache/` mirror) supplies the generated `.ts`
roots.

The CLI detects npm, pnpm, or Bun from the lockfile or `packageManager` field.
`--pm <name>` overrides detection. `--template web|node|lib` selects a scaffold;
`web` is the default.

`funscript new` does not create a FunScript-specific directory layout beyond `src/` and `tests/`.
It is a normal Vite project with `.fun` files.

---

## 3. `funscript dev`

```text
funscript dev
```

What happens:

1. The CLI starts Vite with `@funscript/vite` injected.
2. `.fun` files are transformed to TypeScript on demand.
3. Vite handles HMR, CSS, assets, env vars, and the browser overlay.
4. The compiler writes a `.ts` mirror to `.funscript-cache/` and runs `tsc --noEmit --watch`
   on that mirror (or uses the TypeScript compiler API in watch mode).
5. Syntax and type errors are reported in the terminal and, for web apps, in the Vite
   overlay.
6. Saving a file formats it through the LSP if the editor is configured.

Flags pass through to Vite where they make sense:

```text
funscript dev --host
funscript dev --port 3000
funscript dev --open
funscript dev --mode staging
```

The typecheck watcher can be disabled with `--no-check` for a quick UI-only loop. CI
should never use `--no-check`.

For Node services and scripts:

```text
funscript run src/server.fun --watch
```

`funscript run` uses `tsx` (or Bun, if selected) and the compiler's emit path. It is for
scripts, CLIs, and simple servers. Vite SSR is supported for full-stack apps; the default
template remains a Vite web app.

---

## 4. `funscript build`

```text
funscript build
```

`funscript build` is deliberately strict:

1. `funscript check` runs first. Any syntax, resolution, or type error aborts the build.
2. Vite builds the app or library into `dist/`.
3. Source maps are emitted.
4. The build summary reports the FunScript version, Effect target range, and output sizes.

Vite/esbuild strips types; it does not typecheck. Step 1 is the type gate.

Flags pass through to Vite:

```text
funscript build --mode production
funscript build --base /app/
funscript build --outDir build
```

For Node targets:

```text
funscript build --target node
```

This uses Vite's SSR/library mode. The output is still standard ESM; there is no FunScript
runtime.

### `funscript preview`

```text
funscript preview
funscript preview --port 4173
```

`funscript preview` serves the production output from `dist/` through Vite's preview server.
It does not recompile or typecheck; `funscript build` is the gate before it.

### `funscript emit`

`funscript emit` is the readable-output command:

```text
funscript emit src/main.fun --out-dir emitted
```

It writes `.ts` files and source maps without bundling. This is how you debug the
compiler, review generated code, or eject from FunScript. The emitted TypeScript is part of
the product, not an implementation detail.

---

## 5. `funscript test`

```text
funscript test
funscript test --watch
funscript test --coverage
funscript test src/shapes.test.fun
```

- Discovers `*.test.fun`. There is one test-file convention; no `.spec` alternative.
- Runs Vitest through the same Vite plugin as the app.
- Typechecks test files by default; `--no-check` skips it.
- Passes through Vitest flags (`--watch`, `--coverage`, `--ui`, `--reporter`).
- Uses the project's `vitest.config.ts` if present; otherwise built-in defaults.

Example:

```funscript
import { expect, test } from "vitest"
import { Circle, area } from "../src/shapes.fun"

test("area of a circle", ->
  expect(area(Circle(2))).toBeCloseTo(12.566)
)
```

Effect tests use `@effect/vitest`:

```funscript
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect } from "effect"

it.effect("loads a user", ->
  effect
    user <- loadUser("1")
    expect(user.name).toBe("Ada")
)
```

There is no FunScript test framework. Vitest is the test runner; Effect's testing tools are
the effect-aware layer.

---

## 6. `funscript check`

`funscript check` is the compiler's first reviewer:

1. **Parse** — indentation, tokens, grammar.
2. **Resolve** — scopes, imports, exports, constructor arity, duplicate bindings.
3. **FunScript checks**:
   - banned JavaScript/TypeScript surface (parser);
   - non-final bare expressions in `effect` blocks;
   - mutability rules: no top-level `mut`, no closure-captured `mut` mutation, no
     reassignment of immutable bindings or non-`mut` fields;
   - schema/type rules: compile-time-only `type` aliases cannot be used in runtime value
     position;
   - duplicate `service` tags across the project;
   - `_tag` field collisions;
   - constructor names that collide across tagged-union `type` and `error`;
   - variant names that collide with their union `type`;
   - nullary variant values called as functions, or `error` constructors used as bare values;
   - explicit `any` in FunScript-authored types;
   - known mutating JS methods such as `Array.push`/`splice`/`sort` on non-`mut` bindings
     and callback `forEach` loops (warning; error in strict mode);
   - unreachable match arms;
   - unused imports (warning).
4. **Emit** — TypeScript + source map.
5. **Typecheck** — `tsc --noEmit` with the project's config.
6. **Map diagnostics** — TypeScript errors back to `.fun` spans.
7. **Post-typecheck diagnostics** — typed holes (`???`) reporting contextual expected type
   and local scope (warning in `funscript dev` / `funscript check`, error in `funscript build` and
   `funscript check --strict`), nested `Effect` returns, and `any` leaks in public APIs.

```text
funscript check
funscript check --json
funscript check src/main.fun
```

`funscript build` and `funscript test` call this by default. The toolchain does not have a
separate "lint" step for things the compiler can know.

---

## 7. `funscript fmt`

```text
funscript fmt
funscript fmt --check
funscript fmt --stdin
```

- Canonical, no configuration.
- 2 spaces, no semicolons, one pipeline stage per line for three or more stages.
- Match arms aligned under `match`.
- Imports preserved in source order.
- No symbol aliases: `&&`, `||`, `!`, `===`, and `!==` are parse errors, not normalized.
- `--check` exits non-zero if any file would change.
- `--stdin` is used by editors and pre-commit hooks.

The formatter shares the compiler's parser and is published as `@funscript/formatter`.
There is exactly one style.

---

## 8. `funscript add`

```text
funscript add effect
funscript add -D vitest
funscript remove effect
funscript install
```

`funscript add` delegates to the detected package manager:

- npm → `npm install <pkg>`
- pnpm → `pnpm add <pkg>`
- Bun → `bun add <pkg>`

It updates `package.json` and the normal lockfile. There is no FunScript registry, no FunScript
lockfile, and no vendored dependency directory. The npm ecosystem is the dependency
ecosystem.

`funscript install` is a convenience wrapper; using the package manager directly is always
fine.

---

## 9. The Vite plugin

Package: `@funscript/vite`

Responsibilities:

- compile `.fun` to TypeScript in memory;
- provide source maps for Vite's dev server and build;
- resolve `.fun` imports;
- participate in HMR;
- share one compiler instance with `funscript check`/`funscript emit`;
- surface compiler diagnostics in Vite's error overlay.

The plugin is injected automatically by `funscript dev`, `funscript build`, and `funscript test`.
`funscript new` includes it in `vite.config.ts` so that running `vite` or `vitest` directly
also works.

The plugin does not typecheck. Vite/esbuild strips types; `tsc` checks them. That is why
`funscript dev` runs a typecheck watcher and `funscript build` runs `funscript check` first.

---

## 10. `funscript run`

```text
funscript run src/main.fun
funscript run src/main.fun --watch
funscript run src/main.fun -- arg1 arg2
```

Behavior:

1. Compile the entry file and its `.fun` import graph.
2. Emit to `.funscript-cache/` (or a temp directory) and execute with `tsx` (Node) or `bun`
   (Bun).
3. If the module exports `main`:
   - if it is an Effect, run it with `Effect.runPromise`;
   - if it is a zero-argument function, call it and run the returned Effect;
   - otherwise, leave it alone.
4. Print Effect failures with `Cause.pretty`; exit non-zero.
5. Pass `--` arguments to the program.

`funscript run` is for scripts, CLIs, workers, and simple servers. For a full web app, use
`funscript dev`. For a production web build, use `funscript build`.

---

## 11. `funscript lsp`

```text
funscript lsp
funscript lsp --stdio
```

- Starts the FunScript language server.
- Compiles on change; runs the TypeScript language service on the generated `.ts`.
- Maps diagnostics, hover, completion, go-to-definition, and rename positions back to
  `.fun`.
- Formats through `funscript fmt`.
- Uses the same `tsconfig.json` and module resolution as the CLI.

The VS Code extension launches the server and provides syntax highlighting through a
TextMate grammar. Other editors can use `funscript lsp --stdio`.

Editor support is not optional for a language with this much syntax. It is part of the
Go-like promise.

---

## 12. `funscript doctor`

```text
funscript doctor
```

Checks:

- Node/Bun version;
- package manager and lockfile;
- Vite and Vitest versions;
- TypeScript version and `tsconfig` strictness;
- duplicate `@funscript/vite` plugin entries;
- compiler/toolchain version alignment;
- Effect/ts-pattern versions against the supported range;
- stale `.funscript-cache` or `dist` output;
- raw TypeScript escape-hatch count (informational).

`funscript doctor` should answer "why is my build weird?" before a human has to.

---

## 13. CI

The canonical CI sequence:

```text
funscript fmt --check
funscript check
funscript test --run
funscript build
```

`funscript test --run` disables Vitest watch mode in CI. `funscript build` repeats the check; the
duplicate is cheap and makes the build artifact trustworthy.

Cache:

- `node_modules/.vite`
- `.funscript-cache`
- `dist`

There is no FunScript-specific CI service or configuration file.

---

## 14. Package layout and distribution

Planned packages:

```text
@funscript/compiler          lexer, parser, resolver, surface checks, emitter
@funscript/vite              Vite plugin
@funscript/formatter         canonical formatter
@funscript/cli               the `funscript` binary
@funscript/language-server   LSP
@funscript/vscode            VS Code extension
```

Install the CLI:

```text
npm install -D @funscript/cli
npx funscript new my-app
```

`@funscript/cli` depends on the compiler, the Vite plugin, and the formatter, so one
install gives the full default toolchain. The packages remain separate for editor
extensions and custom integrations.

The CLI prints its compatibility target:

```text
funscript 0.1.0
compiler 0.1.0
target: Effect 4.x, ts-pattern 5.x, TypeScript 7.x
```

There is no FunScript runtime package.

---

## 15. Why Vite by default

Vite already is the TypeScript ecosystem's default development server and bundler for
web applications:

- fast dev server and HMR;
- esbuild-based transforms;
- Rollup production builds;
- CSS, assets, env vars, and worker support;
- a plugin API that can compile `.fun` cleanly;
- one config shared by dev, build, preview, and Vitest.

Using Vite means FunScript does not need to invent a bundler, a dev server, a CSS pipeline, or
a test runner. It needs one plugin and a CLI that injects it.

For Node libraries and CLIs, `funscript run` covers execution and `funscript build --target node`
uses Vite's SSR/library mode. If a project outgrows Vite, `funscript emit` produces standard
TypeScript, and the project can use any bundler. That is the escape hatch.

---

## 16. Go-like principles

1. **One command.** `funscript` is the front door.
2. **One default per concern.** Vite, Vitest, `tsc`, the formatter, npm.
3. **Zero config first.** Config files are generated, small, and optional.
4. **Fast feedback.** Vite HMR, incremental compilation, typecheck watcher.
5. **The compiler is the first reviewer.** `funscript check` gates builds and tests.
6. **Formatting is not a discussion.** One formatter, no options.
7. **The ecosystem is the library.** Effect TS, npm, Vite plugins.
8. **Escape hatches are explicit.** `vite.config.ts`, `tsconfig.json`, `funscript emit`,
   raw TypeScript.
9. **CI uses the same commands as developers.** No hidden pipeline.
10. **The toolchain is part of the language.** If a feature needs a manual setup step, it
    is not finished.
11. **One way per job.** The compiler rejects the second loop, the second function form,
    the second object-creation form, and the second effect model. There is no lint
    configuration for style because the grammar is the style.

The result should feel like Go's day-to-day loop:

```text
funscript new
funscript dev
funscript test
funscript fmt
funscript build
```

...with TypeScript's ecosystem underneath.
