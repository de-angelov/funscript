import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IncrementalBuildSession } from "../src/compiler/incremental-build.js";

describe("incremental build session", () => {
  it("reuses unaffected outputs and matches a clean build after dependency edits", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-build-"));
    const session = new IncrementalBuildSession(cwd);
    const files = { "a.fun": "export value = 1", "b.fun": 'import { value } from "./a.js"\nexport result = value', "c.fun": "export other = 2" };
    const cold = await Effect.runPromise(session.build(files));
    expect(cold.check.success, cold.check.formattedOutput).toBe(true);
    expect([cold.compiled, cold.reused]).toEqual([3, 0]);
    const warm = await Effect.runPromise(session.build(files));
    expect(warm.outputs).toEqual(cold.outputs);
    expect([warm.compiled, warm.reused]).toEqual([0, 3]);
    const updated = { ...files, "a.fun": "export value = 3" };
    const incremental = await Effect.runPromise(session.build(updated));
    const clean = await Effect.runPromise(new IncrementalBuildSession(cwd).build(updated));
    expect(incremental.check.success, incremental.check.formattedOutput).toBe(true);
    expect(incremental.outputs).toEqual(clean.outputs);
    expect([incremental.compiled, incremental.reused]).toEqual([2, 1]);
    const removed = await Effect.runPromise(session.build({ "a.fun": updated["a.fun"], "b.fun": updated["b.fun"] }));
    expect(Object.keys(removed.outputs).sort()).toEqual(["a.fun", "b.fun"]);
    expect([removed.compiled, removed.reused]).toEqual([0, 2]);
    session.clear();
    expect((await Effect.runPromise(session.build(updated))).reused).toBe(0);
  }, 60000);

  it("recompiles package-dependent sources when no dependency fingerprint is available", async () => {
    const session = new IncrementalBuildSession(process.cwd());
    const files = { "incremental-package-example.fun": 'import { String } from "effect"\nexport value = String.trim(" hello ")' };
    const first = await Effect.runPromise(session.build(files));
    const second = await Effect.runPromise(session.build(files));
    expect(first.check.success, first.check.formattedOutput).toBe(true);
    expect(second.outputs).toEqual(first.outputs);
    expect([second.compiled, second.reused]).toEqual([1, 0]);
  }, 60000);

  it("does not return output for a failing typecheck", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-build-error-"));
    const session = new IncrementalBuildSession(cwd);
    const result = await Effect.runPromise(session.build({ "bad.fun": 'export value: Number = "no"' }));
    expect(result.check.success).toBe(false);
    expect(result.outputs).toEqual({});
  }, 30000);
});
