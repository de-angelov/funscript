import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import ts from "typescript";
import { compileString } from "../src/compiler.js";

const evaluate = async (source: string, names: string[]) => {
  const result = await Effect.runPromise(compileString(source));
  const code = ts.transpile(result.typescript, { module: ts.ModuleKind.ESNext })
    .replace(/^export const /gm, "const ")
    .replace(/^export \{.*\};?\n/gm, "")
    .replace(/^export type .*;\n/gm, "")
    .replace(/^import .* from "effect";\n/gm, "")
    .replace(/^export const /gm, "const ")
    .replace(/^export type .*;\n/gm, "");
  const executable = code.replace(/\bexport\s+/g, "");
  return new Function("Effect", "Schema", `${executable}; return { ${names.join(", ")} };`)(Effect, Schema) as Record<string, (...args: unknown[]) => unknown>;
};

describe("runtime boundary validation", () => {
  it("validates exported JavaScript function arguments before running the body", async () => {
    const { greet } = await evaluate(`
export js greet = (name: string) ->
  effect
    "Hello, " + name
`, ["greet"]);

    await expect(greet("Ada")).resolves.toBe("Hello, Ada");
    expect(() => greet(42)).toThrow(/Expected string/);
  });

  it("provides runtime-validating constructors for record schemas", async () => {
    const { UserFromUnknown } = await evaluate(`
export schema User = {
  name: string
}
`, ["UserFromUnknown"]);

    expect(UserFromUnknown({ name: "Ada" })).toEqual({ name: "Ada" });
    expect(() => UserFromUnknown({ name: 42 })).toThrow(/Expected string/);
  });
});
