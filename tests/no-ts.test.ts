import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { checkString, compileString } from "../src/compiler.js";
import { createTypeCheckCache, typeCheckSource, typeCheckVirtualFiles } from "../src/compiler/check.js";

const strict = { noTs: true };

describe("no-ts mode", () => {
  it.each([
    ["declaration", 'ts { const secret = 1; }'],
    ["expression", 'export value = ts { 1 + 2 }'],
    ["type", 'export id = (value: ts { string }) => value'],
    ["nested expression", 'export value = () => [ts { 1 }]'],
  ])("rejects a TypeScript escape in a %s", async (_label, source) => {
    await expect(Effect.runPromise(compileString(source, "strict.fun", strict))).rejects.toThrow("TypeScript escapes are disabled by --no-ts");
    await expect(Effect.runPromise(checkString(source, "strict.fun", strict))).rejects.toThrow("TypeScript escapes are disabled by --no-ts");
  });

  it("rejects AssemblyScript blocks before invoking the AssemblyScript compiler", async () => {
    const source = 'as { export function answer(): i32 { return 42; } }';
    await expect(Effect.runPromise(compileString(source, "strict.fun", strict))).rejects.toThrow("AssemblyScript blocks are disabled by --no-ts");
    await expect(Effect.runPromise(checkString(source, "strict.fun", strict))).rejects.toThrow("AssemblyScript blocks are disabled by --no-ts");
  });

  it("does not mistake strings or comments for escapes and preserves default behavior", async () => {
    const safe = '// ts { not code }\nexport message = "ts { not code }"';
    await expect(Effect.runPromise(compileString(safe, "safe.fun", strict))).resolves.toBeDefined();
    await expect(Effect.runPromise(compileString('ts { const x = 1; }', "regular.fun"))).resolves.toBeDefined();
  });

  it("checks every supplied module and does not reuse permissive cache entries", async () => {
    const source = 'ts { const x = 1; }\nexport value = 1';
    const cache = createTypeCheckCache();
    const permissive = await Effect.runPromise(typeCheckSource(source, "cached.fun", { cache }));
    expect(permissive.success, permissive.formattedOutput).toBe(true);
    const blocked = await Effect.runPromise(typeCheckVirtualFiles({ "safe.fun": 'export value = 1', "cached.fun": source }, { cache, noTs: true }));
    expect(blocked.success).toBe(false);
    expect(blocked.formattedOutput).toContain("TypeScript escapes are disabled by --no-ts");
    expect(blocked.diagnostics.some(d => d.file.includes("cached.fun"))).toBe(true);
  });
});
