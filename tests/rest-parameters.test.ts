import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { compile, execute } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { typeCheckSource } from "../src/compiler/check.js";

describe("Rest parameters and spread elements", () => {
  it("compiles and executes a function with rest parameters", async () => {
    const code = `
export fn sum(...numbers: Array<Int>): Int => numbers |> Array.reduce(0, (acc, n) => acc + n)

export fn joinAll(prefix: String, ...items: Array<String>): String =>
  => prefix + ": " + Array.join(items, ", ")

export result = sum(1, 2, 3, 4)
export joined = joinAll("Items", "apple", "banana", "cherry")
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain("const sum = (...numbers: ReadonlyArray<Int>): Int =>");
    expect(res.typescript).toContain("const joinAll = (prefix: string, ...items: ReadonlyArray<string>): string =>");

    const exports = await execute(code);
    expect(exports.result).toBe(10);
    expect(exports.joined).toBe("Items: apple, banana, cherry");
  });

  it("compiles arrow functions with rest parameters", async () => {
    const code = `
export sum = (...numbers: Array<Int>): Int => 42
export add = (first: Int, ...rest: Array<Int>): Int => first
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain("export const sum = (...numbers: ReadonlyArray<Int>): Int => 42;");
    expect(res.typescript).toContain("export const add = (first: Int, ...rest: ReadonlyArray<Int>): Int => first;");
  });

  it("compiles and executes call argument spread and array spread", async () => {
    const code = `
export fn sum(...numbers: Array<Int>): Int => numbers |> Array.reduce(0, (acc, n) => acc + n)

list = [2, 3, 4]
fullList = [1, ...list, 5]
export res = sum(...fullList)
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain("const fullList = [1, ...list, 5];");
    expect(res.typescript).toContain("export const res = sum(...fullList);");

    const exports = await execute(code);
    expect(exports.res).toBe(15);
  });

  it("compiles function signatures with rest parameters", async () => {
    const code = `
schema Logger = (...messages: Array<String>) => Unit
export fn logAll(logger: Logger, ...msgs: Array<String>): Unit =>
  => logger(...msgs)
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain("type Logger = (...messages: ReadonlyArray<string>) => void;");
    expect(res.typescript).toContain("const logAll = (logger: Logger, ...msgs: ReadonlyArray<string>): void =>");
  });

  it("rejects rest parameters that are not the final parameter", async () => {
    const code = `
fn invalid(...rest: Array<Int>, last: Int) => 0
`.trim();

    await expect(compile(code)).rejects.toThrow("A rest parameter must be the last parameter in a parameter list");
  });

  it("rejects optional rest parameters", async () => {
    const code = `
fn invalid(...rest?: Array<Int>) => 0
`.trim();

    await expect(compile(code)).rejects.toThrow("A rest parameter cannot be optional");
  });

  it("rejects rest parameters with default values", async () => {
    const code = `
fn invalid(...rest: Array<Int> = []) => 0
`.trim();

    await expect(compile(code)).rejects.toThrow("A rest parameter cannot have a default value");
  });

  it("formats rest parameters and spread expressions idempotently", () => {
    const code = `
export cn = (...inputs: Array<String>): String =>
  => twMerge(cx(...inputs))

export arr = [1, ...items, 3]

export log = (prefix: String, ...rest: Array<String>): Unit =>
  => Console.log(prefix, ...rest)
`.trim();

    const formatted = format(code);
    expect(formatted).toContain("export cn = (...inputs: Array<String>): String =>");
    expect(formatted).toContain("export arr = [1, ...items, 3]");
    expect(formatted).toContain("export log = (prefix: String, ...rest: Array<String>): Unit =>");
    expect(format(formatted)).toBe(formatted);
  });

  it("statically type checks rest parameters and reports type errors", async () => {
    const validCode = `
export fn sum(...numbers: Array<Number>): Number => numbers |> Array.reduce(0, (acc, n) => acc + n)
export val: Number = sum(1, 2, 3)
`.trim();

    const validResult = await Effect.runPromise(typeCheckSource(validCode, "valid.fun"));
    expect(validResult.success).toBe(true);
    expect(validResult.diagnostics).toHaveLength(0);

    const invalidCode = `
export fn sum(...numbers: Array<Number>): Number => numbers |> Array.reduce(0, (acc, n) => acc + n)
export val: Number = sum(1, "not-a-number", 3)
`.trim();

    const invalidResult = await Effect.runPromise(typeCheckSource(invalidCode, "invalid.fun"));
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.diagnostics.length).toBeGreaterThan(0);
    expect(invalidResult.diagnostics.some(d => d.message.includes("is not assignable to parameter of type 'number'"))).toBe(true);
  });
});
