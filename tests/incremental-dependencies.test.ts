import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    const files = { "a.fun": 'import { b } from "./b.js"\nexport a = b', "b.fun": 'import { a } from "./a.js"\nexport b = a', "external.fun": 'import { String } from "effect"\nexport a = 1', "missing.fun": 'import { x } from "./absent.js"\nexport a = x', "escape.fun": 'export value = ts { 1 }' };
    const first = incrementalDependencyKeys(snapshot(cwd, files), cwd);
    expect(first.get(path.join(cwd, "a.fun"))).toBeDefined();
    expect(first.get(path.join(cwd, "b.fun"))).toBeDefined();
    for (const file of ["external.fun", "missing.fun", "escape.fun"]) expect(first.get(path.join(cwd, file))).toBeUndefined();
    writeFileSync(path.join(cwd, "a.ts"), "export const a = 1");
    const conflicted = incrementalDependencyKeys(snapshot(cwd, files), cwd);
    expect(conflicted.get(path.join(cwd, "b.fun"))).toBeUndefined();
    expect(conflicted.get(path.join(cwd, "a.fun"))).toBeUndefined();
  });

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
