# Optional developer toolchain helper

After cloning the repository, run `sh scripts/toolchain.sh status` on macOS/Linux or
`./scripts/toolchain.ps1 status` in PowerShell on Windows. The helper supports Node.js
20+ and npm. It links this checkout's `funscript` executable globally for the current
npm prefix; the project has no published CLI release channel yet. It does not install
Node.js or npm. Install Node.js 20+ from [nodejs.org](https://nodejs.org/) first.
Some example-only development dependencies require Node.js 22.19+; use that version
for a strict-engine development install and for the HTTP example.

Use `install`, `update`, or `uninstall` as the subcommand. Each displays the affected
tool and command, then asks for an interactive confirmation. `--dry-run` (PowerShell:
`-DryRun`) prints the proposed command without executing it. `status` is read-only.
Only the FunScript npm link is removed by `uninstall`; Node, npm, editors, and their
configuration are never changed.

The helper supports POSIX shells on macOS/Linux and PowerShell on Windows, provided
`node` and `npm` are on PATH. Other package managers and unsupported environments
should use the manual route: install Node.js 20+, run `npm install` in this checkout,
then `npm link`. To repair a link, run `npm unlink -g funscript` and `npm link` from
the checkout. To roll back, run `npm unlink -g funscript`.

VS Code is detected when its `code` command is available. The extension is not
published as a VSIX or marketplace package yet, so extension installation is manual
and is not part of the helper. Corepack and other recommended tools are optional and
are not modified.

Inspect the complete helper before running it: `sed -n '1,240p' scripts/toolchain.sh`
or `Get-Content scripts/toolchain.ps1`. All commands are repository-owned; nothing is
downloaded or executed remotely.

## Compilation performance benchmarking

To establish reproducible compilation baselines for small files and pipelines, run
the compilation benchmark script:

```bash
npm run build
node scripts/benchmark-compile.mjs
```

### Options

The benchmark runner supports the following options:

- `-i, --iterations <n>`: Number of measured iterations per test case (default: `5`).
- `-w, --warmups <n>`: Number of initial unmeasured warmup iterations (default: `3`).
- `--json`: Output full benchmark results and environment metadata as JSON.
- `-h, --help`: Display usage and available options.

### Capturing a baseline

To capture and persist a baseline for regression tracking or environment comparison:

```bash
node scripts/benchmark-compile.mjs --json > docs/reference/benchmark-baseline.json
```

Or for human-readable output:

```bash
node scripts/benchmark-compile.mjs > baseline.txt
```

### Context construction and measurement boundaries

- **Setup outside timed region**: File I/O (reading `.fun` fixture files from `tests/fixtures/benchmarks/`)
  and module initialization (`import { compileString } from "../dist/index.js"`) are performed
  prior to the measurement loop.
- **Context construction included**: Each call to the public `compileString` entry point constructs
  an instance of `TypeScriptCompilationContext` to infer type-directed pipeline companions, validate
  numeric comparison constraints, and apply JavaScript interop nullability. Because context
  construction is an integral step of compilation rather than pre-warmed external state, it is
  included in each measurement iteration.
- **Warmup phase**: Unmeasured warmup iterations run first to allow the V8 JIT compiler and internal
  caches to stabilize before timings are recorded.

### Comparison limitations

When interpreting or comparing benchmark results:

1. **Hardware and OS variations**: Timing values vary across CPU architectures, clock frequencies,
   core counts, available memory, and operating systems.
2. **Environment-specific, not universal targets**: Timings must be evaluated relative to a baseline
   captured on the *same machine and configuration*, not treated as universal SLAs or hard CI gates.
3. **TypeScript program initialization**: Pipeline compilation triggers TypeScript type-checking
   over Effect library declarations, which dominates small-file parse and emit times. Variations in
   disk or memory cache state can introduce jitter between runs.

### Example baseline

The following baseline illustrates representative output from an AMD Ryzen AI 7 350 workstation
running Linux under WSL2 with Node.js v20.20.2:

```text
===============================================================
            FunScript Compilation Benchmark Baseline           
===============================================================
Node.js:      v20.20.2 (V8 11.3.244.8-node.38)
System:       Linux 6.18.54.1-microsoft-standard-WSL2 (linux x64)
CPU:          AMD Ryzen AI 7 350 w/ Radeon 860M (16 cores)
Memory:       15.21 GB total (11.31 GB free)
Config:       3 warmups, 5 measured iterations per case
Context:      Included in each measurement (TypeScriptCompilationContext)
---------------------------------------------------------------
Running benchmark: Small file compilation (small-file)...
  File:    tests/fixtures/benchmarks/small.fun
  Context: included (TypeScriptCompilationContext created per compileString call)
  Runs:    [0.9ms, 0.7ms, 0.6ms, 0.5ms, 0.5ms]
  Median:  0.57 ms
  Spread:  0.36 ms (min: 0.50 ms, max: 0.86 ms)
  Mean:    0.64 ms (stddev: 0.14 ms)

Running benchmark: Pipeline compilation (pipeline)...
  File:    tests/fixtures/benchmarks/pipeline.fun
  Context: included (TypeScriptCompilationContext created per compileString call)
  Runs:    [1072.8ms, 1084.6ms, 1092.4ms, 1201.9ms, 1011.1ms]
  Median:  1084.58 ms
  Spread:  190.80 ms (min: 1011.13 ms, max: 1201.93 ms)
  Mean:    1092.57 ms (stddev: 61.72 ms)

===============================================================
Benchmark complete.
```

## Tooling and compilation benchmarks

Run the tooling and compiler benchmark suite to measure single-component `.funx` compilation, multi-file compilation with real import resolution, and LSP diagnostic response latency:

```bash
npm run build
node scripts/benchmark-tooling.mjs
```

Pass `--json` for machine-readable output, or `--iterations <n>` and `--warmup <n>` to customize sampling.

### Measured workloads

1. **`.funx` JSX Component Compilation (`funx-compile`)**:
   - **Entry point**: `compileString(source, "widget.funx", { sourcemap: true })`
   - **Fixture**: `tests/fixtures/benchmarks/widget.funx`
   - **Behavior**: Measures full tokenization, AST construction, TSX emission (`targetExtension: .tsx`), and source map generation for a typed JSX component with props and children.

2. **Multi-File Project Import Resolution (`multi-file-project`)**:
   - **Entry point**: `typeCheckFiles([math.fun, app.fun], { compilerOptions })`
   - **Fixture**: `tests/fixtures/benchmarks/project/{math.fun,app.fun}`
   - **Behavior**: Measures multi-module compilation and real cross-module import resolution via TypeScript compiler host (`app.fun` imports `CalculationConfig` and `compute` from `./math.js`).

3. **LSP Diagnostic Response Latency (`lsp-diagnostic`)**:
   - **Entry point**: `FunScriptLspServer.onDidChangeHandler` -> `diagnostics` event listener
   - **Fixture**: `tests/fixtures/benchmarks/lsp-diagnostics.fun`
   - **Behavior**: Measures latency from an editor change notification through document cache update and syntax validation to receiving the `publishDiagnostics` response payload.

### Repeatable baseline capture & environment context

Benchmark metrics are heavily influenced by the execution environment (Node.js runtime, V8 JIT tiering, CPU architectures, thermal limits, and concurrent OS activity). Baselines represent reference captures on a specific host environment rather than absolute hardware-independent limits.

Captured reference baseline on Linux x64 (Node v20.20.2, AMD Ryzen AI 7 350, 16 cores):

| Workload | Warmup | Samples | Min (ms) | Median (ms) | Mean (ms) | p95 (ms) | Max (ms) | StdDev (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `funx-compile` | 5 | 20 | 0.315 | 0.637 | 0.827 | 3.571 | 3.571 | 0.674 |
| `multi-file-project` | 2 | 5 | 557.999 | 625.592 | 617.222 | 679.558 | 679.558 | 46.332 |
| `lsp-diagnostic` | 5 | 20 | 0.035 | 0.038 | 0.055 | 0.154 | 0.154 | 0.032 |

### Run-to-run variation and practical investigation thresholds

When evaluating performance changes against the baseline:

- **Expected run-to-run variation**: Normal desktop and CI execution exhibits 5% to 15% variation in median timing between subsequent runs due to V8 garbage collection cycles, dynamic CPU throttling, and operating system scheduling.
- **Do not treat noise as regression**: A single outlier sample (visible in max or p95) or a single run's minor fluctuation does not constitute a regression. Never fail builds or assert hard millisecond gates on individual runs.
- **Evaluation protocol**:
  1. Always run `npm run build` prior to running benchmarks so compiled artifacts in `dist/` are up to date.
  2. Execute at least two consecutive runs to observe the warm median distribution.
  3. Compare the **median (`p50`)** latency rather than the maximum or single-sample timings.
- **Practical investigation threshold**:
  - **Sustained shift > 25%**: A regression is confirmed when median latency increases by more than **25%** across multiple repeated benchmark executions (or a sustained >3 standard deviation shift), indicating unexpected overhead in lexing, parsing, emitter allocation, or type-checking resolution.
  - **Shifts < 20%**: Shifts under 20% are within standard multi-tasking OS noise and should be retested before treating as an anomaly.

## Unified compiler and LSP performance benchmarks

Run the unified benchmark suite covering single files (cold and warm), pipeline analysis with TypeScript context reuse, `.funx` JSX components, multi-file projects, and LSP operations:

```bash
npm run build
npm run benchmark
# or run with regression assertion verification
node scripts/benchmark.mjs --assert
```

Or execute the Vitest benchmark test gate:

```bash
npx vitest run tests/benchmark.test.ts --reporter=dot
```

The benchmark test runs all workloads, prints recorded timings, and verifies assertions against established baseline regression thresholds.
