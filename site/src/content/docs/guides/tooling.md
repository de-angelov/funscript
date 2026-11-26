---
title: Tooling
---

The `funscript` CLI stays small and composable. It does not create a proprietary project
layout or package format, and it does not provide `dev`, `preview`, or `add` — use Vite,
your framework, and your package manager for those.

Run `funscript --help` for the authoritative command syntax. The full reference lives in
`docs/tooling.md`.

## CLI commands

### `check`

Type-check FunScript sources and report diagnostics.

```sh
funscript check src
funscript check src --json          # machine-readable results
funscript check src --sarif         # SARIF 2.1.0 for CI
funscript check src --warnings-as-errors
```

`--json` returns `success`, error/warning counts, and diagnostics with source locations,
severity, code, message, explanation, and help text.

### `fmt`

Format or verify `.fun` and `.funx` files.

```sh
funscript fmt src                   # rewrite files in place
funscript fmt src --check           # verify, exit nonzero if changes are needed
funscript fmt 'src/**/*.fun' --diff # print a unified patch
```

Directory and glob scans skip hidden paths, `node_modules`, `.git`, `.funscript`, `dist`,
`build`, and `coverage`. For editor integrations, pipe source through
`funscript fmt --stdin --stdin-filepath src/main.fun`; the filepath selects the nearest
formatting config. Add `--check` to check stdin without printing formatted output.

### `build`

Compile FunScript to JavaScript or TypeScript.

```sh
funscript build src/main.fun
funscript build src --watch --outDir dist
funscript build src/cli/bin.fun --target bun --out dist/cli/bin.js --sourcemap
```

`--watch` type-checks and rebuilds incrementally, writing only after a successful check.
It rejects `--sourcemap`, `--bin`, and `--no-check`. The `bun` target bundles reachable
local imports into an executable file with a shebang; npm imports stay external.

### `run`

Compile and execute an entry file with Node, bundling local imports first.

```sh
funscript run src/main.fun
funscript run src/main.fun -- --verbose   # arguments after -- go to the program
```

### `test`

There is no `funscript test` command. Write tests with Vitest and run them from your
project scripts:

```sh
npx vitest run
```

## Language server (LSP)

The language server powers editor support for FunScript:

- **Diagnostics** from the compiler and project policies.
- **Go to definition**, following named re-exports and aliases.
- **Rename** across FunScript and supported JavaScript/TypeScript imports and re-exports.
- **Hover** with inferred types, TypeScript dependency docs, and `///` FunScript docs.
- **Refactors** to use bare or qualified pipeline stages.
- **Pipeline style** actions for the stage at the cursor or a selection.

The server reads the workspace, including unopened files, and prefers unsaved editor
contents. It excludes dependency, build, and generated cache directories. Rename requires a
local workspace and declines when it cannot inspect source, avoid a binding collision, or
account for generated schema companions or dynamic namespace access — review edits before
applying them.

The VS Code extension synchronizes open JavaScript/TypeScript buffers automatically. Other
clients must send `funscript/interopDocument` notifications (`upsert` on open/change,
`close` on close) so rename can see unsaved interop files.

## Formatter

The formatter accepts `.fun` and `.funx` sources and uses the nearest
`funscript.config.fun` above each file:

```funscript
export config = {
  format: { indentSize: 2, lineWidth: 100 }
}
```

`indentSize` ranges from 1 to 8 (default 2) and `lineWidth` from 40 to 240 (default 100).
The width is a target for records, lists, and pipelines, not a hard limit. Project
indentation overrides the editor's tab size. The CLI `fmt` command and the language server
share the same configuration.

## Recommended workflow

1. `funscript check <path>` — catch type and policy errors.
2. `funscript fmt <path>` — format, then `funscript fmt <path> --check` in CI.
3. `funscript run <entry>` — run locally during development.
4. `npx vitest run` — run JavaScript/TypeScript tests.
5. `funscript build <entry>` — produce output for deployment.

In `package.json`, point scripts at explicit files or directories:

```json
{
  "type": "module",
  "scripts": {
    "check": "funscript check src",
    "format": "funscript fmt src",
    "format:check": "funscript fmt src --check",
    "run": "funscript run src/main.fun",
    "build": "funscript build src/main.fun",
    "dev": "vite",
    "test": "vitest run"
  }
}
```

For web apps, the FunScript Vite plugin compiles `.fun`/`.funx` in memory during
development and production builds; relative `.js` imports fall back to matching `.fun` and
`.funx` files. For tools that run outside Vite, enable the generated TypeScript view with
`funscript({ types: { include: ["app"] } })` and add `.funscript/types` to `rootDirs`.

Use `funscript check app/ --no-ts` in CI to reject TypeScript and AssemblyScript escapes
inside audited directories. Project-wide rules such as `noTs`, `noGlobalThis`,
`barePipelines`, `noDeepDestructure`, and `effectOnly` are configured in
`funscript.config.fun` and applied by `check`, `build`, `run`, the LSP, and the plugins.
