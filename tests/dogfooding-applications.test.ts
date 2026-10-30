import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect, Equal, Data } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileString } from "../src/compiler.js";
import { typeCheckFiles, typeCheckSource } from "../src/compiler/check.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/cli/index.js");

describe("Dogfooding Real-World Applications (TASK-027)", () => {
  const programsDir = path.resolve("programs");
  const examplesDir = path.resolve("examples");

  describe("Application 1: GitHub REST API Client (05-github-api-client.fun)", () => {
    const programPath = path.join(programsDir, "05-github-api-client.fun");
    const examplePath = path.join(examplesDir, "github-api-client.fun");

    it("compiles cleanly to TypeScript with Effect, Schema, and ts-pattern", async () => {
      const source = await fs.readFile(programPath, "utf-8");
      const res = await Effect.runPromise(compileString(source, programPath));

      expect(res.targetExtension).toBe(".ts");
      expect(res.typescript).toBeDefined();

      // Schema definitions
      expect(res.typescript).toContain("export const Repository = Schema.Struct({");
      expect(res.typescript).toContain("export type Repository = typeof Repository.Type;");
      expect(res.typescript).toContain("export type ApiResponse = Data.TaggedEnum<{");

      // Effect error class
      expect(res.typescript).toContain("export class GithubApiError extends Schema.TaggedError<GithubApiError>()(");

      // ts-pattern matching
      expect(res.typescript).toContain("match(res)");
      expect(res.typescript).toContain('.with({ _tag: "Success" }');
      expect(res.typescript).toContain('.with({ _tag: "RateLimited" }');
      expect(res.typescript).toContain('.with({ _tag: "NotFound" }');
      expect(res.typescript).toContain('.with({ _tag: "ServerError" }');

      // Foreign promise interop
      expect(res.typescript).toContain("Effect.tryPromise(() => executeFetch(repoPath))");
    });

    it("passes static type checking (funscript check) with 0 errors", async () => {
      const checkResult = await Effect.runPromise(typeCheckFiles([programPath]));
      expect(checkResult.success).toBe(true);
      expect(checkResult.errorCount).toBe(0);
      expect(checkResult.diagnostics).toHaveLength(0);
    });

    it("executes programs/05-github-api-client.fun via CLI with expected deterministic output", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", programPath]);
      expect(stderr).toBe("");

      expect(stdout).toContain("=== GitHub API Client Dogfooding ===");
      expect(stdout).toContain("[GitHub Client] Requesting repository: effect-ts/effect");
      expect(stdout).toContain("[200 OK] Effect-TS/effect - A fully-fledged functional effect system for TypeScript (Stars: 9500, Forks: 680)");
      expect(stdout).toContain("[GitHub Client] Requesting repository: funscript/funscript");
      expect(stdout).toContain("[200 OK] funscript/funscript - Lightweight functional notation compiling directly to TypeScript (Stars: 1337, Forks: 88)");
      expect(stdout).toContain("[GitHub Client] Requesting repository: rate/limit");
      expect(stdout).toContain("[403 Rate Limited] Remaining: 0, Reset timestamp: 1730000000");
      expect(stdout).toContain("[GitHub Client] Requesting repository: ghost/nonexistent");
      expect(stdout).toContain("[404 Not Found] Repository 'ghost/nonexistent' does not exist");
      expect(stdout).toContain("=== GitHub API Client Completed Successfully ===");
    });

    it("executes examples/github-api-client.fun identically", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", examplePath]);
      expect(stderr).toBe("");
      expect(stdout).toContain("[200 OK] Effect-TS/effect");
      expect(stdout).toContain("[200 OK] funscript/funscript");
      expect(stdout).toContain("[403 Rate Limited]");
      expect(stdout).toContain("[404 Not Found]");
    });
  });

  describe("Application 2: Markdown Task Manager CLI (06-markdown-task-manager.fun)", () => {
    const programPath = path.join(programsDir, "06-markdown-task-manager.fun");
    const examplePath = path.join(examplesDir, "markdown-task-manager.fun");

    it("compiles cleanly to TypeScript with Mutative create and control flow", async () => {
      const source = await fs.readFile(programPath, "utf-8");
      const res = await Effect.runPromise(compileString(source, programPath));

      expect(res.targetExtension).toBe(".ts");
      expect(res.typescript).toContain('import { create } from "mutative";');
      expect(res.typescript).toContain("export const Task = Schema.Struct({");

      // when early return and conditional blocks
      expect(res.typescript).toContain('if ((title === "")) return manager;');
      expect(res.typescript).toContain("if ((idx !== (-1))) {");

      // Mutative draft scopes
      expect(res.typescript).toContain("create((draft) => {");
      expect(res.typescript).toContain("draft.push(newTask);");
      expect(res.typescript).toContain("draft.splice(idx, 1, updatedItem);");

      // Explicit returns
      expect(res.typescript).toContain("return (updated);");

      // Effect file system I/O
      expect(res.typescript).toContain("Effect.tryPromise(() => writeTaskFile(filePath, md))");
      expect(res.typescript).toContain("Effect.tryPromise(() => readTaskFile(filePath))");
    });

    it("executes programs/06-markdown-task-manager.fun via CLI and persists/reloads markdown tasks", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", programPath]);
      expect(stderr).toBe("");

      expect(stdout).toContain("=== Markdown Task Manager Starting ===");
      expect(stdout).toContain("[TaskManager] Initialized 3 tasks.");
      expect(stdout).toContain("[TaskManager] Successfully persisted 3 tasks to .funscript-cache/tasks-dogfood.md");
      expect(stdout).toContain("--- Persisted Markdown Content ---");
      expect(stdout).toContain("# Task List");
      expect(stdout).toContain("- [x] #1: Set up FunScript dogfood suite (tag: #dev)");
      expect(stdout).toContain("- [x] #2: Stress-test Mutative draft updates (tag: #compiler)");
      expect(stdout).toContain("- [ ] #3: Document findings in docs/DOGFOODING.md (tag: #docs)");
      expect(stdout).toContain("[TaskManager] Cleaned up temporary test file.");
      expect(stdout).toContain("=== Markdown Task Manager Completed Successfully ===");
    });

    it("executes examples/markdown-task-manager.fun identically", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", examplePath]);
      expect(stderr).toBe("");
      expect(stdout).toContain("- [x] #1: Set up FunScript dogfood suite (tag: #dev)");
      expect(stdout).toContain("- [ ] #3: Document findings in docs/DOGFOODING.md (tag: #docs)");
    });
  });

  describe("Application 3: Reactive UI Widget Component (07-reactive-widget.funx)", () => {
    const programPath = path.join(programsDir, "07-reactive-widget.funx");
    const examplePath = path.join(examplesDir, "reactive-widget.funx");
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "funx-widget-test-"));
    });

    afterAll(async () => {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("compiles cleanly to .tsx with native JSX and ts-pattern branches", async () => {
      const source = await fs.readFile(programPath, "utf-8");
      const res = await Effect.runPromise(compileString(source, programPath));

      expect(res.targetExtension).toBe(".tsx");
      expect(res.typescript).toBeDefined();

      // Schema & tagged union
      expect(res.typescript).toContain("export const WidgetProps = Schema.Struct({");
      expect(res.typescript).toContain("export type WidgetState = Data.TaggedEnum<{");

      // ts-pattern inside component returning JSX
      expect(res.typescript).toContain("match(state)");
      expect(res.typescript).toContain('.with({ _tag: "Idle" }');
      expect(res.typescript).toContain('<span className="badge badge-idle">Status: Idle</span>');
      expect(res.typescript).toContain('.with({ _tag: "Active" }');
      expect(res.typescript).toContain('.with({ _tag: "LimitReached" }');

      // JSX attribute string template interpolation
      expect(res.typescript).toContain('className={`widget-card variant-${props.variant}`}');

      // JSX conditional rendering
      expect(res.typescript).toContain("Equal.equals(props.initialCount, props.max)");
      expect(res.typescript).toContain('<p className="alert alert-warning">Maximum boundary reached!</p>');
    });

    it("passes static type checking (funscript check) with 0 errors", async () => {
      const checkResult = await Effect.runPromise(typeCheckFiles([programPath]));
      expect(checkResult.success).toBe(true);
      expect(checkResult.errorCount).toBe(0);
      expect(checkResult.diagnostics).toHaveLength(0);
    });

    it("executes programs/07-reactive-widget.funx via CLI and evaluates rendered tree", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", programPath]);
      expect(stderr).toBe("");

      expect(stdout).toContain("=== Reactive Widget (.funx) Starting ===");
      expect(stdout).toContain('[Widget] Rendered root tag: <div className="widget-card variant-primary">');
      expect(stdout).toContain("[Widget] Child elements: 3");
      expect(stdout).toContain('[Widget] Boundary root tag: <div className="widget-card variant-danger">');
      expect(stdout).toContain("[Badge] Rendered Idle badge: <span>");
      expect(stdout).toContain("[Badge] Rendered Active badge: <span>");
      expect(stdout).toContain("[Badge] Rendered Limit badge: <span>");
      expect(stdout).toContain("=== Reactive Widget (.funx) Completed Successfully ===");
    });

    it("builds programs/07-reactive-widget.funx to .tsx via CLI build command", async () => {
      const outTsx = path.join(tmpDir, "07-reactive-widget.tsx");
      const { stdout } = await execFileAsync("node", [cliPath, "build", programPath, "--out", outTsx]);
      expect(stdout).toContain(`✓ Built ${outTsx}`);

      const content = await fs.readFile(outTsx, "utf-8");
      expect(content).toContain("export const CounterWidget = (props: WidgetProps) => {");
      expect(content).toContain('className={`widget-card variant-${props.variant}`}');
    });

    it("executes examples/reactive-widget.funx identically", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", examplePath]);
      expect(stderr).toBe("");
      expect(stdout).toContain("=== Reactive Widget (.funx) Starting ===");
      expect(stdout).toContain('[Widget] Rendered root tag: <div className="widget-card variant-primary">');
    });
  });

  describe("Edge Case Stress Testing & Repros", () => {
    it("proves contextual 'when' early return is rejected at module top-level", async () => {
      const topLevelEarlyReturn = "when (flag) => 42\n";
      let errorThrown = false;
      try {
        await Effect.runPromise(compileString(topLevelEarlyReturn, "top.fun"));
      } catch (err: any) {
        errorThrown = true;
        expect(err.message).toContain("Early return 'when (...) =>' is rejected outside function context");
      }
      expect(errorThrown).toBe(true);
    });

    it("verifies deep structural equality on TaggedEnum schemas vs reference equality on records", async () => {
      const adtCode = `
export schema Status =
  | Active(id: Number)
  | Done

export isSameTag = (a: Status, b: Status) => a == b
`.trim();

      const res = await Effect.runPromise(compileString(adtCode, "eq.fun"));
      expect(res.typescript).toContain("Equal.equals(a, b)");

      // Test runtime behavior of Equal.equals on TaggedEnum
      const TaggedStatus = Data.taggedEnum<{ Active: { id: number }; Done: {} }>();
      const s1 = TaggedStatus.Active({ id: 10 });
      const s2 = TaggedStatus.Active({ id: 10 });
      const s3 = TaggedStatus.Active({ id: 20 });
      expect(Equal.equals(s1, s2)).toBe(true);
      expect(Equal.equals(s1, s3)).toBe(false);
    });
  });
});
