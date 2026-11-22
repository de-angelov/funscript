import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { incrementalDependencyKeys } from "../src/compiler/incremental-dependencies.js";
import { createTypeCheckCache, typeCheckVirtualFiles } from "../src/compiler/check.js";

const snapshot = (cwd: string, files: Record<string, string>) => new Map(Object.entries(files).map(([file, text]) => [path.resolve(cwd, file), text]));

describe("incremental dependency invalidation", () => {
  it("tracks transitive dependencies without invalidating unrelated files", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-deps-"));
    const files = { "a.fun": 'export a = 1', "b.fun": 'import { a } from "./a.js"\nexport b = a', "c.fun": 'export { b } from "./b.js"', "d.fun": 'export d = 2' };
    const first = incrementalDependencyKeys(snapshot(cwd, files), cwd);
    const next = incrementalDependencyKeys(snapshot(cwd, { ...files, "a.fun": 'export a = 3' }), cwd);
    for (const file of ["a.fun", "b.fun", "c.fun"]) expect(next.get(path.join(cwd, file))).not.toBe(first.get(path.join(cwd, file)));
    expect(next.get(path.join(cwd, "d.fun"))).toBe(first.get(path.join(cwd, "d.fun")));
  });

  it("handles cycles and conservatively avoids unknown, external or ambiguous dependencies", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-deps-"));
    const files = { "a.fun": 'import { b } from "./b.js"\nexport a = b', "b.fun": 'import { a } from "./a.js"\nexport b = a', "external.fun": 'import { String } from "missing-package"\nexport a = 1', "missing.fun": 'import { x } from "./absent.js"\nexport a = x', "escape.fun": 'export value = ts { 1 }' };
    const first = incrementalDependencyKeys(snapshot(cwd, files), cwd);
    expect(first.get(path.join(cwd, "a.fun"))).toBeDefined();
    expect(first.get(path.join(cwd, "b.fun"))).toBeDefined();
    for (const file of ["external.fun", "missing.fun", "escape.fun"]) expect(first.get(path.join(cwd, file))).toBeUndefined();
    writeFileSync(path.join(cwd, "a.ts"), "export const a = 1");
    const conflicted = incrementalDependencyKeys(snapshot(cwd, files), cwd);
    expect(conflicted.get(path.join(cwd, "b.fun"))).toBeUndefined();
    expect(conflicted.get(path.join(cwd, "a.fun"))).toBeUndefined();
  });

  it("invalidates when project resolution metadata changes and rejects extended configs", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-project-config-"));
    const files = snapshot(cwd, { "a.fun": "export value = 1" });
    const file = path.join(cwd, "a.fun");
    const first = incrementalDependencyKeys(files, cwd).get(file);
    writeFileSync(path.join(cwd, "package.json"), '{"type":"module"}');
    const changed = incrementalDependencyKeys(files, cwd).get(file);
    expect(changed).toBeDefined();
    expect(changed).not.toBe(first);
    writeFileSync(path.join(cwd, "tsconfig.json"), '{"extends":"./other.json"}');
    expect(incrementalDependencyKeys(files, cwd).get(file)).toBeUndefined();
  });

  it("tracks declared transitive package dependencies", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-package-transitive-"));
    const a = path.join(cwd, "node_modules", "dep-a");
    const b = path.join(cwd, "node_modules", "dep-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(path.join(a, "package.json"), JSON.stringify({ name: "dep-a", main: "index.js", types: "index.d.ts", dependencies: { "dep-b": "1" } }));
    writeFileSync(path.join(a, "index.js"), "module.exports = {};" );
    writeFileSync(path.join(a, "index.d.ts"), 'export { value } from "dep-b";');
    writeFileSync(path.join(b, "package.json"), JSON.stringify({ name: "dep-b", main: "index.js", types: "index.d.ts" }));
    writeFileSync(path.join(b, "index.js"), "exports.value = 1;" );
    writeFileSync(path.join(b, "index.d.ts"), "export const value: number;");
    const files = snapshot(cwd, { "a.fun": 'import { value } from "dep-a"\nexport a = value' });
    const before = incrementalDependencyKeys(files, cwd).get(path.join(cwd, "a.fun"));
    expect(before).toBeDefined();
    writeFileSync(path.join(b, "index.d.ts"), "export const value: string;");
    expect(incrementalDependencyKeys(files, cwd).get(path.join(cwd, "a.fun"))).not.toBe(before);
  });

  it("invalidates when a package declaration changes, including with the same size and mtime", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-package-"));
    const pkg = path.join(cwd, "node_modules", "example-dep");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "example-dep", version: "1.0.0", main: "index.js", types: "index.d.ts" }));
    writeFileSync(path.join(pkg, "index.js"), "exports.accept = value => value;");
    const declaration = path.join(pkg, "index.d.ts");
    writeFileSync(declaration, "export function accept(value: number): number;");
    const files = { "a.fun": 'import { accept } from "example-dep"\nexport value = accept(1)' };
    const cache = createTypeCheckCache();
    const first = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }));
    expect(first.success, first.formattedOutput).toBe(true);
    const before = cache.compiledFiles.get(path.join(cwd, "a.fun"));
    expect(before).toBeDefined();
    const unchanged = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }));
    expect(unchanged.success, unchanged.formattedOutput).toBe(true);
    expect(cache.compiledFiles.get(path.join(cwd, "a.fun"))).toBe(before);
    const mtime = statSync(declaration).mtime;
    writeFileSync(declaration, "export function accept(value: string): string;");
    utimesSync(declaration, mtime, mtime);
    const incremental = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }));
    const clean = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd }));
    expect(incremental.success).toBe(false);
    expect(incremental.diagnostics.map(({ code, message }) => ({ code, message }))).toEqual(clean.diagnostics.map(({ code, message }) => ({ code, message })));
    expect(cache.compiledFiles.get(path.join(cwd, "a.fun"))).not.toBe(before);
  }, 60000);

  it("refreshes TypeScript module resolution when a package manifest changes", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-package-exports-"));
    const pkg = path.join(cwd, "node_modules", "example-dep");
    mkdirSync(pkg, { recursive: true });
    const manifest = path.join(pkg, "package.json");
    const info = { name: "example-dep", version: "1.0.0", main: "index.js", types: "index.d.ts" };
    writeFileSync(manifest, JSON.stringify(info));
    writeFileSync(path.join(pkg, "index.js"), "exports.accept = value => value;");
    writeFileSync(path.join(pkg, "index.d.ts"), "export function accept(value: number): number;");
    writeFileSync(path.join(pkg, "alternate.d.ts"), "export function accept(value: string): string;");
    const files = { "a.fun": 'import { accept } from "example-dep"\nexport value = accept(1)' };
    const cache = createTypeCheckCache();
    expect((await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }))).success).toBe(true);
    writeFileSync(manifest, JSON.stringify({ ...info, types: "alternate.d.ts" }));
    const incremental = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }));
    const clean = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd }));
    expect(clean.success).toBe(false);
    expect(incremental.diagnostics.map(({ code, message }) => ({ code, message }))).toEqual(clean.diagnostics.map(({ code, message }) => ({ code, message })));
  }, 60000);

  it("reuses independent compiled files and recompiles changed importers", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-deps-"));
    const cache = createTypeCheckCache();
    const files = { "a.fun": 'export a = 1', "b.fun": 'import { a } from "./a.js"\nexport b = a', "d.fun": 'export d = 2' };
    await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }));
    const beforeB = cache.compiledFiles.get(path.join(cwd, "b.fun"));
    const beforeD = cache.compiledFiles.get(path.join(cwd, "d.fun"));
    expect(beforeB).toBeDefined();
    expect(beforeD).toBeDefined();
    await Effect.runPromise(typeCheckVirtualFiles({ ...files, "a.fun": 'export a = 3' }, { cwd, cache }));
    expect(cache.compiledFiles.get(path.join(cwd, "b.fun"))).not.toBe(beforeB);
    expect(cache.compiledFiles.get(path.join(cwd, "d.fun"))).toBe(beforeD);
  }, 60000);
  it("reuses matching policy checks without reusing a permissive result under a strict policy", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-policy-cache-"));
    const cache = createTypeCheckCache();
    const files = { "a.fun": "export value = 1" };
    await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache }));
    const permissive = cache.compiledFiles.get(path.join(cwd, "a.fun"));
    await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache, noTs: true }));
    const strict = cache.compiledFiles.get(path.join(cwd, "a.fun"));
    expect(strict).toBeDefined();
    expect(strict).not.toBe(permissive);
    await Effect.runPromise(typeCheckVirtualFiles(files, { cwd, cache, noTs: true }));
    expect(cache.compiledFiles.get(path.join(cwd, "a.fun"))).toBe(strict);
  }, 60000);

  it("matches a clean check when an imported function changes type", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-deps-types-"));
    const cache = createTypeCheckCache();
    const files = { "a.fun": 'export accept = (value: Number) => value', "b.fun": 'import { accept } from "./a.js"\nexport value = accept(1)' };
    const options = { cwd, cache };
    expect((await Effect.runPromise(typeCheckVirtualFiles(files, options))).success).toBe(true);
    const changed = { ...files, "a.fun": 'export accept = (value: String) => value' };
    const incremental = await Effect.runPromise(typeCheckVirtualFiles(changed, options));
    const clean = await Effect.runPromise(typeCheckVirtualFiles(changed, { cwd }));
    expect(incremental.success).toBe(false);
    expect(incremental.diagnostics.map(({ file, code, message }) => ({ file, code, message }))).toEqual(clean.diagnostics.map(({ file, code, message }) => ({ file, code, message })));
  }, 60000);

});
