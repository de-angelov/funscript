import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { format } from "../src/formatter/index.js";
import { findHoverAsync } from "../src/lsp/hover.js";
import { FunScriptLspServer, validateFunScript } from "../src/lsp/server.js";
import { compile, execute, expectCompileError, expectNoDiagnostics, typeCheck } from "./helpers/index.js";

describe("AssemblyScript blocks", () => {
  it("compiles numeric kernels and preserves unsigned results", async () => {
    const source = `as {
      // A brace } in a comment does not end the block.
      export function add(a: i32, b: i32): i32 { return a + b; }
      export function unsigned(): u32 { return 0xffffffff; }
    }
export result = add(2, 3)
export high = unsigned()`;
    const output = await execute(source);
    expect(output.result).toBe(5);
    expect(output.high).toBe(4294967295);
  });

  it("surfaces integer traps as catchable JavaScript exceptions", async () => {
    await expect(execute(`as { export function divide(a: i32, b: i32): i32 { return a / b; } }
export result = divide(1, 0)`)).rejects.toThrow();
  });

  it("rejects reference types at the boundary", async () => {
    await expectCompileError('as { export function text(a: string): i32 { return a.length; } }', 'explicit i32, u32, f32, or f64');
  });

  it("reports AssemblyScript compiler errors", async () => {
    await expectCompileError('as { export function broken(a: i32): i32 { return missing; } }', 'AssemblyScript compilation failed');
  });

  it("maps AssemblyScript compiler errors into the enclosing source", async () => {
    const source = `export before = 1
as {
  export function broken(a: i32): i32 {
    return missing;
  }
}`;
    const failure = await expectCompileError(source, { message: "Cannot find name 'missing'", line: 4, column: 12 });
    expect(failure.span?.start.offset).toBe(source.indexOf("missing"));
  });

  it("maps inline AssemblyScript compiler errors to their original column", async () => {
    const source = "as { export function broken(): i32 { return missing; } }";
    const failure = await expectCompileError(source, "Cannot find name 'missing'");
    expect(failure.span?.start.offset).toBe(source.indexOf("missing"));
    expect(failure.span?.start.column).toBe(source.indexOf("missing") + 1);
  });

  it("reports mapped diagnostics during type checking without a false unprepared-block error", async () => {
    const source = `as {
  export function broken(): i32 {
    return absentIdentifier;
  }
}`;
    expect(validateFunScript(source, "diagnostic.fun")).toEqual([]);
    const result = await typeCheck(source, "diagnostic.fun");
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ line: 3, column: 12, message: expect.stringContaining("absentIdentifier") })]));
  });

  it("keeps prepared kernels available after cache eviction", async () => {
    const blocks = Array.from({ length: 65 }, (_, i) => `as { export function kernel${i}(): i32 { return ${i}; } }`).join("\n");
    const output = await execute(`${blocks}\nexport result = kernel0() + kernel64()`);
    expect(output.result).toBe(64);
  }, 60000);

  it("provides editor hover for a kernel in an asynchronously compiled file", async () => {
    const source = `as { export function square(value: f64): f64 { return value * value; } }
export result = square(2)`;
    const hover = await findHoverAsync(source, `file://${process.cwd()}/hover-wasm.fun`, { line: 1, character: 17 });
    expect((hover?.contents as { value: string })?.value).toContain("square:");
    expect((hover?.contents as { value: string })?.value).toContain("number");
  }, 30000);

  it("returns kernel hover through the language-server request", async () => {
    const server = new FunScriptLspServer();
    const uri = `file://${process.cwd()}/hover-wasm.fun`;
    await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1,
      text: `as { export function square(value: f64): f64 { return value * value; } }\nexport result = square(2)` } });
    const response = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "textDocument/hover", params: {
      textDocument: { uri }, position: { line: 1, character: 17 },
    } });
    expect(JSON.stringify(response?.result)).toContain("square:");
  }, 30000);

  it("keeps import aliases working", async () => {
    const result = await compile('import { map as transform } from "effect/Array"\nexport value = 1');
    expect(result.typescript).toContain('map as transform');
  });

  it("runs the numeric example and captures traps with Effect", async () => {
    const source = await readFile("examples/assemblyscript-numeric.fun", "utf8");
    const exports = await execute(source);
    expect(exports.score).toBeCloseTo(0.8247572587, 8);
    const safeDivide = exports.safeDivide as (a: number, b: number) => Effect.Effect<number, unknown>;
    expect(await Effect.runPromise(safeDivide(9, 2))).toBe(4);
    expect(Exit.isFailure(await Effect.runPromiseExit(safeDivide(1, 0)))).toBe(true);
  });

  it("validates numeric inputs and reports traps through typed Effect failures", async () => {
    const output = await execute(`as {
      export function divide(a: i32, b: i32): i32 { return a / b; }
      export function unsigned(value: u32): u32 { return value; }
      export function single(value: f32): f32 { return value; }
      export function double(value: f64): f64 { return value; }
    }
export safeDivide = (a: Number, b: Number) => divide.effect(a, b)
export safeUnsigned = (value: Number) => unsigned.effect(value)
export safeSingle = (value: Number) => single.effect(value)
export safeDouble = (value: Number) => double.effect(value)
export raw = (a: Number, b: Number) => divide(a, b)`);
    const failure = (effect: Effect.Effect<number, unknown>) => Effect.runPromise(Effect.flip(effect));
    expect(await Effect.runPromise(output.safeDivide(9, 2))).toBe(4);
    expect(await failure(output.safeDivide(1.5, 1))).toMatchObject({ _tag: "WasmInputError", function: "divide", parameter: "a", expected: "i32", value: 1.5 });
    expect(await failure(output.safeDivide(2147483648, 1))).toMatchObject({ _tag: "WasmInputError", parameter: "a" });
    expect(await failure(output.safeUnsigned(-1))).toMatchObject({ _tag: "WasmInputError", expected: "u32" });
    expect(await Effect.runPromise(output.safeUnsigned(4294967295))).toBe(4294967295);
    expect(await failure(output.safeSingle(Infinity))).toMatchObject({ _tag: "WasmInputError", expected: "f32" });
    expect(await failure(output.safeSingle(3.5e38))).toMatchObject({ _tag: "WasmInputError", expected: "f32" });
    expect(await failure(output.safeDouble(NaN))).toMatchObject({ _tag: "WasmInputError", expected: "f64" });
    expect(await failure(output.safeDivide(1, 0))).toMatchObject({ _tag: "WasmTrapError", function: "divide", cause: expect.any(Error) });
    expect(() => output.raw(1, 0)).toThrow();
  });

  it("captures initialization failures lazily and retries on subsequent calls", async () => {
    const output = await execute(`as {
      function initialize(): i32 { unreachable(); return 1; }
      let value: i32 = initialize();
      export function read(): i32 { return value; }
    }
export readEffect = read.effect()
export readDirect = () => read()`);
    const first = await Effect.runPromise(Effect.flip(output.readEffect)) as { cause: unknown };
    const second = await Effect.runPromise(Effect.flip(output.readEffect)) as { cause: unknown };
    expect(first).toMatchObject({ _tag: "WasmInitializationError", function: "read", cause: expect.any(Error) });
    expect(second).toMatchObject({ _tag: "WasmInitializationError", function: "read", cause: expect.any(Error) });
    expect(second.cause).not.toBe(first.cause);
    expect(() => output.readDirect()).toThrow();
  });

  it("does not call a kernel until its Effect is run", async () => {
    const output = await execute(`as {
      let calls: i32 = 0;
      export function increment(): i32 { calls++; return calls; }
      export function count(): i32 { return calls; }
    }
export incrementEffect = increment.effect()
export countCalls = () => count()`);
    expect(output.countCalls()).toBe(0);
    expect(await Effect.runPromise(output.incrementEffect)).toBe(1);
    expect(output.countCalls()).toBe(1);
  });

  it("type checks both examples", async () => {
    for (const filename of ["examples/assemblyscript-numeric.fun", "examples/assemblyscript-primes.fun"]) {
      await expectNoDiagnostics(await readFile(filename, "utf8"), filename);
    }
  }, 30000);

  it("runs the prime-counting example", async () => {
    const source = await readFile("examples/assemblyscript-primes.fun", "utf8");
    const exports = await execute(source);
    expect(exports.primesBelow100).toBe(25);
    expect(exports.primesBelow1000).toBe(168);
  });

  it("keeps separate kernels callable in the same module", async () => {
    const output = await execute(`as { export function twice(x: f64): f64 { return x * 2; } }
as { export function plusOne(x: f32): f32 { return x + 1; } }
export result = twice(plusOne(1.25))`);
    expect(output.result).toBe(4.5);
  });

  it("round trips a block through the formatter", async () => {
    const source = await readFile("examples/assemblyscript-numeric.fun", "utf8");
    const formatted = format(source);
    expect(format(formatted)).toBe(formatted);
    const output = await execute(formatted);
    expect(output.score).toBeCloseTo(0.8247572587, 8);
  });

  it.each([
    ['as { export function missing(a: i32) { return a; } }', 'explicit i32'],
    ['as { export function large(a: i64): i64 { return a; } }', 'explicit i32'],
    ['as { export const value: i32 = 1; }', 'only export numeric functions'],
    ['as { function hidden(): i32 { return 1; } }', 'export at least one'],
    ['as { import { value } from "other"; export function f(): i32 { return value; } }', 'cannot import'],
  ])("rejects unsupported exports and imports", async (source, message) => {
    await expectCompileError(source, message);
  });

});
