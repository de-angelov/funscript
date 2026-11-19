import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { funscriptPlugin } from "../src/plugins/vite.js";
import { compileString } from "../src/compiler.js";
import { loadProjectConfig, isEffectOnlyFile } from "../src/compiler/project-config.js";
import { createTypeCheckCache, typeCheckSource } from "../src/compiler/check.js";

describe("FunScript project policy", () => {
  it("loads a static FunScript record and rejects dynamic or unknown options", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-config-"));
    expect(loadProjectConfig(dir)).toEqual({});
    const file = path.join(dir, "funscript.config.fun");
    writeFileSync(file, 'export config = { noTs: true, noGlobalThis: true, noOptional: true, barePipelines: true, effectOnly: ["src/domain"] }');
    expect(loadProjectConfig(dir)).toEqual({ noTs: true, noGlobalThis: true, noOptional: true, barePipelines: true, effectOnly: ["src/domain"] });
    expect(isEffectOnlyFile(loadProjectConfig(dir), dir, "src/domain/model.fun")).toBe(true);
    expect(isEffectOnlyFile(loadProjectConfig(dir), dir, "src/domain2/model.fun")).toBe(false);
    for (const input of ["export config = { noTs: unknown }", "export config = { typo: true }", 'export config = { effectOnly: ["../outside"] }', "export config = { noTs: true, noTs: false }", 'ts { console.log("bad") }']) {
      writeFileSync(file, input);
      expect(() => loadProjectConfig(dir)).toThrow("invalid FunScript config");
    }
  });

  it.each([
    'export x = globalThis.fetch',
    'export x = globalThis["fetch"]',
    'export x = window.globalThis',
    'export x = window["globalThis"]',
    'export x = () => globalThis',
    'export x = { globalThis }',
  ])("rejects references to globalThis: %s", async (source) => {
    await expect(Effect.runPromise(compileString(source, "test.fun", { noGlobalThis: true }))).rejects.toThrow("globalThis is disabled by project policy");
  });

  it("allows ordinary properties and strings named globalThis", async () => {
    const source = 'export x = { globalThis: "globalThis" }\nexport read = (value: { globalThis: String }) => value.globalThis';
    await expect(Effect.runPromise(compileString(source, "test.fun", { noGlobalThis: true }))).resolves.toBeDefined();
  });

  it.each([
    ['parameter', 'export f = (name?: String) => name'],
    ['record type field', 'export f = (user: { name?: String }) => user'],
    ['schema field', 'export schema User = { name?: String }'],
  ])("rejects optional values when noOptional is enabled: %s", async (_, source) => {
    await expect(Effect.runPromise(compileString(source, "test.fun", { noOptional: true }))).rejects.toThrow("Optional");
  });

  it("allows Option<T> and defaulted parameters when noOptional is enabled", async () => {
    const source = 'import { Option } from "effect"\nexport f = (opt: Option<String>, port: Number = 8080) => port';
    await expect(Effect.runPromise(compileString(source, "test.fun", { noOptional: true }))).resolves.toBeDefined();
  });

  it("allows optional values inside ts escape hatches when noOptional is enabled", async () => {
    const source = 'export f = ts { (x?: string) => x }';
    await expect(Effect.runPromise(compileString(source, "test.fun", { noOptional: true }))).resolves.toBeDefined();
  });

  it.each([
    ['String.trim', 'sec = { name: "test" }\nexport cleanName = sec.name |> String.trim'],
    ['String.replace', 'sec = { name: "test" }\nexport cleanName = sec.name |> String.replace("a", "b")'],
    ['Array.map', 'export res = [1, 2] |> Array.map((x) => x * 2)'],
    ['Option.getOrElse', 'import { Option } from "effect"\nexport res = Option.none() |> Option.getOrElse(() => 0)'],
  ])("rejects redundant companion prefix in pipeline when barePipelines is enabled: %s", async (_, source) => {
    await expect(Effect.runPromise(compileString(source, "test.fun", { barePipelines: true }))).rejects.toThrow("Redundant pipeline prefix");
  });

  it("allows bare pipeline stages and non-pipeline companion calls when barePipelines is enabled", async () => {
    const pipeline = 'sec = { name: "test" }\nexport cleanName = sec.name |> replace("a", "b") |> trim |> toLowerCase';
    await expect(Effect.runPromise(compileString(pipeline, "test.fun", { barePipelines: true }))).resolves.toBeDefined();

    const directCall = 'export trimmed = String.trim("hello")';
    await expect(Effect.runPromise(compileString(directCall, "test.fun", { barePipelines: true }))).resolves.toBeDefined();
  });

  it("loads folder policy from the Vite project root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "funscript-vite-policy-"));
    writeFileSync(path.join(root, "funscript.config.fun"), 'export config = { noGlobalThis: ["app/domain"] }');
    const plugin = funscriptPlugin();
    await (plugin.config as Function).call({}, { root, resolve: {} }, {});
    const transform = plugin.transform as Function;
    await expect(transform.call({}, "export x = globalThis", path.join(root, "app/domain/a.fun"))).rejects.toThrow("globalThis is disabled by project policy");
    await expect(transform.call({}, "export x = globalThis", path.join(root, "app/other.fun"))).resolves.toBeDefined();
  });

  it("does not reuse cached output from permissive checks", async () => {
    const source = 'export value = globalThis';
    const cache = createTypeCheckCache();
    await Effect.runPromise(typeCheckSource(source, "cache.fun", { cache }));
    const result = await Effect.runPromise(typeCheckSource(source, "cache.fun", { cache, noGlobalThis: true }));
    expect(result.success).toBe(false);
    expect(result.formattedOutput).toContain("globalThis is disabled by project policy");
  });

  it.each([
    ['import { readFile } from "node:fs"\nexport x = 1', "disallows import"],
    ['export x = fetch("https://example.com")', "disallows 'fetch'"],
    ['export x = globalThis', "disallows 'globalThis'"],
    ['export x = js fetch("https://example.com")', "disallows 'js' interop"],
    ['export js x = () => Effect.succeed(1)', "disallows 'js' interop"],
    ['ts { const x = 1; }', "TypeScript escapes are disabled"],
  ])("rejects non-Effect sources under the Effect-only policy", async (source, message) => {
    await expect(Effect.runPromise(compileString(source, "test.fun", { effectOnly: true }))).rejects.toThrow(message);
  });

  it("allows Effect imports and ordinary pure functions under the Effect-only policy", async () => {
    const source = 'import { Effect } from "effect"\nexport add = (a: Number, b: Number) => a + b\nexport value = Effect.succeed(1)';
    await expect(Effect.runPromise(compileString(source, "test.fun", { effectOnly: true }))).resolves.toBeDefined();
  });


  it("limits local dependencies to FunScript inside Effect-only folders", async () => {
    const root = process.cwd();
    const source = 'import { value } from "./helper.js"\nexport result = value';
    const file = path.join(root, "policy-fixture/src/domain/main.fun");
    const options = { effectOnly: true, effectOnlyDirectories: ["policy-fixture/src/domain"], policyRoot: root, virtualSources: new Map([[path.join(root, "policy-fixture/src/domain/helper.fun"), "export value = 1"]]) };
    await expect(Effect.runPromise(compileString(source, file, options))).resolves.toBeDefined();
    await expect(Effect.runPromise(compileString('import { value } from "../other.js"\nexport result = value', file, options))).rejects.toThrow("must remain within an Effect-only directory");
    const sidecar = { ...options, virtualSources: new Map([[path.join(root, "policy-fixture/src/domain/helper.ts"), "export const value = 1"]]) };
    await expect(Effect.runPromise(compileString(source, file, sidecar))).rejects.toThrow("resolves to a JavaScript or TypeScript file");
  });

});
