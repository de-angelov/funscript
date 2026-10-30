import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileString } from "../src/compiler.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("./dist/cli/index.js");
const TMP_DIR = path.resolve("/tmp/opencode/test-sourcemap-" + Date.now());

describe("Source Map Generation (.map) using magic-string", () => {
  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  describe("compileString source map emission", () => {
    it("generates a valid v3 source map for simple variable bindings", async () => {
      const code = `
export name = "Ada"
export age = 36
`.trim();

      const res = await Effect.runPromise(compileString(code, "simple.fun"));

      expect(res.map).toBeDefined();
      const map = res.map!;

      expect(map.version).toBe(3);
      expect(map.sources).toEqual(["simple.fun"]);
      expect(map.sourcesContent).toEqual([code]);
      expect(typeof map.mappings).toBe("string");
      expect(map.mappings.length).toBeGreaterThan(0);

      const tracer = new TraceMap(map.toString());

      // Verify generated line for `export const name = "Ada";`
      const tsLines = res.typescript.split("\n");
      const nameLineIndex = tsLines.findIndex((l) => l.includes("const name ="));
      expect(nameLineIndex).toBeGreaterThanOrEqual(0);

      const pos = originalPositionFor(tracer, {
        line: nameLineIndex + 1,
        column: 0,
      });

      expect(pos.source).toBe("simple.fun");
      expect(pos.line).toBe(1);

      // Verify second declaration `export const age = 36;`
      const ageLineIndex = tsLines.findIndex((l) => l.includes("const age ="));
      expect(ageLineIndex).toBeGreaterThanOrEqual(0);

      const agePos = originalPositionFor(tracer, {
        line: ageLineIndex + 1,
        column: 0,
      });
      expect(agePos.source).toBe("simple.fun");
      expect(agePos.line).toBe(2);
    });

    it("correctly offsets line numbers when runtime imports are added to header", async () => {
      const code = `
export add = (a: Number, b: Number) -> a + b
export res = 5 |> add(10, _)
`.trim();

      const res = await Effect.runPromise(compileString(code, "pipe.fun"));
      expect(res.map).toBeDefined();
      expect(res.typescript).toContain('import { pipe } from "effect";');

      const tracer = new TraceMap(res.map!.toString());
      const tsLines = res.typescript.split("\n");

      // Header import line should not map to source
      const importLineIndex = tsLines.findIndex((l) => l.includes('import { pipe } from "effect";'));
      expect(importLineIndex).toBeGreaterThanOrEqual(0);
      const importPos = originalPositionFor(tracer, {
        line: importLineIndex + 1,
        column: 0,
      });
      expect(importPos.source).toBeNull();

      // Find the add function line in emitted TypeScript
      const addLineIndex = tsLines.findIndex((l) => l.includes("export const add ="));
      expect(addLineIndex).toBeGreaterThan(importLineIndex); // must be after header

      const addPos = originalPositionFor(tracer, {
        line: addLineIndex + 1,
        column: 0,
      });
      expect(addPos.source).toBe("pipe.fun");
      expect(addPos.line).toBe(1);

      // Find the pipeline expression line
      const resLineIndex = tsLines.findIndex((l) => l.includes("export const res ="));
      const resPos = originalPositionFor(tracer, {
        line: resLineIndex + 1,
        column: 0,
      });
      expect(resPos.source).toBe("pipe.fun");
      expect(resPos.line).toBe(2);
    });

    it("maps block statements inside functions", async () => {
      const code = `
export compute = (x: Number) ->
  a = x + 1
  b = a * 2
  b + 10
`.trim();

      const res = await Effect.runPromise(compileString(code, "compute.fun"));
      expect(res.map).toBeDefined();

      const tracer = new TraceMap(res.map!.toString());
      const tsLines = res.typescript.split("\n");

      const computeLine = tsLines.findIndex((l) => l.includes("export const compute ="));
      expect(computeLine).toBeGreaterThanOrEqual(0);

      const pos = originalPositionFor(tracer, {
        line: computeLine + 1,
        column: 0,
      });
      expect(pos.source).toBe("compute.fun");
      expect(pos.line).toBe(1);
    });

    it("maps effect blocks accurately", async () => {
      const code = `
export main = effect
  _ <- Console.log("Hello")
  "Done"
`.trim();

      const res = await Effect.runPromise(compileString(code, "effect.fun"));
      expect(res.map).toBeDefined();

      const tracer = new TraceMap(res.map!.toString());
      const tsLines = res.typescript.split("\n");

      const mainLine = tsLines.findIndex((l) => l.includes("export const main = Effect.gen"));
      expect(mainLine).toBeGreaterThanOrEqual(0);

      const mainPos = originalPositionFor(tracer, {
        line: mainLine + 1,
        column: 0,
      });
      expect(mainPos.source).toBe("effect.fun");
      expect(mainPos.line).toBe(1);
    });

    it("maps schemas and tagged unions", async () => {
      const code = `
export schema User = {
  id: String
  name: String
}

export schema Shape =
  | Circle(radius: Number)
  | Square(size: Number)
`.trim();

      const res = await Effect.runPromise(compileString(code, "schema.fun"));
      expect(res.map).toBeDefined();

      const tracer = new TraceMap(res.map!.toString());
      const tsLines = res.typescript.split("\n");

      // User schema
      const userLine = tsLines.findIndex((l) => l.includes("const User = Schema.Struct"));
      expect(userLine).toBeGreaterThanOrEqual(0);
      const userPos = originalPositionFor(tracer, {
        line: userLine + 1,
        column: 0,
      });
      expect(userPos.source).toBe("schema.fun");
      expect(userPos.line).toBe(1);

      // Shape schema
      const shapeLine = tsLines.findIndex((l) => l.includes("type Shape = Data.TaggedEnum"));
      expect(shapeLine).toBeGreaterThanOrEqual(0);
      const shapePos = originalPositionFor(tracer, {
        line: shapeLine + 1,
        column: 0,
      });
      expect(shapePos.source).toBe("schema.fun");
      expect(shapePos.line).toBe(6);
    });

    it("does not generate map when options.sourcemap is false", async () => {
      const code = `export a = 1`;
      const res = await Effect.runPromise(compileString(code, "no-map.fun", { sourcemap: false }));
      expect(res.map).toBeUndefined();
    });
  });

  describe("CLI build and emit command with --sourcemap", () => {
    it("emits .map files alongside .ts/.tsx files with --sourcemap flag", async () => {
      // 1. build with explicit --out
      const funFile = path.join(TMP_DIR, "app.fun");
      const tsFile = path.join(TMP_DIR, "app.ts");
      const mapFile = path.join(TMP_DIR, "app.ts.map");

      const funCode = `
export schema Config = {
  port: Number
}

export start = (port: Number) -> port + 1
`.trim();

      await fs.writeFile(funFile, funCode, "utf-8");

      const { stdout } = await execFileAsync("node", [
        CLI_PATH,
        "build",
        funFile,
        "--out",
        tsFile,
        "--sourcemap",
      ]);

      expect(stdout).toContain(`✓ Built ${mapFile}`);
      expect(stdout).toContain(`✓ Built ${tsFile}`);

      const tsContent = await fs.readFile(tsFile, "utf-8");
      const mapContent = await fs.readFile(mapFile, "utf-8");

      expect(tsContent).toContain("//# sourceMappingURL=app.ts.map");

      const mapJson = JSON.parse(mapContent);
      expect(mapJson.version).toBe(3);
      expect(mapJson.sources).toEqual([funFile]);
      expect(mapJson.sourcesContent).toEqual([funCode]);
      expect(mapJson.mappings).toBeDefined();

      const tracer = new TraceMap(mapJson);
      const tsLines = tsContent.split("\n");
      const startLine = tsLines.findIndex((l) => l.includes("const start ="));
      expect(startLine).toBeGreaterThanOrEqual(0);

      const pos = originalPositionFor(tracer, {
        line: startLine + 1,
        column: 0,
      });
      expect(pos.source).toBe(funFile);
      expect(pos.line).toBe(5);

      // 2. build with default output alongside source
      const defaultFunFile = path.join(TMP_DIR, "service.fun");
      const defaultTsFile = path.join(TMP_DIR, "service.ts");
      const defaultMapFile = path.join(TMP_DIR, "service.ts.map");

      await fs.writeFile(defaultFunFile, `export val = 42\n`, "utf-8");
      await execFileAsync("node", [CLI_PATH, "build", defaultFunFile, "--sourcemap"]);

      const defaultTsContent = await fs.readFile(defaultTsFile, "utf-8");
      const defaultMapContent = await fs.readFile(defaultMapFile, "utf-8");

      expect(defaultTsContent).toContain("export const val = 42;");
      expect(defaultTsContent).toContain("//# sourceMappingURL=service.ts.map");

      const defaultMapJson = JSON.parse(defaultMapContent);
      expect(defaultMapJson.version).toBe(3);
      expect(defaultMapJson.file).toBe("service.ts");

      // 3. emit command with --sourcemap
      const emitFunFile = path.join(TMP_DIR, "emit-test.fun");
      const emitTsFile = path.join(TMP_DIR, "emit-test.ts");
      const emitMapFile = path.join(TMP_DIR, "emit-test.ts.map");

      await fs.writeFile(emitFunFile, `export x = 1\n`, "utf-8");
      await execFileAsync("node", [
        CLI_PATH,
        "emit",
        emitFunFile,
        "--out",
        emitTsFile,
        "--sourcemap",
      ]);

      const emitTsContent = await fs.readFile(emitTsFile, "utf-8");
      const emitMapJson = JSON.parse(await fs.readFile(emitMapFile, "utf-8"));
      expect(emitTsContent).toContain("//# sourceMappingURL=emit-test.ts.map");
      expect(emitMapJson.version).toBe(3);
    }, 15000);
  });
});
