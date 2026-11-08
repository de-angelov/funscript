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
