# Performance baseline

Baseline recorded 2026-11-08 after TASK-083, on the Dev Agent 1 workspace branch.

## Reproduction

Run `npm run build`, then `npm run benchmark -- --iterations 5 --warmup 2`. The runner reports its Node/V8, OS, CPU, memory, individual samples, median, and spread. Multi-file typecheck uses three measured samples by design. Process-cold samples launch a new Node process for each compilation and include process startup, module loading, and compilation. The `single-file-cold` and `pipeline-cold` rows instead mean a new compilation context in an already-running process; warm rows follow warmups, and `pipeline-context-reuse` reuses a primed context.

Diagnostic measurements are separate: `lsp-diagnostic` observes synchronous syntax diagnostics for a malformed source version; `lsp-type-diagnostic-multifile` edits the valid two-file project, introduces a type mismatch, and waits for a TypeScript diagnostic with the exact changed document version. Diagnostic and child-process operations have 30 second timeouts. The tests check orchestration and payload identity, not machine-specific timing thresholds.

## Environment and results

- Node v20.20.2, V8 11.3.244.8-node.38
- Linux x64, AMD Ryzen AI 7 350 w/ Radeon 860M, 16 logical cores
- 15.21 GB RAM total; 12.46 GB free at run start
- Command: `npm run benchmark -- --iterations 5 --warmup 2`
- Median and spread (max minus min), milliseconds:

| Workload | Samples | Median | Spread |
| --- | ---: | ---: | ---: |
| Single file, fresh Node process | 5 | 644.992 | 34.106 |
| Single file, fresh context in warm process | 5 | 1.121 | 4.413 |
| Single file, warmed | 5 | 0.557 | 0.171 |
| Pipeline, fresh context in warm process | 5 | 89.618 | 1153.388 |
| Pipeline, warmed | 5 | 76.882 | 3.569 |
| Pipeline, shared context | 5 | 66.068 | 4.560 |
| .funx compile with sourcemap | 5 | 0.621 | 0.243 |
| Two-file project typecheck | 3 | 516.211 | 12.115 |
| Immediate syntax diagnostics | 5 | 0.053 | 0.082 |
| Completed multi-file type diagnostics | 5 | 267.223 | 8.779 |
| Hover | 5 | 0.033 | 0.004 |
| Completion | 5 | 0.019 | 0.033 |

The pipeline first sample was 1237.726 ms, while its other four samples were 84–97 ms. This explains the large spread and should not be read as its typical compile time. Completed editor type diagnostics include the current 250 ms debounce, so their latency is not directly comparable to the synchronous syntax result.

## Profile and next candidate

Profile command for the representative two-file typecheck: `node --cpu-prof --cpu-prof-dir=/tmp/funscript-profile --input-type=module -e 'import {Effect} from "effect"; import {typeCheckFiles} from "./dist/index.js"; const d=process.cwd()+"/tests/fixtures/benchmarks/project/"; const files=[d+"math.fun",d+"app.fun"]; const options={compilerOptions:{rootDir:d,types:[]}}; for(let i=0;i<5;i++) await Effect.runPromise(typeCheckFiles(files,options));'`.

The profile contained 4478 samples. Among named TypeScript frames, `doJSDocScan` and `setParentRecursive` (TypeScript source scanning/tree setup) appeared repeatedly; garbage collection was also prominent (674 samples). The profiler includes module startup and does not assign exclusive cost to one compiler phase. The code path in `src/compiler/check.ts` still creates a TypeScript program and requests pre-emit diagnostics for the virtual roots on each check, while the existing cache reuses source files and passes `oldProgram`.

The next investigation candidate is incremental editor typechecking across a representative project edit: determine whether program construction/pre-emit checking or allocation/GC dominates after the existing source-file and old-program reuse. Capture a profile focused on that path and verify invalidation across changed and imported files before proposing any optimization. No speedup is assumed by this baseline.

## Follow-up profile: compiler analysis passes

A follow-up on 2026-11-13 used Node v20.20.2 on this workspace. Five calls to
`typeCheckFiles` for the two-file benchmark project produced a 5.46-second CPU
profile with 5,049 samples. The largest sampled frame was garbage collection
(0.863 seconds); TypeScript scanning and JSDoc scanning were also prominent.
This includes process startup and is not an exclusive breakdown of the editor
incremental path.

A separate exploratory probe compiled `tests/fixtures/benchmarks/pipeline.fun`
six times in one process, with sourcemaps disabled and a shared
`TypeScriptCompilationContext`. It wrapped `context.check` to measure its calls:

| Run | Full compile | First check | Second check |
| --- | ---: | ---: | ---: |
| First | 1,206 ms | 1,122 ms | 41 ms |
| Warm 1 | 84 ms | 34 ms | 33 ms |
| Warm 2 | 73 ms | 32 ms | 29 ms |
| Warm 3 | 71 ms | 32 ms | 28 ms |
| Warm 4 | 65 ms | 29 ms | 26 ms |
| Warm 5 | 59 ms | 24 ms | 25 ms |

These are single-run observations, not regression thresholds; timings depend on
machine load and the `check` wrapper excludes type queries performed after it
returns. The fixture contains both a numeric comparison and pipelines. The
numeric-comparison pass emits one marked program, and the pipeline pass emits
another, so each calls `context.check` independently. A shared probe is worth
investigating, but it must preserve type resolution and diagnostic locations:
the two programs currently have different imports and marker declarations.
Before adopting it, compare cold and warm benchmarks and run numeric-comparison,
pipeline, imported-schema, optional-record, JSX, and source-map tests, including
cases where declarations or imports shadow built-in names.

Reproduce the pass timing probe after `npm run build`:

```sh
node --input-type=module -e '
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compileString, TypeScriptCompilationContext } from "./dist/index.js";
const file = "tests/fixtures/benchmarks/pipeline.fun";
const source = readFileSync(file, "utf8");
const original = TypeScriptCompilationContext.prototype.check;
const checks = [];
TypeScriptCompilationContext.prototype.check = function (text) {
  const start = performance.now();
  try { return original.call(this, text); }
  finally { checks.push(performance.now() - start); }
};
const context = new TypeScriptCompilationContext(file);
for (let i = 0; i < 6; i++) {
  const start = performance.now();
  const firstCheck = checks.length;
  await Effect.runPromise(compileString(source, file, { context, sourcemap: false }));
  console.log({ total: performance.now() - start, checks: checks.slice(firstCheck) });
}'
```

## Incremental checking foundation

The language server's in-memory typecheck cache fingerprints the complete local
FunScript import and re-export graph for each cached file. Editing a dependency
invalidates its transitive importers; unrelated cached files remain reusable.
Resolvable installed packages and their declared runtime dependencies are
fingerprinted from their package metadata, declarations, and relevant source
files. Unresolvable packages, dependencies outside the in-memory snapshot,
JavaScript or TypeScript interop, and JSX fall back to recompilation. Policy
checks are cached separately for each effective policy. This is an in-memory
cache, not a persistent cross-process build cache. `IncrementalBuildSession` exposes repeated, checked
in-memory builds to watch or editor integrations, returning generated TypeScript
and compiled/reused counts; callers provide the complete source snapshot and
choose how to write outputs. `funscript build --watch` uses this session to
rebuild while the process is running. Measure project-scale effects before
broadening it.

```ts
import { Effect } from "effect";
import { IncrementalBuildSession } from "funscript";

const session = new IncrementalBuildSession(process.cwd());
const result = await Effect.runPromise(session.build({
  "src/main.fun": "export answer = 42",
}));
if (result.check.success) {
  console.log(result.outputs["src/main.fun"], result.compiled, result.reused);
}
```

Pass all project source files again on each build. Use a separate session per
project, and call `clear()` to discard its cache. A session performs one build
at a time. It currently provides TypeScript text, rather than writing files or
producing source maps. A one-shot `funscript build` is unchanged.
