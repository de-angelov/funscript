#!/usr/bin/env node

/**
 * FunScript Comprehensive Compiler and LSP Performance Benchmark Runner
 *
 * Measures:
 * 1. Single file compilation (small.fun): cold and warm
 * 2. Pipeline analysis & compilation (pipeline.fun): cold, warm, and shared context reuse
 * 3. .funx JSX component compilation (widget.funx) to TSX with sourcemaps
 * 4. Multi-file project import resolution & typechecking (project/{math.fun,app.fun})
 * 5. LSP responsiveness: document change diagnostics, hover, and completion
 *
 * Usage:
 *   node scripts/benchmark.mjs [--json] [--assert] [--iterations <n>] [--warmup <n>]
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import {
  compileString,
  typeCheckFiles,
  TypeScriptCompilationContext,
  FunScriptLspServer,
} from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");

export const REGRESSION_THRESHOLDS_MS = {
  "single-file-process-cold": 5000,
  "single-file-cold": 50,
  "single-file-warm": 25,
  "pipeline-cold": 3500,
  "pipeline-warm": 3000,
  "pipeline-context-reuse": 350,
  "funx-compile": 50,
  "multi-file-project": 3000,
  "lsp-diagnostic": 25,
  "lsp-type-diagnostic": 5000,
  "lsp-hover": 25,
  "lsp-completion": 25,
};

const BENCHMARK_TIMEOUT_MS = 30_000;

export function runWithTimeout(promise, label, timeoutMs = BENCHMARK_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function measureProcessCold(rootDir, fixturePath, iterations) {
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const child = spawnSync(process.execPath, [resolve(rootDir, "scripts/benchmark.mjs"), "--worker-compile", fixturePath], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: BENCHMARK_TIMEOUT_MS,
    });
    const elapsed = performance.now() - start;
    if (child.error) throw new Error(`Fresh-process compile failed: ${child.error.message}`);
    if (child.status !== 0) throw new Error(`Fresh-process compile failed: ${child.stderr || child.stdout}`);
    timings.push(elapsed);
  }
  return timings;
}

export function parseArgs(args) {
  const options = {
    warmups: 3,
    iterations: 5,
    json: false,
    assert: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--assert") {
      options.assert = true;
    } else if (arg === "--iterations" || arg === "-i") {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val > 0) options.iterations = val;
    } else if (arg === "--warmup" || arg === "--warmups" || arg === "-w") {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val >= 0) options.warmups = val;
    }
  }

  return options;
}

export function calculateStats(timings) {
  if (timings.length === 0) {
    return { count: 0, median: 0, min: 0, max: 0, spread: 0, mean: 0, p95: 0, stddev: 0 };
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const spread = max - min;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  const p95 = sorted[p95Index];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);

  return {
    count: timings.length,
    median: Number(median.toFixed(3)),
    min: Number(min.toFixed(3)),
    max: Number(max.toFixed(3)),
    spread: Number(spread.toFixed(3)),
    mean: Number(mean.toFixed(3)),
    p95: Number(p95.toFixed(3)),
    stddev: Number(stddev.toFixed(3)),
  };
}

export function getEnvironmentContext() {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model || "Unknown",
    cpuCores: cpus.length,
    totalMemoryGb: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
    freeMemoryGb: Number((os.freemem() / (1024 ** 3)).toFixed(2)),
    timestamp: new Date().toISOString(),
  };
}

export function runSingleFileBenchmarks(rootDir, warmups, iterations) {
  const fixturePath = resolve(rootDir, "tests/fixtures/benchmarks/small.fun");
  const source = readFileSync(fixturePath, "utf8");

  // 1. Cold compilation benchmark (each iteration creates a fresh context)
  const coldTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = Effect.runSync(compileString(source, "small.fun"));
    const elapsed = performance.now() - start;
    if (!res.typescript.includes("export const square")) {
      throw new Error("Missing expected emitted typescript in small.fun");
    }
    coldTimings.push(elapsed);
  }

  // 2. Warm compilation benchmark (runs warmup first, then measures)
  for (let w = 0; w < warmups; w++) {
    Effect.runSync(compileString(source, "small.fun"));
  }
  const warmTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = Effect.runSync(compileString(source, "small.fun"));
    const elapsed = performance.now() - start;
    if (!res.typescript.includes("export const compute")) {
      throw new Error("Missing expected emitted typescript in small.fun");
    }
    warmTimings.push(elapsed);
  }

  const processColdTimings = measureProcessCold(rootDir, fixturePath, iterations);
  return [
    {
      id: "single-file-process-cold",
      name: "Single File Process Cold Compilation",
      category: "single-file",
      file: "tests/fixtures/benchmarks/small.fun",
      description: "Wall time for a fresh Node process to load the compiler and compile the fixture",
      warmups: 0,
      iterations,
      timings: processColdTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(processColdTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["single-file-process-cold"],
    },
    {
      id: "single-file-cold",
      name: "Single File Cold Compilation",
      category: "single-file",
      file: "tests/fixtures/benchmarks/small.fun",
      description: "Compiles small.fun with fresh context and unprimed caches",
      warmups: 0,
      iterations,
      timings: coldTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(coldTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["single-file-cold"],
    },
    {
      id: "single-file-warm",
      name: "Single File Warm Compilation",
      category: "single-file",
      file: "tests/fixtures/benchmarks/small.fun",
      description: "Compiles small.fun after warmup iterations",
      warmups,
      iterations,
      timings: warmTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(warmTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["single-file-warm"],
    },
  ];
}

export function runPipelineBenchmarks(rootDir, warmups, iterations) {
  const fixturePath = resolve(rootDir, "tests/fixtures/benchmarks/pipeline.fun");
  const source = readFileSync(fixturePath, "utf8");

  // 1. Cold pipeline compilation (new TypeScriptCompilationContext per call)
  const coldTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = Effect.runSync(compileString(source, "pipeline.fun"));
    const elapsed = performance.now() - start;
    if (!res.typescript.includes("Array.map(double)")) {
      throw new Error("Missing expected pipeline companion emission");
    }
    coldTimings.push(elapsed);
  }

  // 2. Warm pipeline compilation
  for (let w = 0; w < warmups; w++) {
    Effect.runSync(compileString(source, "pipeline.fun"));
  }
  const warmTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = Effect.runSync(compileString(source, "pipeline.fun"));
    const elapsed = performance.now() - start;
    if (!res.typescript.includes("pipe(")) {
      throw new Error("Missing expected pipeline pipe emission");
    }
    warmTimings.push(elapsed);
  }

  // 3. Shared TypeScript context reuse benchmark
  const sharedContext = new TypeScriptCompilationContext("pipeline.fun");
  // Prime the shared context with initial compilation
  Effect.runSync(compileString(source, "pipeline.fun", { context: sharedContext }));

  const reuseTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = Effect.runSync(compileString(source, "pipeline.fun", { context: sharedContext }));
    const elapsed = performance.now() - start;
    if (!res.typescript.includes("pipe(")) {
      throw new Error("Missing expected pipeline output with shared context");
    }
    reuseTimings.push(elapsed);
  }

  return [
    {
      id: "pipeline-cold",
      name: "Pipeline Cold Analysis & Compilation",
      category: "pipeline",
      file: "tests/fixtures/benchmarks/pipeline.fun",
      description: "Compiles pipeline with fresh TypeScriptCompilationContext and companion inference",
      warmups: 0,
      iterations,
      timings: coldTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(coldTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["pipeline-cold"],
    },
    {
      id: "pipeline-warm",
      name: "Pipeline Warm Analysis & Compilation",
      category: "pipeline",
      file: "tests/fixtures/benchmarks/pipeline.fun",
      description: "Compiles pipeline after initial warmup with fresh context per iteration",
      warmups,
      iterations,
      timings: warmTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(warmTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["pipeline-warm"],
    },
    {
      id: "pipeline-context-reuse",
      name: "Pipeline Shared Context Reuse",
      category: "pipeline",
      file: "tests/fixtures/benchmarks/pipeline.fun",
      description: "Compiles pipeline reusing primed TypeScriptCompilationContext (subsequent edit model)",
      warmups: 1,
      iterations,
      timings: reuseTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(reuseTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["pipeline-context-reuse"],
    },
  ];
}

export function runFunxBenchmarks(rootDir, warmups, iterations) {
  const fixturePath = resolve(rootDir, "tests/fixtures/benchmarks/widget.funx");
  const source = readFileSync(fixturePath, "utf8");
  const options = { sourcemap: true };

  for (let w = 0; w < warmups; w++) {
    Effect.runSync(compileString(source, "widget.funx", options));
  }

  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = Effect.runSync(compileString(source, "widget.funx", options));
    const elapsed = performance.now() - start;

    if (res.targetExtension !== ".tsx") {
      throw new Error(`Expected .tsx targetExtension, got ${res.targetExtension}`);
    }
    if (!res.typescript.includes("export const Button")) {
      throw new Error("Missing expected emitted TSX output in widget.funx");
    }
    if (!res.sourcemap) {
      throw new Error("Missing expected sourcemap for widget.funx");
    }
    timings.push(elapsed);
  }

  return [
    {
      id: "funx-compile",
      name: ".funx JSX Component Compilation",
      category: "funx",
      file: "tests/fixtures/benchmarks/widget.funx",
      description: "Compiles typed JSX component to TSX with sourcemap generation",
      warmups,
      iterations,
      timings: timings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(timings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["funx-compile"],
    },
  ];
}

export async function runMultiFileBenchmarks(rootDir, warmups, iterations) {
  const projDir = resolve(rootDir, "tests/fixtures/benchmarks/project");
  const files = [join(projDir, "math.fun"), join(projDir, "app.fun")];
  const options = {
    compilerOptions: {
      rootDir: projDir,
      types: [],
    },
  };

  for (let w = 0; w < warmups; w++) {
    const res = await Effect.runPromise(typeCheckFiles(files, options));
    if (!res.success) {
      throw new Error(`Multi-file warmup check failed: ${JSON.stringify(res.diagnostics)}`);
    }
  }

  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await Effect.runPromise(typeCheckFiles(files, options));
    const elapsed = performance.now() - start;

    if (!res.success) {
      throw new Error(`Multi-file check failed: ${JSON.stringify(res.diagnostics)}`);
    }
    if (res.diagnostics.length !== 0) {
      throw new Error(`Expected 0 diagnostics, got ${res.diagnostics.length}`);
    }
    timings.push(elapsed);
  }

  return [
    {
      id: "multi-file-project",
      name: "Multi-File Project Import Resolution",
      category: "multi-file",
      file: "tests/fixtures/benchmarks/project/{math.fun,app.fun}",
      description: "Compiles multiple modules and resolves cross-module import via TypeScript compiler host",
      warmups,
      iterations,
      timings: timings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(timings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["multi-file-project"],
    },
  ];
}

function waitForDiagnostics(server, uri, version, predicate) {
  return runWithTimeout(new Promise((resolve, reject) => {
    const listener = (params) => {
      if (params.uri !== uri || params.version !== version || !predicate(params)) return;
      server.off("diagnostics", listener);
      resolve(params);
    };
    server.on("diagnostics", listener);
  }), `Diagnostics for ${uri} version ${version}`);
}

async function benchmarkMultiFileTypeDiagnostics(rootDir, warmups, iterations) {
  const projectDir = resolve(rootDir, "tests/fixtures/benchmarks/project");
  const mathPath = join(projectDir, "math.fun");
  const appPath = join(projectDir, "app.fun");
  const mathUri = `file://${mathPath}`;
  const appUri = `file://${appPath}`;
  const mathText = readFileSync(mathPath, "utf8");
  const validApp = readFileSync(appPath, "utf8");
  const invalidApp = validApp.replace("multiplier: 5", 'multiplier: "bad"');
  if (invalidApp === validApp) throw new Error("Multi-file benchmark edit did not match fixture");
  const server = new FunScriptLspServer();
  server.onDidOpenHandler({ textDocument: { uri: mathUri, languageId: "funscript", version: 1, text: mathText } });
  server.onDidOpenHandler({ textDocument: { uri: appUri, languageId: "funscript", version: 1, text: validApp } });
  let version = 2;
  const sample = async (record) => {
    const nextVersion = version++;
    const received = waitForDiagnostics(server, appUri, nextVersion, (p) => p.diagnostics.length > 0);
    const start = performance.now();
    server.onDidChangeHandler({ textDocument: { uri: appUri, version: nextVersion }, contentChanges: [{ text: invalidApp }] });
    const params = await received;
    const elapsed = performance.now() - start;
    if (!params.diagnostics.some((d) => d.code === 2322 || d.message.includes("Type 'string' is not assignable"))) {
      throw new Error(`Expected completed TypeScript diagnostics for edited app.fun; got ${JSON.stringify(params.diagnostics)}`);
    }
    if (record) return elapsed;
  };
  for (let i = 0; i < warmups; i++) await sample(false);
  const samples = [];
  for (let i = 0; i < iterations; i++) samples.push(await sample(true));
  return samples;
}

export async function runLspBenchmarks(rootDir, warmups, iterations) {
  const fixturePath = resolve(rootDir, "tests/fixtures/benchmarks/lsp-diagnostics.fun");
  const source = readFileSync(fixturePath, "utf8");
  const docUri = "file:///tests/fixtures/benchmarks/lsp-diagnostics.fun";

  const server = new FunScriptLspServer();
  server.onDidOpenHandler({
    textDocument: {
      uri: docUri,
      languageId: "funscript",
      version: 1,
      text: source,
    },
  });

  let versionCounter = 2;

  // 1. Immediate syntax diagnostics: this publication is synchronous with didChange.
  const syntaxTimings = [];
  for (let w = 0; w < warmups; w++) {
    const version = versionCounter++;
    const diagPromise = waitForDiagnostics(server, docUri, version, (p) => p.diagnostics.length > 0);
    server.onDidChangeHandler({
      textDocument: { uri: docUri, version },
      contentChanges: [{ text: source }],
    });
    await diagPromise;
  }

  const syntaxTimingsMeasured = [];
  for (let i = 0; i < iterations; i++) {
    const version = versionCounter++;
    const pending = waitForDiagnostics(server, docUri, version, (p) => p.diagnostics.length > 0);
    const start = performance.now();
    server.onDidChangeHandler({ textDocument: { uri: docUri, version }, contentChanges: [{ text: source }] });
    await pending;
    syntaxTimingsMeasured.push(performance.now() - start);
  }

  const multiFileTypeTimings = await benchmarkMultiFileTypeDiagnostics(rootDir, warmups, iterations);

  // 2. LSP onHoverHandler latency
  for (let w = 0; w < warmups; w++) {
    server.onHoverHandler({
      textDocument: { uri: docUri },
      position: { line: 5, character: 12 },
    });
  }

  const hoverTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    server.onHoverHandler({
      textDocument: { uri: docUri },
      position: { line: 5, character: 12 },
    });
    const elapsed = performance.now() - start;
    hoverTimings.push(elapsed);
  }

  // 3. LSP onCompletionHandler latency
  for (let w = 0; w < warmups; w++) {
    server.onCompletionHandler({
      textDocument: { uri: docUri },
      position: { line: 6, character: 10 },
    });
  }

  const completionTimings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    server.onCompletionHandler({
      textDocument: { uri: docUri },
      position: { line: 6, character: 10 },
    });
    const elapsed = performance.now() - start;
    completionTimings.push(elapsed);
  }

  return [
    {
      id: "lsp-diagnostic",
      name: "LSP Immediate Syntax Diagnostics",
      category: "lsp",
      file: "tests/fixtures/benchmarks/lsp-diagnostics.fun",
      description: "Measures synchronous syntax diagnostics for matching document version; fixture intentionally contains syntax errors",
      warmups,
      iterations,
      timings: syntaxTimingsMeasured.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(syntaxTimingsMeasured),
      thresholdMs: REGRESSION_THRESHOLDS_MS["lsp-diagnostic"],
    },
    {
      id: "lsp-type-diagnostic-multifile",
      name: "LSP Completed Multi-File Type Diagnostics",
      category: "lsp",
      file: "tests/fixtures/benchmarks/project/{math.fun,app.fun}",
      description: "Measures didChange through debounce and typecheck until matching-version TypeScript diagnostics publish",
      warmups,
      iterations,
      timings: multiFileTypeTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(multiFileTypeTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["lsp-type-diagnostic"],
    },
    {
      id: "lsp-hover",
      name: "LSP Hover Latency",
      category: "lsp",
      file: "tests/fixtures/benchmarks/lsp-diagnostics.fun",
      description: "Measures onHoverHandler response latency at identifier position",
      warmups,
      iterations,
      timings: hoverTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(hoverTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["lsp-hover"],
    },
    {
      id: "lsp-completion",
      name: "LSP Completion Latency",
      category: "lsp",
      file: "tests/fixtures/benchmarks/lsp-diagnostics.fun",
      description: "Measures onCompletionHandler response latency for scoped symbols",
      warmups,
      iterations,
      timings: completionTimings.map((t) => Number(t.toFixed(3))),
      stats: calculateStats(completionTimings),
      thresholdMs: REGRESSION_THRESHOLDS_MS["lsp-completion"],
    },
  ];
}

export function formatSummaryTable(results) {
  const headers = [
    "Workload",
    "Category",
    "Samples",
    "Median (ms)",
    "Min (ms)",
    "p95 (ms)",
    "Max (ms)",
    "Threshold (ms)",
    "Status",
  ];

  const rows = results.map((r) => {
    const passed = r.stats.median <= r.thresholdMs;
    return [
      r.id,
      r.category,
      String(r.iterations),
      r.stats.median.toFixed(3),
      r.stats.min.toFixed(3),
      r.stats.p95.toFixed(3),
      r.stats.max.toFixed(3),
      String(r.thresholdMs),
      passed ? "PASS" : "REGRESSION",
    ];
  });

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );

  const formatRow = (cols) =>
    cols.map((col, i) => col.padEnd(colWidths[i])).join("  ");

  const separator = colWidths.map((w) => "-".repeat(w)).join("  ");

  return [
    formatRow(headers),
    separator,
    ...rows.map(formatRow),
  ].join("\n");
}

export async function runAllBenchmarks(options = {}) {
  const rootDir = options.rootDir || root;
  const warmups = options.warmups ?? 3;
  const iterations = options.iterations ?? 5;

  const results = [];
  results.push(...runSingleFileBenchmarks(rootDir, warmups, iterations));
  results.push(...runPipelineBenchmarks(rootDir, warmups, iterations));
  results.push(...runFunxBenchmarks(rootDir, warmups, iterations));
  results.push(...(await runMultiFileBenchmarks(rootDir, Math.min(warmups, 2), Math.min(iterations, 3))));
  results.push(...(await runLspBenchmarks(rootDir, warmups, iterations)));

  const regressions = results.filter((r) => r.stats.median > r.thresholdMs);

  return {
    environment: getEnvironmentContext(),
    configuration: { warmups, iterations },
    results,
    passed: regressions.length === 0,
    regressions,
  };
}

async function main() {
  const workerIndex = process.argv.indexOf("--worker-compile");
  if (workerIndex !== -1) {
    const fixturePath = process.argv[workerIndex + 1];
    if (!fixturePath) throw new Error("--worker-compile requires a fixture path");
    const source = readFileSync(fixturePath, "utf8");
    const result = Effect.runSync(compileString(source, fixturePath.split("/").pop()));
    if (!result.typescript) throw new Error("Fresh-process compilation emitted no TypeScript");
    return;
  }
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`FunScript Compiler & LSP Benchmark Runner

Usage:
  node scripts/benchmark.mjs [options]

Options:
  -i, --iterations <n>   Measured iterations per workload (default: 5)
  -w, --warmup <n>       Warmup iterations per workload (default: 3)
      --json             Output results formatted as JSON
      --assert           Exit with code 1 if any regression threshold is exceeded
  -h, --help             Show this help message
`);
    process.exit(0);
  }

  const env = getEnvironmentContext();

  if (!options.json) {
    console.log("================================================================================");
    console.log("             FunScript Compiler & LSP Performance Benchmarks                   ");
    console.log("================================================================================");
    console.log(`Environment : Node ${env.nodeVersion} (V8 ${env.v8Version}) on ${env.platform} (${env.arch})`);
    console.log(`Host CPU    : ${env.cpuModel} (${env.cpuCores} cores)`);
    console.log(`Memory      : ${env.totalMemoryGb} GB total (${env.freeMemoryGb} GB free)`);
    console.log(`Config      : ${options.warmups} warmups, ${options.iterations} iterations per workload`);
    console.log("--------------------------------------------------------------------------------\n");
  }

  const benchmarkReport = await runAllBenchmarks({
    rootDir: root,
    warmups: options.warmups,
    iterations: options.iterations,
  });

  if (options.json) {
    console.log(JSON.stringify(benchmarkReport, null, 2));
  } else {
    for (const r of benchmarkReport.results) {
      const pass = r.stats.median <= r.thresholdMs;
      const statusIcon = pass ? "✓" : "✗ REGRESSION";
      console.log(`● [${r.category}] ${r.name} (${r.id})`);
      console.log(`  File:        ${r.file}`);
      console.log(`  Description: ${r.description}`);
      console.log(`  Runs:        [${r.timings.map((t) => `${t.toFixed(2)}ms`).join(", ")}]`);
      console.log(`  Median:      ${r.stats.median.toFixed(3)} ms (threshold: <= ${r.thresholdMs} ms) -> ${statusIcon}`);
      console.log(`  Spread:      ${r.stats.spread.toFixed(3)} ms (min: ${r.stats.min.toFixed(3)} ms, max: ${r.stats.max.toFixed(3)} ms, p95: ${r.stats.p95.toFixed(3)} ms)`);
      console.log("");
    }

    console.log("--------------------------------------------------------------------------------");
    console.log("                             Benchmark Summary Table                            ");
    console.log("--------------------------------------------------------------------------------");
    console.log(formatSummaryTable(benchmarkReport.results));
    console.log("--------------------------------------------------------------------------------");
    if (!benchmarkReport.passed) {
      console.error(`\n⚠️  PERFORMANCE REGRESSION DETECTED: ${benchmarkReport.regressions.length} workload(s) exceeded threshold.`);
      for (const reg of benchmarkReport.regressions) {
        console.error(`   - ${reg.id}: median ${reg.stats.median.toFixed(3)} ms > threshold ${reg.thresholdMs} ms`);
      }
    } else {
      console.log("\n✓ All performance benchmarks passed regression threshold assertions.");
    }
    console.log("================================================================================\n");
  }

  if (options.assert && !benchmarkReport.passed) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Benchmark runner failed:", err);
    process.exit(1);
  });
}
