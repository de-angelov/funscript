import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/benchmark-compile.mjs");
const smallFixturePath = resolve(root, "tests/fixtures/benchmarks/small.fun");
const pipelineFixturePath = resolve(root, "tests/fixtures/benchmarks/pipeline.fun");

describe("compilation benchmarks", () => {
  it("compiles the small-file benchmark fixture cleanly", () => {
    const source = readFileSync(smallFixturePath, "utf8");
    const result = Effect.runSync(compileString(source, "small.fun"));
    expect(result.typescript).toContain("export const square");
    expect(result.typescript).toContain("export const compute");
  });

  it("compiles the pipeline benchmark fixture cleanly", () => {
    const source = readFileSync(pipelineFixturePath, "utf8");
    const result = Effect.runSync(compileString(source, "pipeline.fun"));
    expect(result.typescript).toContain("pipe(");
    expect(result.typescript).toContain("Array.map(double)");
    expect(result.typescript).toContain("Array.filter(");
  });

  it("runs the benchmark script and outputs structured JSON with nonzero timings", () => {
    const stdout = execFileSync(
      process.execPath,
      [script, "--warmups", "0", "--iterations", "1", "--json"],
      { encoding: "utf8", cwd: root }
    );

    const report = JSON.parse(stdout);
    expect(report.environment).toBeDefined();
    expect(report.environment.nodeVersion).toBe(process.version);
    expect(report.configuration.contextConstructionIncluded).toBe(true);
    expect(report.results).toHaveLength(2);

    const smallResult = report.results.find((r: any) => r.id === "small-file");
    expect(smallResult).toBeDefined();
    expect(smallResult.stats.median).toBeGreaterThan(0);
    expect(smallResult.contextConstruction).toContain("TypeScriptCompilationContext");

    const pipelineResult = report.results.find((r: any) => r.id === "pipeline");
    expect(pipelineResult).toBeDefined();
    expect(pipelineResult.stats.median).toBeGreaterThan(0);
    expect(pipelineResult.contextConstruction).toContain("TypeScriptCompilationContext");
  });
});
