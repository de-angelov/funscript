# Optional developer toolchain helper

After cloning the repository, run `sh scripts/toolchain.sh status` on macOS/Linux or
`./scripts/toolchain.ps1 status` in PowerShell on Windows. The helper supports Node.js
20+ and npm. It links this checkout's `funscript` executable globally for the current
npm prefix; the project has no published CLI release channel yet. It does not install
Node.js or npm. Install Node.js 20+ from [nodejs.org](https://nodejs.org/) first.

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

