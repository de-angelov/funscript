import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Effect, Exit, Stream } from "effect";
import { format } from "../src/formatter/index.js";
import { Lexer } from "../src/lexer/lexer.js";
import { compileString } from "../src/compiler.js";
import { findHoverAsync } from "../src/lsp/hover.js";
import { FunScriptLspServer, validateFunScript } from "../src/lsp/server.js";
import { compile, execute, expectCompileError, expectNoDiagnostics, typeCheck } from "./helpers/index.js";

describe("AssemblyScript blocks", () => {
  it("tokenizes source only once when preparing AssemblyScript", async () => {
    const tokenize = vi.spyOn(Lexer.prototype, "tokenize");
    try {
      const source = "as { export function value(): i32 { return 42; } }\nexport result = value()";
      const result = await Effect.runPromise(compileString(source, "single-pass.fun", { sourcemap: false }));
      expect(result.typescript).toContain("export const result");
      expect(tokenize).toHaveBeenCalledTimes(1);
    } finally {
      tokenize.mockRestore();
    }
  });

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

  it("rejects unsupported types at the boundary", async () => {
    await expectCompileError('as { export function text(a: symbol): i32 { return 0; } }', 'explicit i32, u32, f32, or f64');
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

  it("supports Float32Array parameters and scalar return", async () => {
    const source = `as {
  export function dotProduct(a: Float32Array, b: Float32Array): f32 {
    let sum: f32 = 0.0;
    for (let i = 0; i < a.length; ++i) {
      sum += a[i] * b[i];
    }
    return sum;
  }
}
export computeDot = (x: Float32Array, y: Float32Array) => dotProduct(x, y)`;
    const output = await execute(source);
    const a = new Float32Array([1.0, 2.0, 3.0]);
    const b = new Float32Array([4.0, 5.0, 6.0]);
    expect(output.computeDot(a, b)).toBeCloseTo(32.0, 5);
  });

  it("supports returning newly allocated TypedArrays from kernels", async () => {
    const source = `as {
  export function scale(v: Float32Array, factor: f32): Float32Array {
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; ++i) {
      out[i] = v[i] * factor;
    }
    return out;
  }
}
export scaleVector = (v: Float32Array, f: Number) => scale(v, f)`;
    const output = await execute(source);
    const input = new Float32Array([1.5, 2.5, -3.0]);
    const result = output.scaleVector(input, 2.0);
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result)).toEqual([3.0, 5.0, -6.0]);
  });

  it("supports in-place mutation of buffers with void return", async () => {
    const source = `as {
  export function invertBytes(buf: Uint8Array): void {
    for (let i = 0; i < buf.length; ++i) {
      buf[i] = u8(255 - buf[i]);
    }
  }
}
export mutateInPlace = (buf: Uint8Array) => invertBytes(buf)`;
    const output = await execute(source);
    const buffer = new Uint8Array([0, 100, 255]);
    output.mutateInPlace(buffer);
    expect(Array.from(buffer)).toEqual([255, 155, 0]);
  });

  it("resets Wasm linear memory after each call preventing memory leaks", async () => {
    const source = `as {
  export function makeBuffer(size: u32): Uint8Array {
    const out = new Uint8Array(size);
    for (let i: u32 = 0; i < size; ++i) {
      out[i] = u8(i & 0xff);
    }
    return out;
  }
}
export generate = (size: Number) => makeBuffer(size)`;
    const output = await execute(source);
    for (let i = 0; i < 500; i++) {
      const buf = output.generate(64);
      expect(buf).toBeInstanceOf(Uint8Array);
      expect(buf.length).toBe(64);
    }
  });

  it("validates TypedArray types in .effect companion and reports WasmInputError", async () => {
    const source = `as {
  export function sumBytes(buf: Uint8Array): u32 {
    let total: u32 = 0;
    for (let i = 0; i < buf.length; ++i) {
      total += buf[i];
    }
    return total;
  }
}
export sumEffect = (buf: Uint8Array) => sumBytes.effect(buf)`;
    const output = await execute(source);
    const valid = new Uint8Array([10, 20, 30]);
    const result = await Effect.runPromise(output.sumEffect(valid));
    expect(result).toBe(60);

    const err = await Effect.runPromise(Effect.flip(output.sumEffect([10, 20, 30] as any)));
    expect(err).toMatchObject({
      _tag: "WasmInputError",
      function: "sumBytes",
      parameter: "buf",
      expected: "Uint8Array",
      value: [10, 20, 30],
    });
  });

  it("supports mixed parameters with TypedArrays and scalar values", async () => {
    const source = `as {
  export function fill(buf: Uint8Array, value: u32, count: u32): void {
    const n = count < u32(buf.length) ? count : u32(buf.length);
    for (let i: u32 = 0; i < n; ++i) {
      buf[i] = u8(value);
    }
  }
}
export fillBuffer = (buf: Uint8Array, value: Number, count: Number) => fill(buf, value, count)
export fillEffect = (buf: Uint8Array, value: Number, count: Number) => fill.effect(buf, value, count)`;
    const output = await execute(source);
    const buf = new Uint8Array(5);
    output.fillBuffer(buf, 42, 3);
    expect(Array.from(buf)).toEqual([42, 42, 42, 0, 0]);

    const buf2 = new Uint8Array(5);
    await Effect.runPromise(output.fillEffect(buf2, 7, 2));
    expect(Array.from(buf2)).toEqual([7, 7, 0, 0, 0]);
  });

  it("integrates seamlessly into Effect Stream processing", async () => {
    const source = `import { Stream } from "effect"

as {
  export function checksum(chunk: Uint8Array): u32 {
    let sum: u32 = 0;
    for (let i = 0; i < chunk.length; ++i) {
      sum = (sum + chunk[i]) & 0xffff;
    }
    return sum;
  }
}

export processStream = (chunks: Array<Uint8Array>) =>
  Stream.fromIterable(chunks)
  |> Stream.mapEffect((chunk) => checksum.effect(chunk))
  |> Stream.runFold(() => 0, (acc, n) => acc + n)`;
    const output = await execute(source, { scope: { Stream } });
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];
    const total = await Effect.runPromise(output.processStream(chunks));
    expect(total).toBe(45);
  });

  it("supports 64-bit integer scalars (i64 / u64) mapped to BigInt", async () => {
    const source = `as {
  export function add64(a: i64, b: i64): i64 {
    return a + b;
  }
  export function addU64(a: u64, b: u64): u64 {
    return a + b;
  }
}
export runAdd64 = (a: BigInt, b: BigInt) => add64(a, b)
export runAdd64Effect = (a: BigInt, b: BigInt) => add64.effect(a, b)
export runAddU64 = (a: BigInt, b: BigInt) => addU64(a, b)`;

    const output = await execute(source);
    expect(output.runAdd64(1000000000000n, 2000000000000n)).toBe(3000000000000n);
    const effResult = await Effect.runPromise(output.runAdd64Effect(5000000000000n, 4000000000000n));
    expect(effResult).toBe(9000000000000n);

    // u64 wrapping above 2^63 - 1
    const large = 18446744073709551610n; // 2^64 - 6
    expect(output.runAddU64(large, 5n)).toBe(18446744073709551615n);

    // Effect validation: rejects non-bigint or out of range values
    const errResult = await Effect.runPromise(Effect.flip(output.runAdd64Effect(42 as any, 10n)));
    expect(errResult).toMatchObject({
      _tag: "WasmInputError",
      function: "add64",
      parameter: "a",
      expected: "i64",
      value: 42,
    });
  });

  it("supports BigInt64Array and BigUint64Array marshaling and mutation", async () => {
    const source = `as {
  export function sumBigInts(arr: BigInt64Array): i64 {
    let sum: i64 = 0;
    for (let i = 0; i < arr.length; ++i) {
      sum += arr[i];
    }
    return sum;
  }
  export function doubleBigInts(arr: BigInt64Array): void {
    for (let i = 0; i < arr.length; ++i) {
      arr[i] = arr[i] * 2;
    }
  }
  export function makeRange(count: i32): BigInt64Array {
    const res = new BigInt64Array(count);
    for (let i: i32 = 0; i < count; ++i) {
      res[i] = i64(i * 10);
    }
    return res;
  }
}
export sum = (arr: BigInt64Array) => sumBigInts(arr)
export sumEffect = (arr: BigInt64Array) => sumBigInts.effect(arr)
export double = (arr: BigInt64Array) => doubleBigInts(arr)
export range = (count: Number) => makeRange(count)`;

    const output = await execute(source);
    const data = new BigInt64Array([10n, 20n, 30n, 40n]);
    expect(output.sum(data)).toBe(100n);

    const effSum = await Effect.runPromise(output.sumEffect(data));
    expect(effSum).toBe(100n);

    output.double(data);
    expect(Array.from(data)).toEqual([20n, 40n, 60n, 80n]);

    const generated = output.range(4);
    expect(generated instanceof BigInt64Array).toBe(true);
    expect(Array.from(generated)).toEqual([0n, 10n, 20n, 30n]);
  });

  it("supports string parameters and string returns", async () => {
    const source = `as {
  export function greet(name: string): string {
    return "Hello, " + name + "!";
  }
  export function countChars(s: string): i32 {
    return s.length;
  }
}
export resGreet = greet("FunScript")
export resLen = countChars("AssemblyScript")
export safeGreet = greet.effect("Effect")
export greetFn = greet
`;
    const output = await execute(source);
    expect(output.resGreet).toBe("Hello, FunScript!");
    expect(output.resLen).toBe(14);
    const effRes = await Effect.runPromise(output.safeGreet);
    expect(effRes).toBe("Hello, Effect!");

    const badCall = output.greetFn.effect(123 as any);
    const exit = await Effect.runPromiseExit(badCall);
    expect(exit._tag).toBe("Failure");
  });

  it("supports struct classes as parameters and returns", async () => {
    const source = `as {
  export class Point {
    x: f64 = 0;
    y: f64 = 0;
  }
  export function makePoint(x: f64, y: f64): Point {
    const p = new Point();
    p.x = x;
    p.y = y;
    return p;
  }
  export function addPoints(p1: Point, p2: Point): Point {
    const p = new Point();
    p.x = p1.x + p2.x;
    p.y = p1.y + p2.y;
    return p;
  }
}
export p1 = makePoint(1.5, 2.5)
export p2 = makePoint(3.5, 4.5)
export p3 = addPoints(p1, p2)
export safeAdd = addPoints.effect(p1, p2)
`;
    const output = await execute(source);
    expect(output.p1).toEqual({ x: 1.5, y: 2.5 });
    expect(output.p2).toEqual({ x: 3.5, y: 4.5 });
    expect(output.p3).toEqual({ x: 5.0, y: 7.0 });

    const effRes = await Effect.runPromise(output.safeAdd);
    expect(effRes).toEqual({ x: 5.0, y: 7.0 });
  });

  it("supports structs containing strings", async () => {
    const source = `as {
  export class User {
    name: string = "";
    age: i32 = 0;
  }
  export function celebrate(u: User): User {
    const next = new User();
    next.name = u.name;
    next.age = u.age + 1;
    return next;
  }
}
export user = { name: "Ada", age: 36 }
export nextUser = celebrate(user)
`;
    const output = await execute(source);
    expect(output.nextUser).toEqual({ name: "Ada", age: 37 });
  });

  it("supports boolean parameters and returns", async () => {
    const source = `as {
  export function negate(flag: bool): bool {
    return !flag;
  }
  export function both(a: boolean, b: boolean): boolean {
    return a && b;
  }
}
export negateFn = negate
export notTrue = negate(true)
export notFalse = negate(false)
export bothTrue = both(true, true)
export bothMixed = both(true, false)
export safeNegate = negate.effect(true)
`;
    const output = await execute(source);
    expect(output.notTrue).toBe(false);
    expect(output.notFalse).toBe(true);
    expect(output.bothTrue).toBe(true);
    expect(output.bothMixed).toBe(false);

    const effRes = await Effect.runPromise(output.safeNegate);
    expect(effRes).toBe(false);

    const badCall = (output.negateFn as any).effect(123);
    const exit = await Effect.runPromiseExit(badCall);
    expect(exit._tag).toBe("Failure");
  });

  it("supports nested struct classes", async () => {
    const source = `as {
  export class Point {
    x: f64 = 0;
    y: f64 = 0;
  }
  export class Circle {
    center: Point = new Point();
    radius: f64 = 0;
    filled: bool = false;
  }
  export function scaleCircle(c: Circle, factor: f64): Circle {
    const next = new Circle();
    next.center = new Point();
    next.center.x = c.center.x * factor;
    next.center.y = c.center.y * factor;
    next.radius = c.radius * factor;
    next.filled = c.filled;
    return next;
  }
}
export origin = { x: 2.0, y: 3.0 }
export c1 = { center: origin, radius: 5.0, filled: true }
export scaled = scaleCircle(c1, 2.0)
export safeScaled = scaleCircle.effect(c1, 2.0)
`;
    const output = await execute(source);
    expect(output.scaled).toEqual({
      center: { x: 4.0, y: 6.0 },
      radius: 10.0,
      filled: true,
    });

    const effRes = await Effect.runPromise(output.safeScaled);
    expect(effRes).toEqual({
      center: { x: 4.0, y: 6.0 },
      radius: 10.0,
      filled: true,
    });
  });

  it("supports arrays of structs and arrays of strings", async () => {
    const source = `as {
  export class Item {
    id: i32;
    score: f64;
  }
  export function totalScore(items: Item[]): f64 {
    let sum = 0.0;
    for (let i = 0; i < items.length; i++) {
      sum += items[i].score;
    }
    return sum;
  }
  export function filterHighScore(items: Item[], threshold: f64): Item[] {
    const res = new Array<Item>();
    for (let i = 0; i < items.length; i++) {
      if (items[i].score >= threshold) res.push(items[i]);
    }
    return res;
  }
  export function joinWords(words: string[]): string {
    return words.join(" | ");
  }
  export function duplicateWords(words: string[]): string[] {
    const res = new Array<string>();
    for (let i = 0; i < words.length; i++) {
      res.push(words[i]);
      res.push(words[i]);
    }
    return res;
  }
}
export items = [{ id: 1, score: 10.5 }, { id: 2, score: 20.25 }, { id: 3, score: 5.0 }]
export total = totalScore(items)
export filtered = filterHighScore(items, 10.0)
export joined = joinWords(["alpha", "beta", "gamma"])
export duped = duplicateWords(["hello", "wasm"])
`;
    const output = await execute(source);
    expect(output.total).toBe(35.75);
    expect(output.filtered).toEqual([
      { id: 1, score: 10.5 },
      { id: 2, score: 20.25 },
    ]);
    expect(output.joined).toBe("alpha | beta | gamma");
    expect(output.duped).toEqual(["hello", "hello", "wasm", "wasm"]);
  });

  it("supports struct classes containing arrays", async () => {
    const source = `as {
  export class Point {
    x: f64;
    y: f64;
  }
  export class Polygon {
    name: string;
    points: Point[];
  }
  export function centroid(poly: Polygon): Point {
    let sumX = 0.0;
    let sumY = 0.0;
    const len = poly.points.length;
    for (let i = 0; i < len; i++) {
      sumX += poly.points[i].x;
      sumY += poly.points[i].y;
    }
    const c = new Point();
    c.x = sumX / f64(len);
    c.y = sumY / f64(len);
    return c;
  }
}
export poly = {
  name: "triangle",
  points: [{ x: 0.0, y: 0.0 }, { x: 3.0, y: 0.0 }, { x: 0.0, y: 6.0 }]
}
export center = centroid(poly)
`;
    const output = await execute(source);
    expect(output.center).toEqual({ x: 1.0, y: 2.0 });
  });

  it("supports SIMD vector math using v128 and f64x2 intrinsics", async () => {
    const source = `as {
  export function vecAdd(dest: Float64Array, a: Float64Array, b: Float64Array): void {
    const v1 = v128.load(changetype<usize>(a.dataStart));
    const v2 = v128.load(changetype<usize>(b.dataStart));
    v128.store(changetype<usize>(dest.dataStart), f64x2.add(v1, v2));
  }
}
export addVectors = (dest: Float64Array, a: Float64Array, b: Float64Array) => vecAdd(dest, a, b)
export vecAddFn = vecAdd
`;
    const output = await execute(source);
    const dest = new Float64Array(2);
    const a = new Float64Array([1.5, 2.5]);
    const b = new Float64Array([10.0, 20.0]);
    output.addVectors(dest, a, b);
    expect(Array.from(dest)).toEqual([11.5, 22.5]);

    const dest2 = new Float64Array(2);
    await Effect.runPromise(
      output.vecAddFn.effect(dest2, new Float64Array([3.0, 4.0]), new Float64Array([7.0, 6.0]))
    );
    expect(Array.from(dest2)).toEqual([10.0, 10.0]);
  });

  it("supports returning tuples [f64, f64] and [i32, string]", async () => {
    const source = `as {
  export function minMax(arr: Float64Array): [f64, f64] {
    let min = arr[0];
    let max = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
    return [min, max];
  }
  export function status(code: i32): [i32, string] {
    return [code, code == 200 ? "OK" : "ERR"];
  }
}
export computeStats = (numbers: Float64Array) => minMax(numbers)
export getStatus = (code: Number) => status(code)
export minMaxFn = minMax
export statusFn = status
`;
    const output = await execute(source);
    const numbers = new Float64Array([42.0, 3.5, 100.25, -5.0]);
    expect(output.computeStats(numbers)).toEqual([-5.0, 100.25]);
    expect(output.getStatus(200)).toEqual([200, "OK"]);
    expect(output.getStatus(404)).toEqual([404, "ERR"]);

    const effStats = await Effect.runPromise(output.minMaxFn.effect(new Float64Array([1.0, 10.0])));
    expect(effStats).toEqual([1.0, 10.0]);

    const effStatus = await Effect.runPromise(output.statusFn.effect(200));
    expect(effStatus).toEqual([200, "OK"]);
  });

  it("supports tuple parameters and validates tuple inputs in .effect companion", async () => {
    const source = `as {
  export function distance(p1: [f64, f64], p2: [f64, f64]): f64 {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    return Math.sqrt(dx * dx + dy * dy);
  }
}
export d = distance([0.0, 0.0], [3.0, 4.0])
export distFn = distance
`;
    const output = await execute(source);
    expect(output.d).toBe(5.0);

    const effD = await Effect.runPromise(output.distFn.effect([1.0, 2.0], [4.0, 6.0]));
    expect(effD).toBe(5.0);

    const invalidExit = await Effect.runPromiseExit(output.distFn.effect([1.0] as any, [4.0, 6.0]));
    expect(Exit.isFailure(invalidExit)).toBe(true);
  });

  it("supports classes containing tuple fields", async () => {
    const source = `as {
  export class Segment {
    start: [f64, f64];
    end: [f64, f64];
  }
  export function midpoint(seg: Segment): [f64, f64] {
    const mx = (seg.start[0] + seg.end[0]) / 2.0;
    const my = (seg.start[1] + seg.end[1]) / 2.0;
    return [mx, my];
  }
}
export seg = {
  start: [0.0, 10.0],
  end: [10.0, 20.0]
}
export mid = midpoint(seg)
`;
    const output = await execute(source);
    expect(output.mid).toEqual([5.0, 15.0]);
  });

  it("supports zero-copy kernel chaining with .raw and direct WasmHandle passing", async () => {
    const source = `as {
  export function doubleVec(data: Float64Array): Float64Array {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] * 2.0;
    return out;
  }
  export function addOne(data: Float64Array): Float64Array {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] + 1.0;
    return out;
  }
  export function sumVec(data: Float64Array): f64 {
    let sum: f64 = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum;
  }
}
export doubleFn = doubleVec
export addOneFn = addOne
export sumFn = sumVec
`;
    const output = await execute(source);
    const initial = new Float64Array([1.0, 2.0, 3.0]);

    // Chain step 1 -> step 2 -> step 3 entirely in Wasm linear memory
    const h1 = output.doubleFn.raw(initial);
    expect(h1._tag).toBe("WasmHandle");
    expect(Array.from(h1.read())).toEqual([2.0, 4.0, 6.0]);

    const h2 = output.addOneFn.raw(h1);
    expect(h2._tag).toBe("WasmHandle");
    expect(Array.from(h2.read())).toEqual([3.0, 5.0, 7.0]);

    // Final sum consumes handle h2 and resets Wasm heap
    const total = output.sumFn(h2);
    expect(total).toBe(15.0);
  });

  it("integrates zero-copy Wasm handles with Effect Scope via .scoped", async () => {
    const source = `as {
  export function scale(data: Float64Array, factor: f64): Float64Array {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] * factor;
    return out;
  }
  export function sum(data: Float64Array): f64 {
    let s: f64 = 0;
    for (let i = 0; i < data.length; i++) s += data[i];
    return s;
  }
}
export scaleFn = scale
export sumFn = sum
`;
    const output = await execute(source);
    const initial = new Float64Array([10.0, 20.0, 30.0]);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const h1 = yield* output.scaleFn.scoped(initial, 3.0);
        expect(h1._tag).toBe("WasmHandle");
        const total = output.sumFn(h1);
        return total;
      })
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe(180.0);
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
    ['as { export function invalid(a: symbol): symbol { return a; } }', 'explicit i32'],
    ['as { export const value: i32 = 1; }', 'only export numeric functions'],
    ['as { function hidden(): i32 { return 1; } }', 'export at least one'],
    ['as { import { value } from "other"; export function f(): i32 { return value; } }', 'cannot import'],
  ])("rejects unsupported exports and imports", async (source, message) => {
    await expectCompileError(source, message);
  });

});
