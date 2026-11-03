#!/usr/bin/env node

/**
 * FunScript compilation benchmark runner.
 *
 * Measures compilation performance of small files and pipelines using
 * the public compileString entry point.
 *
 * Setup (file reading, module loading) is kept outside the timed region.
 * TypeScript context construction (TypeScriptCompilationContext) occurs
 * inside compileString for each compilation and is therefore included in
 * each measurement.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { compileString } from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");

function parseArgs(args) {
  const options = {
    warmups: 3,
    iterations: 5,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--iterations" || arg === "-i") {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val > 0) options.iterations = val;
    } else if (arg === "--warmups" || arg === "-w") {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val >= 0) options.warmups = val;
    }
  }

  return options;
}

function calculateStats(timings) {
  if (timings.length === 0) {
    return { count: 0, median: 0, min: 0, max: 0, spread: 0, mean: 0, stddev: 0 };
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const spread = max - min;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);

  return {
    count: timings.length,
    median: Number(median.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    spread: Number(spread.toFixed(2)),
    mean: Number(mean.toFixed(2)),
    stddev: Number(stddev.toFixed(2)),
  };
}

function runBenchmarkCase({ id, name, filePath, warmups, iterations }) {
  // Setup: read input source outside the timed measurement region
  const source = readFileSync(filePath, "utf8");
  const filename = filePath.split("/").pop();

  // Warmup iterations
  for (let w = 0; w < warmups; w++) {
    Effect.runSync(compileString(source, filename));
  }

  // Measured iterations
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    Effect.runSync(compileString(source, filename));
    const duration = performance.now() - start;
    timings.push(duration);
  }

  const stats = calculateStats(timings);
  return {
    id,
    name,
    file: filePath,
    contextConstruction: "included (TypeScriptCompilationContext created per compileString call)",
    warmups,
    iterations,
    timings: timings.map((t) => Number(t.toFixed(2))),
    stats,
  };
}

function getEnvironmentContext() {
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
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`FunScript Compilation Benchmark Runner

Usage:
  node scripts/benchmark-compile.mjs [options]

Options:
  -i, --iterations <n>   Number of measured iterations (default: 5)
  -w, --warmups <n>      Number of unmeasured warmup iterations (default: 3)
      --json             Output results as formatted JSON
  -h, --help             Show this help message
`);
    process.exit(0);
  }

  const cases = [
    {
      id: "small-file",
      name: "Small file compilation",
      filePath: resolve(root, "tests/fixtures/benchmarks/small.fun"),
    },
    {
      id: "pipeline",
      name: "Pipeline compilation",
      filePath: resolve(root, "tests/fixtures/benchmarks/pipeline.fun"),
    },
  ];

  for (const c of cases) {
    if (!existsSync(c.filePath)) {
      console.error(`Error: Fixture file not found: ${c.filePath}`);
      process.exit(1);
    }
  }

  const env = getEnvironmentContext();

  if (!options.json) {
    console.log("===============================================================");
    console.log("            FunScript Compilation Benchmark Baseline           ");
    console.log("===============================================================");
    console.log(`Node.js:      ${env.nodeVersion} (V8 ${env.v8Version})`);
    console.log(`System:       ${env.osType} ${env.osRelease} (${env.platform} ${env.arch})`);
    console.log(`CPU:          ${env.cpuModel} (${env.cpuCores} cores)`);
    console.log(`Memory:       ${env.totalMemoryGb} GB total (${env.freeMemoryGb} GB free)`);
    console.log(`Config:       ${options.warmups} warmups, ${options.iterations} measured iterations per case`);
    console.log(`Context:      Included in each measurement (TypeScriptCompilationContext)`);
    console.log("---------------------------------------------------------------");
  }

  const results = [];

  for (const c of cases) {
    if (!options.json) {
      console.log(`Running benchmark: ${c.name} (${c.id})...`);
    }

    const result = runBenchmarkCase({
      id: c.id,
      name: c.name,
      filePath: c.filePath,
      warmups: options.warmups,
      iterations: options.iterations,
    });

    results.push(result);

    if (!options.json) {
      console.log(`  File:    ${result.file}`);
      console.log(`  Context: ${result.contextConstruction}`);
      console.log(`  Runs:    [${result.timings.map((t) => `${t.toFixed(1)}ms`).join(", ")}]`);
      console.log(`  Median:  ${result.stats.median.toFixed(2)} ms`);
      console.log(`  Spread:  ${result.stats.spread.toFixed(2)} ms (min: ${result.stats.min.toFixed(2)} ms, max: ${result.stats.max.toFixed(2)} ms)`);
      console.log(`  Mean:    ${result.stats.mean.toFixed(2)} ms (stddev: ${result.stats.stddev.toFixed(2)} ms)`);
      console.log("");
    }
  }

  if (options.json) {
    const report = {
      timestamp: new Date().toISOString(),
      environment: env,
      configuration: {
        warmups: options.warmups,
        iterations: options.iterations,
        contextConstructionIncluded: true,
      },
      results,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("===============================================================");
    console.log("Benchmark complete.");
  }
}

main();
