#!/usr/bin/env node

/**
 * FunScript Tooling & Compilation Benchmark Runner
 *
 * Measures:
 * 1. .funx JSX component compilation (compileString)
 * 2. Multi-file project compilation and real import resolution (typeCheckFiles)
 * 3. LSP diagnostic request and response latency (FunScriptLspServer didChange -> publishDiagnostics)
 *
 * Usage:
 *   node scripts/benchmark-tooling.mjs [--iterations <n>] [--warmup <n>] [--json]
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import {
  compileString,
  typeCheckFiles,
  FunScriptLspServer,
} from "../dist/index.js";

// CLI parameter parsing
const args = process.argv.slice(2);
const isJson = args.includes("--json");
const customIterationsIdx = args.indexOf("--iterations");
const customIterations = customIterationsIdx !== -1 ? parseInt(args[customIterationsIdx + 1], 10) : undefined;
const customWarmupIdx = args.indexOf("--warmup");
const customWarmup = customWarmupIdx !== -1 ? parseInt(args[customWarmupIdx + 1], 10) : undefined;

function getEnvironmentInfo() {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    architecture: process.arch,
    cpuModel: cpus[0]?.model ?? "Unknown CPU",
    cpuCores: cpus.length,
    totalMemoryGb: (os.totalmem() / (1024 ** 3)).toFixed(1),
    timestamp: new Date().toISOString(),
  };
}

function calculateDistribution(samples) {
  if (samples.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, stddev: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;
  const median =
    n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
  const p95Index = Math.min(Math.floor(n * 0.95), n - 1);
  const p95 = sorted[p95Index];
  const variance =
    sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  return {
    count: n,
    min,
    max,
    mean,
    median,
    p95,
    stddev,
  };
}

async function benchmarkFunxCompile(rootDir, warmupCount, sampleCount) {
  const fixturePath = resolve(rootDir, "tests/fixtures/benchmarks/widget.funx");
  const source = await readFile(fixturePath, "utf-8");
  const options = { sourcemap: true };

  // Warmup iterations outside the measurement
  for (let i = 0; i < warmupCount; i++) {
    const res = await Effect.runPromise(
      compileString(source, "tests/fixtures/benchmarks/widget.funx", options),
    );
    if (res.targetExtension !== ".tsx") {
      throw new Error(`Unexpected targetExtension in warmup: ${res.targetExtension}`);
    }
  }

  // Measured iterations
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const t0 = performance.now();
    const res = await Effect.runPromise(
      compileString(source, "tests/fixtures/benchmarks/widget.funx", options),
    );
    const t1 = performance.now();

    if (res.targetExtension !== ".tsx") {
      throw new Error(`Expected .tsx targetExtension, got ${res.targetExtension}`);
    }
    if (!res.typescript.includes("export const Button")) {
      throw new Error("Missing expected emitted TSX output");
    }
    samples.push(t1 - t0);
  }

  return {
    label: "funx-compile",
    title: ".funx JSX Component Compilation",
    description: "Compiles a .funx component AST to TSX and generates source map",
    entryPoint: "compileString(source, 'widget.funx', { sourcemap: true })",
    fixture: "tests/fixtures/benchmarks/widget.funx",
    fixtureBytes: Buffer.byteLength(source, "utf-8"),
    warmupCount,
    sampleCount,
    stats: calculateDistribution(samples),
  };
}

async function benchmarkMultiFileProject(rootDir, warmupCount, sampleCount) {
  const projDir = resolve(rootDir, "tests/fixtures/benchmarks/project");
  const mathFile = join(projDir, "math.fun");
  const appFile = join(projDir, "app.fun");
  const files = [mathFile, appFile];
  const options = {
    compilerOptions: {
      rootDir: projDir,
      types: [],
    },
  };

  const mathSource = await readFile(mathFile, "utf-8");
  const appSource = await readFile(appFile, "utf-8");
  const totalBytes = Buffer.byteLength(mathSource, "utf-8") + Buffer.byteLength(appSource, "utf-8");

  // Warmup iterations outside the measurement
  for (let i = 0; i < warmupCount; i++) {
    const res = await Effect.runPromise(typeCheckFiles(files, options));
    if (!res.success) {
      throw new Error(`Multi-file check failed in warmup: ${JSON.stringify(res.diagnostics)}`);
    }
  }

  // Measured iterations
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    const t0 = performance.now();
    const res = await Effect.runPromise(typeCheckFiles(files, options));
    const t1 = performance.now();

    if (!res.success) {
      throw new Error(`Multi-file check failed: ${JSON.stringify(res.diagnostics)}`);
    }
    if (res.diagnostics.length !== 0) {
      throw new Error(`Expected 0 diagnostics, got ${res.diagnostics.length}`);
    }
    samples.push(t1 - t0);
  }

  return {
    label: "multi-file-project",
    title: "Multi-File Project Import Resolution & Typecheck",
    description: "Compiles multiple modules and resolves real import across module boundary via TypeScript host",
    entryPoint: "typeCheckFiles([math.fun, app.fun], { compilerOptions })",
    fixture: "tests/fixtures/benchmarks/project/{math.fun,app.fun}",
    fixtureBytes: totalBytes,
    warmupCount,
    sampleCount,
    stats: calculateDistribution(samples),
  };
}

async function benchmarkLspDiagnostics(rootDir, warmupCount, sampleCount) {
  const fixturePath = resolve(rootDir, "tests/fixtures/benchmarks/lsp-diagnostics.fun");
  const source = await readFile(fixturePath, "utf-8");
  const docUri = "file:///tests/fixtures/benchmarks/lsp-diagnostics.fun";

  const server = new FunScriptLspServer();
  // Open document initially
  server.onDidOpenHandler({
    textDocument: {
      uri: docUri,
      languageId: "funscript",
      version: 1,
      text: source,
    },
  });

  let versionCounter = 2;

  // Warmup iterations
  for (let i = 0; i < warmupCount; i++) {
    const diagPromise = new Promise((resolve) => server.once("diagnostics", resolve));
    server.onDidChangeHandler({
      textDocument: {
        uri: docUri,
        version: versionCounter++,
      },
      contentChanges: [{ text: source }],
    });
    await diagPromise;
  }

  // Measured iterations
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    let responseParams = null;
    const diagPromise = new Promise((resolve) => {
      server.once("diagnostics", (params) => {
        responseParams = params;
        resolve(params);
      });
    });

    const t0 = performance.now();
    server.onDidChangeHandler({
      textDocument: {
        uri: docUri,
        version: versionCounter++,
      },
      contentChanges: [{ text: source }],
    });
    await diagPromise;
    const t1 = performance.now();

    if (!responseParams || responseParams.uri !== docUri) {
      throw new Error(`Unexpected LSP diagnostic response URI: ${responseParams?.uri}`);
    }
    if (!Array.isArray(responseParams.diagnostics) || responseParams.diagnostics.length === 0) {
      throw new Error("LSP timing did not receive expected diagnostic response payload");
    }

    samples.push(t1 - t0);
  }

  return {
    label: "lsp-diagnostic",
    title: "LSP Diagnostic Request & Response Latency",
    description: "Measures onDidChangeHandler dispatch through syntax validation to publishDiagnostics response",
    entryPoint: "server.onDidChangeHandler -> 'diagnostics' event listener",
    fixture: "tests/fixtures/benchmarks/lsp-diagnostics.fun",
    fixtureBytes: Buffer.byteLength(source, "utf-8"),
    warmupCount,
    sampleCount,
    stats: calculateDistribution(samples),
  };
}

function formatTable(workloads) {
  const headers = ["Workload", "Warmup", "Samples", "Min (ms)", "Median (ms)", "Mean (ms)", "p95 (ms)", "Max (ms)", "StdDev (ms)"];
  const rows = workloads.map((w) => [
    w.label,
    String(w.warmupCount),
    String(w.sampleCount),
    w.stats.min.toFixed(3),
    w.stats.median.toFixed(3),
    w.stats.mean.toFixed(3),
    w.stats.p95.toFixed(3),
    w.stats.max.toFixed(3),
    w.stats.stddev.toFixed(3),
  ]);

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
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

async function main() {
  const rootDir = resolve(import.meta.dirname, "..");
  const env = getEnvironmentInfo();

  // Workload parameters (balanced for precision and fast execution)
  const funxWarmup = customWarmup ?? 5;
  const funxSamples = customIterations ?? 20;

  const multiWarmup = customWarmup ?? 2;
  const multiSamples = customIterations ?? 5;

  const lspWarmup = customWarmup ?? 5;
  const lspSamples = customIterations ?? 20;

  const results = [];

  results.push(await benchmarkFunxCompile(rootDir, funxWarmup, funxSamples));
  results.push(await benchmarkMultiFileProject(rootDir, multiWarmup, multiSamples));
  results.push(await benchmarkLspDiagnostics(rootDir, lspWarmup, lspSamples));

  if (isJson) {
    console.log(JSON.stringify({ environment: env, workloads: results }, null, 2));
    return;
  }

  console.log("================================================================================");
  console.log("                FunScript Tooling & Compilation Benchmarks                      ");
  console.log("================================================================================");
  console.log(`Environment : Node ${env.nodeVersion} (V8 ${env.v8Version}) on ${env.platform} (${env.architecture})`);
  console.log(`Host CPU    : ${env.cpuModel} (${env.cpuCores} logical cores)`);
  console.log(`Memory      : ${env.totalMemoryGb} GB total`);
  console.log(`Timestamp   : ${env.timestamp}`);
  console.log("--------------------------------------------------------------------------------\n");

  for (const w of results) {
    console.log(`● Workload: ${w.title} [${w.label}]`);
    console.log(`  Description : ${w.description}`);
    console.log(`  Entry Point : ${w.entryPoint}`);
    console.log(`  Fixture     : ${w.fixture} (${w.fixtureBytes} bytes)`);
    console.log(`  Samples     : ${w.sampleCount} measured iterations (${w.warmupCount} warmups)`);
    console.log(`  Median      : ${w.stats.median.toFixed(3)} ms (p95: ${w.stats.p95.toFixed(3)} ms, spread: ${(w.stats.max - w.stats.min).toFixed(3)} ms)`);
    console.log("");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("                             Benchmark Summary Table                            ");
  console.log("--------------------------------------------------------------------------------");
  console.log(formatTable(results));
  console.log("--------------------------------------------------------------------------------");
  console.log("Baseline investigation guidance:");
  console.log("- Run-to-run variation is typically 5-15% on multi-tasking desktop/CI environments.");
  console.log("- A single outlier iteration does not indicate a regression; evaluate median shifts.");
  console.log("- Investigation threshold: sustained >25% median latency increase across repeated runs.");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
