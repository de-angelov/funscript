# FunScript tooling

This page describes how to use the published CLI in a project. The command surface is
generated directly from code in the [CLI reference](reference/cli.md). Project scaffolding
and Vite/Vitest wrappers are planned, not part of the current command surface.
Use the package manager and ecosystem tools directly when you need those features.

## Supported CLI commands

`funscript --help` and the generated [CLI reference](reference/cli.md) are the source of
truth for command syntax.

The CLI does not currently provide `new`, `dev`, `preview`, `test`, `add`, or `doctor`.
For project creation, create ordinary `package.json`, `tsconfig.json`, and tool config files
using the relevant ecosystem tool. Use Vite for web development and builds, Vitest for
JavaScript/TypeScript tests, and npm, pnpm, or Bun to manage dependencies. These tools do not
automatically discover `.fun` tests or start through a FunScript wrapper.

`funscript run src/main.fun -- --verbose` passes arguments after `--` to the program.
The command bundles local FunScript imports before starting Node, so imported modules do
not need separate build steps.

### Bun executable builds

Use `funscript build <entry.fun> --target bun --out <path.js>` to compile one entry and bundle
its reachable local `.fun`/`.funx` imports into a Bun-runnable JavaScript executable. The bundle
has a Bun shebang and is marked executable. npm package imports remain external, so install the
application's runtime dependencies as usual; the built program does not invoke or require the
FunScript compiler at runtime. `--sourcemap` writes a linked source map. The Bun target accepts
one entry file and does not support `--watch`.

```sh
funscript build src/cli/bin.fun --target bun --out dist/cli/bin.js --sourcemap
bun run dist/cli/bin.js
```

## Navigation and rename

Go to definition follows named re-exports, including aliases. Rename respects the
boundaries between exported names and local aliases. The language server reads
FunScript files in the editor's workspace, including unopened files, and uses unsaved
editor contents when available. It excludes dependency, build and generated cache
directories. Rename follows supported JavaScript and TypeScript imports and re-exports
using TypeScript's language service; an existing local alias or re-export name may be
preserved. Rename requires a local workspace and declines when it cannot inspect source,
resolve a potentially relevant import, avoid a binding collision, or account for an
in-use generated schema companion or dynamic namespace access. Review the proposed edits before applying them.
References outside the workspace and unsupported module resolution are not indexed.
The VS Code extension synchronizes open JavaScript and TypeScript buffers for rename.
Other LSP clients must send `funscript/interopDocument` notifications to provide those
unsaved buffers; otherwise the server reads their contents from disk. Send
`{ "kind": "upsert", "textDocument": { "uri": ..., "languageId": ..., "version": ..., "text": ... } }`
on open and change, and `{ "kind": "close", "uri": ... }` on close.

## Hover information

The language server provides type information for unambiguous symbols and
documentation from TypeScript dependencies. Add consecutive `///` lines
immediately before a top-level binding to include its FunScript documentation:

```funscript
/// Greet someone by name.
export greet = (name: String) => "Hello, {name}!"
```

Hovering a record-schema declaration identifies it as a data schema, a generic
data-schema factory, or a compile-time contract. Contract hover explicitly notes
that callbacks and data are not validated by the declaration.

Hover also explains language constructs and resolved pipeline operations. When
the server cannot safely distinguish shadowed symbols or compile an incomplete
document, type information may be unavailable.

## Minimal command-line project

In FunScript source, use brace-delimited `effect { ... }` as the canonical form for Effect sequencing. The existing
indentation-based `effect` block remains compatible syntax; both forms compile through
the same `Effect.gen` support.

Install FunScript and the runtime libraries your source imports in a normal Node project.
Add scripts that point to files or directories explicitly:

```json
{
  "type": "module",
  "scripts": {
    "check": "funscript check src",
    "format": "funscript fmt src/main.fun",
    "format:check": "funscript fmt src/main.fun --check",
    "run": "funscript run src/main.fun",
    "build": "funscript build src/main.fun --outDir dist",
    "dev": "vite",
    "test": "vitest run"
  }
}
```

A basic workflow is `npm run check`, `npm run format`, `npm run run`, `npm run dev`,
`npm run build`, and `npm test`. The compiler's formatter accepts `.fun` source files.
Vite and Vitest run from the project's own configuration and scripts; configure the
FunScript Vite plugin if the app imports `.fun` modules. Vitest tests are JavaScript or
TypeScript tests; `.fun` test discovery is not implemented. For output beyond compiling
FunScript files to TypeScript, configure Vite or another standard bundler directly.

### Vite and framework type views

The Vite plugin compiles `.fun` and `.funx` in memory for development and production
builds. Relative `.js` imports first resolve normally; if the target does not exist,
the plugin tries the corresponding `.fun` and `.funx` files. Existing JavaScript and
TypeScript resolution keeps priority.

For framework tools that run outside Vite, opt in to a generated TypeScript view:

```ts
import { defineConfig } from "vite";
import { funscript } from "funscript/vite";

export default defineConfig({
  plugins: [funscript({ types: { include: ["app"] } })],
});
```

Enable arbitrary-extension resolution and add the generated directory to your existing
`rootDirs` in `tsconfig.json` (retain any framework-provided root directories):

```json
{
  "compilerOptions": {
    "allowArbitraryExtensions": true,
    "rootDirs": [".", "./.react-router/types", "./.funscript/types"]
  }
}
```

The plugin generates `.funscript/types` before Vite starts, builds, or a framework loads
its Vite configuration, and refreshes the view when development files change. Ignore
that directory in version control. `include` accepts project-relative directories or
files; `outDir` changes the cache directory and must also be reflected in `rootDirs`.
Use distinct output directories for configurations with different source sets. The cache
is generated and must not contain hand-edited files. A `.fun` and `.funx` with the same
stem in the source set are rejected because their JavaScript-style import is ambiguous.

A React Router route can use the actual `.funx` path in its route configuration. Keep
server-only dependencies referenced only by server route exports so React Router can
remove them from the client bundle. TypeScript diagnostics in the generated view can
still refer to cache paths; Vite runtime source maps point back to the FunScript source.
Run the framework's normal type generation before its TypeScript check. This type view
is not a declaration-only publishing build and does not replace `funscript check`.

The CLI command surface is intentionally small and composable. It does not create a
proprietary project layout or package format.

## Package scripts in this repository

The repository's own scripts are defined in `package.json`: `build`, `check`, `benchmark`,
`prototype:optional`, `spike:optional-compiler`, `test`,
`test:examples`, `test:watch`, `fmt`, `fmt:check`, `prettier:check`, `docs:generate`,
`docs:check`, `check:idiomatic`, `package:check`, `verify`, and `pr:check`. They are repository scripts,
not additional `funscript` CLI commands.

## Language compatibility policy

Under the human-approved language compatibility policy (TASK-102), FunScript adopts a **Strict Zero-Alias Policy**. Because FunScript is in early active development with zero external production consumers, obsolete constructs and historical shims are removed immediately rather than maintained across deprecation windows or hidden behind edition flags. See [Language and ecosystem compatibility policy](compatibility.md) for the full policy specification.

The policy governs three key evolutionary areas:

### 1. Effect aliases

Obsolete Effect compatibility aliases are avoided to remain synchronized with upstream Effect v4 public exports. FunScript enforces canonical names (such as `forkChild` instead of obsolete `fork`). A single audited transitional alias (`catchAll` mapping to `catch`) remains temporarily available in `EFFECT_PIPELINE_COMPATIBILITY_ALIASES` for compatibility, but canonical Effect v4 names should always be preferred.

```funscript
# Audited compatibility alias (compiles to Effect.catch; slated for removal):
export recover = task |> catchAll((err) => Effect.succeed("fallback"))

# Canonical Effect operation:
export recover = task |> catch((err) => Effect.succeed("fallback"))
```

### 2. Breaking syntax changes

Outdated syntax and deprecated grammar constructs are statically rejected with actionable error diagnostics citing the canonical form, rather than supported through multi-release deprecation warnings or language edition configurations.

For example, function blocks and effect blocks enforce the explicit return invariant (`=> value`). Trailing bare expressions without `=>` are rejected by the parser:

```funscript
# Outdated syntax (rejected by parser):
sum = (a: Number, b: Number) => {
  a + b
}

# Canonical syntax with explicit return:
sum = (a: Number, b: Number) => {
  => a + b
}
```

### 3. Newly ambiguous pipeline operations

FunScript disallows heuristic guessing, fallback priority, or companion precedence orders. If an untyped or unproven receiver type causes a bare pipeline stage to match multiple candidate companion modules in the catalog (such as `map` existing in `Array`, `Effect`, and `Option`), the compiler raises a compile-time `PipelineResolutionError` requiring explicit qualification.

```funscript
# Ambiguous bare call without a proven receiver type (rejected at compile time):
# Error: map is ambiguous for this pipeline; write Array.map(...) or Option.map(...)
export process = (data) => data |> map((x) => x + 1)

# Canonical disambiguated call with explicit companion qualification:
export process = (data) => data |> Array.map((x) => x + 1)
```

## Explicit-return migration decision

Under the human-approved decision for TASK-104 and TASK-166, FunScript has **declined automatic CLI codemod commands** (such as `funscript migrate`) that perform unattended rewrites. Instead, the language provides compiler diagnostics alongside a safe programmatic migration utility in `src/tooling/migrate.ts`.

### Decision rationale and compatibility policy

In alignment with FunScript's [Strict Zero-Alias compatibility policy](#language-compatibility-policy):
- FunScript is in early active development with zero external production consumers.
- No automated CLI command (such as `funscript migrate`) performs automatic silent rewrites on build.
- Programmatic safe migration functions (`migrateSource`, `migrateFile`, `migrateFiles`, `formatMigrationReport`) are available in `src/tooling/migrate.ts` to convert unambiguous function blocks while leaving ambiguous constructs untouched for developer review.
- Codebases rely strictly on immediate, actionable compiler diagnostics (`ParseError: Function block must end with an explicit '=> returnValue'` and `ParseError: Effect block must end with an explicit '=> returnValue'`) to guide developers during manual updates.

### Ambiguous cases and safety risks

Automated mechanical insertion of `=>` was rejected because semantic equivalence cannot be proven safely across several syntactic contexts:

1. **Side effects vs. return values in function blocks**
   In multi-statement functions, a trailing expression may be executed purely for side effects with an intended `Unit` or `void` return:
   ```funscript
   # Ambiguous legacy block:
   saveState = (state: State) =>
     serialized = serialize(state)
     writeDisk(serialized)
   ```
   Mechanically rewriting the final line to `=> writeDisk(serialized)` alters the inferred return type and leaks internal state, breaking caller contracts when the author intended the return value to be discarded.

2. **Yield (`<-`) vs. discard (`_ <-`) vs. return (`=>`) in effect blocks**
   In FunScript `effect` blocks, returning an expression with `=>` does not execute or yield it; it returns the unyielded `Effect` generator:
   ```funscript
   # Ambiguous legacy effect block:
   program = effect {
     user <- fetchUser()
     Console.log("Done")
   }
   ```
   If a codemod mechanically prepends `=> Console.log("Done")`, `Console.log` is **never executed** at runtime, causing a silent defect. The developer's intent may instead have been:
   ```funscript
   program = effect {
     user <- fetchUser()
     _ <- Console.log("Done")
     => Unit
   }
   ```
   A mechanical migration tool cannot deduce whether an effect expression should be yielded, discarded, or returned.

3. **Trailing binding declarations**
   If a legacy block ends with an assignment such as `result = compute()`, prepending `=>` produces a syntax error (`=> result = compute()`). Synthesizing an additional statement (`result = compute()` followed by `=> result`) risks returning private state or dead assignments where `compute()` was only called for side effects.

4. **Syntactic exemptions and expression bodies**
   - Multi-statement function blocks ending in `match` or `effect` expressions are exempt from `=>` in the parser (for example, a trailing `match x ...` is accepted as the final block expression).
   - Single-expression lambdas (`sum = (a, b) => a + b`) are expression bodies and do not use `=>` in the body.
   Blind mechanical insertion risks corrupting valid syntax or introducing redundant tokens.

5. **Mechanical irreversibility**
   Because `=> expr` is identical for hand-authored code and migrated code, an automated transformation is mechanically irreversible. Version control (`git`) serves as the sole rollback mechanism for manual code updates.

### Enforce FunScript source in selected paths

Use `--no-ts` when reviewing or generating FunScript and requiring application code to stay in FunScript:

```bash
funscript check app/ --no-ts
funscript build app/ --no-ts
funscript emit app/main.fun --no-ts
funscript run app/main.fun --no-ts
```

This rejects `ts { ... }` declarations, expressions, and type annotations, as well as `as { ... }` AssemblyScript blocks. For directories passed to `check` or `build`, it also rejects standalone JavaScript, TypeScript, and AssemblyScript source files, including `.d.ts`, `.d.mts`, `.d.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.as`. It checks hidden folders and symlinks but skips `.git`, `node_modules`, and `.funscript`. Explicit file arguments are checked individually. Normal checking follows local FunScript imports and applies the rule to those files too. `--no-ts` remains active with `build --no-check` and `run --no-check`, but skipping the check also skips its traversal of imported FunScript files; check the whole project explicitly when enforcing a project-wide policy. The compiler API accepts `{ noTs: true }` in `compileString`, `checkString`, and type-check options.

Vite and Bun integrations can enable the same check with `funscriptPlugin({ noTs: true })` or `funscriptBunPlugin({ noTs: true })`.

This is an opt-in audit, not a filesystem permission system: it cannot stop an editor or LLM from creating a file, and it cannot detect code hidden in other file formats. Run `funscript check app/ --no-ts` in CI or after edits to reject violations within that directory. JavaScript imports, `js` interop, imported TypeScript schemas, and external dependencies remain available; code outside audited paths is not checked. Compiled TypeScript output is also found by a later directory audit, so use a separate output directory outside the audited source tree. The compiler API and plugins reject embedded escapes but do not scan directories for standalone files.

### Project and folder policies

Add `funscript.config.fun` to the project root (the working directory for CLI and Bun, or the configured Vite root):

```funscript
export config = {
  noTs: ["app/domain", "app/services"]
  noGlobalThis: ["app/domain", "app/services"]
  noOptional: ["app/domain", "app/services"]
  barePipelines: ["app/domain", "app/services"]
  effectOnly: ["app/domain"]
}
```

`noTs`, `noGlobalThis`, `noOptional`, and `barePipelines` accept `true` to apply everywhere, `false` to disable the rule, or arrays of project-relative directories. `effectOnly` accepts an array of project-relative directories. Paths must not escape the project root. Policies apply to descendants of those directories; multiple restrictions combine. CLI flags can enable a project-wide restriction but cannot disable a configured policy. The config is parsed as a single literal exported record; it is never executed. Unknown options, nonliteral values and invalid paths are errors.

`barePipelines` enforces shorter, cleaner pipeline expressions by rejecting redundant companion module prefixes (e.g. `|> String.replace(...)`, `|> String.trim`, `|> String.toLowerCase`, `|> Array.map(...)`). Because FunScript infers the piped companion type automatically, prefixing the module name adds noise; `barePipelines` forces concise bare forms like `|> replace(...) |> trim |> toLowerCase`. Non-pipeline direct calls (`String.trim(s)`) remain allowed. `noGlobalThis` rejects references to `globalThis`, including indexed access and aliases. Property names and string values with the same spelling are allowed. Raw TS or AssemblyScript blocks are not inspected by this rule; combine it with `noTs` when needed. `noOptional` strictly disallows TypeScript-style optional values (`?`) in function parameters, record type fields, and schemas, ensuring core domain code models absence explicitly with Effect's `Option<T>` and keeps `?` at the TS interop edge or within `ts { ... }` escape hatches. `noTs` applies the escape restrictions and standalone-source audit described above to matching paths. `effectOnly` prohibits raw TS/AssemblyScript escapes, JS interop expressions, common ambient side-effect APIs (including `globalThis`, `fetch`, `process`, `console`, and timers), and non-Effect package imports. Imports from `effect`, `effect/*`, and `@effect/*` are permitted. Relative imports must resolve to FunScript within a configured Effect-only directory; list shared directories too if they need to be used. Pure ordinary functions remain allowed.

`check`, `build`, `emit`, and `run` load this policy automatically. Vite and Bun plugin compilation also applies it. Use `funscript check app/` in CI to audit standalone source files in the selected tree; plugin transforms inspect FunScript source but do not audit all files on disk. `tsc`, the REPL, and the language server do not currently load this policy. Programmatic compiler and type-checker users can pass policy options explicitly.

These are source-level discipline checks, not a proof of purity or a security boundary. Effect packages and allowed code can still perform side effects (including inside callbacks), indirect behavior is not exhaustively analyzed, and files outside audited paths are not policed. Protect the config and run the check in CI if the policy must be enforced against code changes.

### Pipeline style conversion

Use `funscript pipeline-style bare src/` to shorten eligible companion stages in files or directories, or `funscript pipeline-style qualified src/` to make inferred companion stages explicit. The command reports converted and skipped stages per file. The language server also offers **Use bare pipeline stages** and **Qualify pipeline stages** as refactoring actions for the stage at the cursor or stages in a selection. The conversion checks generated TypeScript and leaves ambiguous, shadowed, or otherwise behavior-changing stages untouched. Files that cannot compile are reported and left unchanged.

Formatter preferences can be set in `funscript.config.fun`:

```funscript
export config = {
  format: { indentSize: 2, lineWidth: 100 }
}
```

`indentSize` is an integer from 1 to 8 (default 2); `lineWidth` is an integer from 40 to 240 (default 100). The width is a target used when formatting records, lists, and pipelines; it is not a hard limit for every expression. The `fmt` command and language server use the closest config above each file. Project indentation overrides the editor's tab size. Leading `and` and `or` continuations are not currently supported.

To measure conversion on a representative file without changing it, build FunScript and run `node scripts/benchmark-pipeline-style.mjs path/to/file.fun bare`. The report includes elapsed time, converted and skipped stages, and peak process memory; compare results on the same machine and input.


### Incremental watch builds

Run `funscript build --watch` to typecheck and rebuild while source or tracked package dependencies change. It watches `src/` by default, writes TypeScript into `dist/` by default, and accepts source files or directories and `--outDir` or `--out`. The cache exists only while the watch process runs. Stop it with Ctrl+C. Existing project policies and strict flags still apply; generated outputs are written only after a successful, current check. Removing an input does not delete an existing output file. Untracked dependencies—including Node built-ins, unresolved packages, TypeScript interop, JSX, and extended TypeScript configs—are rechecked periodically rather than cached. Watch mode currently rejects `--sourcemap`, `--bin`, and `--no-check`.
