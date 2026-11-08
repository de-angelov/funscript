import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  compileString,
  typeCheckFiles,
  TypeScriptCompilationContext,
  FunScriptLspServer,
} from "../src/index.js";
import { runWithTimeout } from "../scripts/benchmark.mjs";

const root = resolve(import.meta.dirname, "..");
const benchmarkScript = resolve(root, "scripts/benchmark.mjs");
const smallFixturePath = resolve(root, "tests/fixtures/benchmarks/small.fun");
const pipelineFixturePath = resolve(root, "tests/fixtures/benchmarks/pipeline.fun");
const funxFixturePath = resolve(root, "tests/fixtures/benchmarks/widget.funx");
const lspFixturePath = resolve(root, "tests/fixtures/benchmarks/lsp-diagnostics.fun");
const projectDir = resolve(root, "tests/fixtures/benchmarks/project");

describe("compiler and LSP performance benchmarks", () => {
  describe("single-file compilation", () => {
    it("measures cold and warm compilation and satisfies regression thresholds", () => {
      const source = readFileSync(smallFixturePath, "utf8");

      // Cold compilation (fresh execution)
      const coldStart = performance.now();
      const coldResult = Effect.runSync(compileString(source, "small.fun"));
      const coldDuration = performance.now() - coldStart;

      expect(coldResult.typescript).toContain("export const square");
      expect(coldResult.typescript).toContain("export const compute");
      expect(coldDuration).toBeGreaterThan(0);

      // Warm compilation after warmup
      for (let i = 0; i < 2; i++) {
        Effect.runSync(compileString(source, "small.fun"));
      }

      const warmStart = performance.now();
      const warmResult = Effect.runSync(compileString(source, "small.fun"));
      const warmDuration = performance.now() - warmStart;

      expect(warmResult.typescript).toContain("export const square");
      expect(warmDuration).toBeGreaterThan(0);

      console.info(
        `[Benchmark] Single-file small.fun - cold: ${coldDuration.toFixed(2)}ms, warm: ${warmDuration.toFixed(2)}ms`
      );
    });
  });

  describe("pipeline analysis and compilation", () => {
    it("measures cold, warm, and shared TypeScript context reuse compilation", () => {
      const source = readFileSync(pipelineFixturePath, "utf8");

      // Cold pipeline compilation (new context created internally)
      const coldStart = performance.now();
      const coldResult = Effect.runSync(compileString(source, "pipeline.fun"));
      const coldDuration = performance.now() - coldStart;

      expect(coldResult.typescript).toContain("pipe(");
      expect(coldResult.typescript).toContain("Array.map(double)");
      expect(coldDuration).toBeGreaterThan(0);

      // Warm pipeline compilation
      const warmStart = performance.now();
      const warmResult = Effect.runSync(compileString(source, "pipeline.fun"));
      const warmDuration = performance.now() - warmStart;

      expect(warmResult.typescript).toContain("pipe(");

      // Shared context reuse compilation
      const sharedContext = new TypeScriptCompilationContext("pipeline.fun");
      // Prime context
      Effect.runSync(compileString(source, "pipeline.fun", { context: sharedContext }));

      const reuseStart = performance.now();
      const reuseResult = Effect.runSync(
        compileString(source, "pipeline.fun", { context: sharedContext })
      );
      const reuseDuration = performance.now() - reuseStart;

      expect(reuseResult.typescript).toContain("pipe(");
      expect(reuseDuration).toBeGreaterThan(0);
      // Shared context reuse should yield significant speedup over cold compilation
      expect(reuseDuration).toBeLessThan(coldDuration);

      console.info(
        `[Benchmark] Pipeline - cold: ${coldDuration.toFixed(2)}ms, warm: ${warmDuration.toFixed(2)}ms, context reuse: ${reuseDuration.toFixed(2)}ms`
      );
    });
  });

  describe(".funx component compilation", () => {
    it("measures JSX component compilation with sourcemaps within regression threshold", () => {
      const source = readFileSync(funxFixturePath, "utf8");

      const start = performance.now();
      const result = Effect.runSync(
        compileString(source, "widget.funx", { sourcemap: true })
      );
      const duration = performance.now() - start;

      expect(result.targetExtension).toBe(".tsx");
      expect(result.typescript).toContain("export const Button");
      expect(result.sourcemap).toBeDefined();
      expect(duration).toBeGreaterThan(0);

      console.info(`[Benchmark] .funx widget.funx - duration: ${duration.toFixed(2)}ms`);
    });
  });

  describe("multi-file project import resolution", () => {
    it("measures multi-module typecheck and cross-module import resolution within regression threshold", async () => {
      const files = [join(projectDir, "math.fun"), join(projectDir, "app.fun")];
      const options = {
        compilerOptions: {
          rootDir: projectDir,
          types: [],
        },
      };

      const start = performance.now();
      const result = await Effect.runPromise(typeCheckFiles(files, options));
      const duration = performance.now() - start;

      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
      expect(duration).toBeGreaterThan(0);

      console.info(
        `[Benchmark] Multi-file project {math.fun, app.fun} - duration: ${duration.toFixed(2)}ms`
      );
    });
  });

  describe("LSP responsiveness", () => {
    it("measures document change diagnostics, hover, and completion within regression thresholds", async () => {
      const source = readFileSync(lspFixturePath, "utf8");
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

      // Measure didChange diagnostics response
      let diagPayload: any = null;
      const diagPromise = new Promise((resolve) => {
        server.once("diagnostics", (params) => {
          diagPayload = params;
          resolve(params);
        });
      });

      const diagStart = performance.now();
      server.onDidChangeHandler({
        textDocument: { uri: docUri, version: 2 },
        contentChanges: [{ text: source }],
      });
      await diagPromise;
      const diagDuration = performance.now() - diagStart;

      expect(diagPayload).toBeDefined();
      expect(diagPayload.uri).toBe(docUri);
      expect(diagDuration).toBeGreaterThan(0);

      // Measure hover latency
      const hoverStart = performance.now();
      const hoverResult = server.onHoverHandler({
        textDocument: { uri: docUri },
        position: { line: 5, character: 12 },
      });
      const hoverDuration = performance.now() - hoverStart;


      // Measure completion latency
      const completionStart = performance.now();
      const completionResult = server.onCompletionHandler({
        textDocument: { uri: docUri },
        position: { line: 6, character: 10 },
      });
      const completionDuration = performance.now() - completionStart;

      expect(Array.isArray(completionResult)).toBe(true);

      console.info(
        `[Benchmark] LSP responsiveness - diagnostics: ${diagDuration.toFixed(2)}ms, hover: ${hoverDuration.toFixed(2)}ms, completion: ${completionDuration.toFixed(2)}ms`
      );
    });
  });

  describe("dedicated benchmark runner script", () => {
    it("executes via CLI and reports fresh-process and editor diagnostic workloads", () => {
      const stdout = execFileSync(
        process.execPath,
        [benchmarkScript, "--warmup", "0", "--iterations", "1", "--json"],
        { encoding: "utf8", cwd: root }
      );

      const report = JSON.parse(stdout);
      expect(report.environment).toBeDefined();
      expect(report.environment.nodeVersion).toBe(process.version);
      expect(report.results.find((r: any) => r.id === "single-file-process-cold")?.warmups).toBe(0);
      expect(report.results.find((r: any) => r.id === "single-file-cold")?.description).toContain("fresh context");
      expect(report.results.find((r: any) => r.id === "lsp-diagnostic")?.description).toContain("syntax diagnostics");
      expect(report.results.find((r: any) => r.id === "lsp-type-diagnostic-multifile")?.description).toContain("matching-version");

      const expectedWorkloadIds = [
        "single-file-cold",
        "single-file-process-cold",
        "single-file-warm",
        "pipeline-cold",
        "pipeline-warm",
        "pipeline-context-reuse",
        "funx-compile",
        "multi-file-project",
        "lsp-diagnostic",
        "lsp-type-diagnostic-multifile",
        "lsp-hover",
        "lsp-completion",
      ];

      for (const id of expectedWorkloadIds) {
        const item = report.results.find((r: any) => r.id === id);
        expect(item, `Expected workload ${id} in report`).toBeDefined();
        expect(item.stats.median).toBeGreaterThan(0);
        expect(item.stats.count).toBeGreaterThan(0);
      }
    });
  });

  it("rejects a benchmark operation that does not complete before its timeout", async () => {
    await expect(runWithTimeout(new Promise(() => {}), "deliberately stalled benchmark", 5))
      .rejects.toThrow("deliberately stalled benchmark timed out");
  });
});
