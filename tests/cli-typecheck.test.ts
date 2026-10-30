import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { evaluateReplLine, setupReplContext } from "../src/cli/repl.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli/index.js");
let directory: string;
let invalid: string;
let valid: string;

beforeAll(async () => {
  // Keep fixtures under the project so emitted imports resolve installed packages.
  directory = await fs.mkdtemp(path.resolve(".cli-typecheck-"));
  invalid = path.join(directory, "invalid.fun");
  valid = path.join(directory, "valid.fun");
  await fs.writeFile(invalid, 'greet = (name: String) => { => name }\nresult = greet(42)\nmain = () => console.log("EXECUTED")\n');
  await fs.writeFile(valid, 'main = () => console.log("VALID EXECUTION")\n');
});
afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  await Promise.all(["invalid", "valid"].map((name) => fs.rm(path.resolve(`.funscript-cache/${name}.mjs`), { force: true })));
});

describe("CLI static type-checking gates", () => {
  it("rejects invalid run input with a TS2345 code frame before execution", async () => {
    const error = await exec(process.execPath, [cli, "run", invalid]).catch((error) => error);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("TS2345");
    expect(error.stderr).toContain("result = greet(42)");
    expect(error.stderr).toContain("^^");
    expect(error.stdout).not.toContain("EXECUTED");
  }, 20_000);

  it.each([["--no-check", "FILE"], ["FILE", "--no-check"]])("allows explicit run bypass with %j", async (...args) => {
    const result = await exec(process.execPath, [cli, "run", ...args.map((arg) => arg === "FILE" ? invalid : arg)]);
    expect(result.stdout).toContain("EXECUTED");
  });

  it("executes valid code after checking", async () => {
    const result = await exec(process.execPath, [cli, "run", valid]);
    expect(result.stdout).toContain("VALID EXECUTION");
  }, 20_000);

  it("checks every build input before writing output, and supports bypass", async () => {
    const output = path.join(directory, "output");
    const error = await exec(process.execPath, [cli, "build", valid, invalid, "--outDir", output, "--sourcemap"]).catch((error) => error);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("TS2345");
    await expect(fs.stat(output)).rejects.toThrow();
    await exec(process.execPath, [cli, "build", invalid, "--outDir", output, "--no-check"]);
    expect(await fs.readFile(path.join(output, "invalid.ts"), "utf8")).toContain("greet(42)");
  }, 20_000);

  it("checks local dependencies before running an entrypoint", async () => {
    const dependency = path.join(directory, "dependency.fun");
    const entry = path.join(directory, "entry.fun");
    await fs.writeFile(dependency, 'export count: Number = "wrong"\n');
    await fs.writeFile(entry, 'import { count } from "./dependency.js"\nmain = () => console.log(count)\n');
    const error = await exec(process.execPath, [cli, "run", entry]).catch((error) => error);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("dependency.fun");
    expect(error.stderr).toContain("TS2322");
    expect(error.stdout).toBe("");
  }, 20_000);
});

describe("REPL static checking", () => {
  it("retains function types, rejects invalid input, and accepts subsequent valid input", async () => {
    const context = vm.createContext({});
    setupReplContext(context);
    await evaluateReplLine('greet = (name: String) => { => name }', context);
    await expect(evaluateReplLine("greet(42)", context)).rejects.toThrow("TS2345");
    expect(await evaluateReplLine('greet("Ada")', context)).toBe("Ada");
    await expect(evaluateReplLine('count: Number = "wrong"', context)).rejects.toThrow("TS2322");
    await evaluateReplLine("count = 10", context);
    await evaluateReplLine("count = 20", context);
    expect(await evaluateReplLine("count", context)).toBe(20);
    expect(await evaluateReplLine("Effect.succeed(42)", context)).toBe(42);
  }, 30_000);
});
