import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { Effect } from "effect";
import {
  startRepl,
  evaluateReplLine,
  compileReplCode,
  setupReplContext,
  isRecoverable,
} from "../src/cli/repl.js";

describe("FunScript Interactive REPL (TASK-020)", () => {
  describe("compileReplCode & Expression Wrapping", () => {
    it("compiles simple expressions by wrapping in repl binding", async () => {
      const res = await compileReplCode("1 + 2");
      expect(res.isExpression).toBe(true);
      expect(res.jsCode).toContain("__repl_res");
      expect(res.jsCode).toContain("1 + 2");
    });

    it("compiles declarations directly without wrapping as expression", async () => {
      const res = await compileReplCode("x = 42");
      expect(res.isExpression).toBe(false);
      expect(res.jsCode).toContain("var x = 42");
    });

    it("compiles functions as declarations", async () => {
      const res = await compileReplCode("fn add(a: Number, b: Number) => a + b");
      expect(res.isExpression).toBe(false);
      expect(res.jsCode).toContain("var add =");
    });

    it("compiles pipelines as expressions", async () => {
      const res = await compileReplCode("5 |> ((n) => n * 2)");
      expect(res.isExpression).toBe(true);
      expect(res.jsCode).toContain("__repl_res");
      expect(res.jsCode).toContain("pipe");
    });
  });

  describe("evaluateReplLine with VM context", () => {
    function createTestContext(): vm.Context {
      const ctx = vm.createContext({});
      setupReplContext(ctx);
      return ctx;
    }

    it("evaluates basic arithmetic expressions", async () => {
      const ctx = createTestContext();
      const val = await evaluateReplLine("10 + 20 * 2", ctx);
      expect(val).toBe(50);
    });

    it("evaluates string literals and operations", async () => {
      const ctx = createTestContext();
      const val = await evaluateReplLine('"Fun" + "Script"', ctx);
      expect(val).toBe("FunScript");
    });

    it("evaluates array literals", async () => {
      const ctx = createTestContext();
      const val = await evaluateReplLine("[1, 2, 3]", ctx);
      expect(val).toEqual([1, 2, 3]);
    });

    it("persists variable bindings across evaluations and permits re-declaration", async () => {
      const ctx = createTestContext();
      const declRes = await evaluateReplLine("x = 10", ctx);
      expect(declRes).toBeUndefined();

      const readVal = await evaluateReplLine("x", ctx);
      expect(readVal).toBe(10);

      const mathVal = await evaluateReplLine("x * 3 + 2", ctx);
      expect(mathVal).toBe(32);

      // Re-declaration in REPL must succeed without 'already declared' error
      await evaluateReplLine("x = 99", ctx);
      const newVal = await evaluateReplLine("x", ctx);
      expect(newVal).toBe(99);
    });

    it("defines and calls functions across evaluations", async () => {
      const ctx = createTestContext();
      await evaluateReplLine("fn multiply(a: Number, b: Number) => a * b", ctx);
      const res = await evaluateReplLine("multiply(6, 7)", ctx);
      expect(res).toBe(42);
    });

    it("evaluates functional pipelines interactively", async () => {
      const ctx = createTestContext();
      const val = await evaluateReplLine("7 |> ((x) => x * 3) |> ((x) => x + 1)", ctx);
      expect(val).toBe(22);
    });

    it("auto-awaits Effect values via Effect.runPromise", async () => {
      const ctx = createTestContext();
      const val = await evaluateReplLine("Effect.succeed(123)", ctx);
      expect(val).toBe(123);
    });

    it("auto-awaits pipelines returning Effects", async () => {
      const ctx = createTestContext();
      const val = await evaluateReplLine(
        "5 |> ((n) => Effect.succeed(n * 4))",
        ctx
      );
      expect(val).toBe(20);
    });

    it("evaluates multi-line effect blocks and returns computed result", async () => {
      const ctx = createTestContext();
      const effectBlock = [
        "effect",
        "  a <- Effect.succeed(15)",
        "  b <- Effect.succeed(25)",
        "  a + b",
      ].join("\n");

      const val = await evaluateReplLine(effectBlock, ctx);
      expect(val).toBe(40);
    });

    it("propagates Effect failure as rejected promise / error", async () => {
      const ctx = createTestContext();
      await expect(
        evaluateReplLine('Effect.fail("Something went wrong")', ctx)
      ).rejects.toThrow();
    });

    it("identifies recoverable incomplete input errors", () => {
      expect(isRecoverable(new Error("Expected ')' after parameters"))).toBe(true);
      expect(isRecoverable(new Error("Expected '}' after record schema"))).toBe(true);
      expect(isRecoverable(new Error("Expected indent after 'effect'"))).toBe(true);
      expect(isRecoverable(new Error("Unexpected token '' (DEDENT)"))).toBe(true);
      expect(isRecoverable(new Error("Unterminated string literal at line 1"))).toBe(true);
      expect(isRecoverable(new Error("Banned keyword 'var'"))).toBe(false);
    });
  });

  describe("Interactive REPL Server (node:repl streams)", () => {
    it("runs an interactive session through PassThrough streams", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let captured = "";

      output.on("data", (chunk) => {
        captured += chunk.toString();
      });

      const server = startRepl({
        prompt: "fs> ",
        input,
        output,
        terminal: false,
        showBanner: false,
      });

      input.write("1 + 2\n");
      input.write("msg = \"hello\"\n");
      input.write("msg + \" world\"\n");
      input.write("Effect.succeed(42)\n");

      // Give event loop time to process REPL evaluation
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(captured).toContain("3");
      expect(captured).toContain("'hello world'");
      expect(captured).toContain("42");
      expect(captured).not.toContain("Cannot find name 'msg'");

      server.close();
    });

    it("handles multi-line effect block with continuation prompt in REPL streams", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let captured = "";

      output.on("data", (chunk) => {
        captured += chunk.toString();
      });

      const server = startRepl({
        prompt: "fs> ",
        input,
        output,
        terminal: false,
        showBanner: false,
      });

      input.write("effect\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      input.write("  val <- Effect.succeed(77)\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      input.write("  val + 3\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      input.write("\n");
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(captured).toContain("80");
      server.close();
    });
  });

  describe("CLI Command Integration (funscript repl)", () => {
    it("spawns the CLI in repl mode and responds over stdio", async () => {
      const cliPath = path.resolve(__dirname, "../dist/cli/index.js");
      const child = spawn("node", [cliPath, "repl"]);

      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });

      child.stdin.write("10 + 20\n");
      child.stdin.write("Effect.succeed(100)\n");
      child.stdin.end();

      const exitCode = await new Promise((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      expect(exitCode).toBe(0);
      expect(output).toContain("30");
      expect(output).toContain("100");
    });
  });
});
