import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";

const compile = (code: string) =>
  Effect.runPromise(compileString(code, "boolean-test.fun"));

describe("boolean-only 'and' / 'or' enforcement", () => {
  it("allows boolean operands for 'and' and 'or'", async () => {
    const code = `export check = (a: Boolean, b: Boolean) => (a and b) or (not a)`;
    const compiled = await compile(code);
    expect(compiled.typescript).toContain("&&");
    expect(compiled.typescript).toContain("||");
    const checked = await Effect.runPromise(
      typeCheckSource(code, "boolean-ok.fun"),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("rejects string fallback with 'or'", async () => {
    await expect(
      compile(`export nameOr = (value: Option<String>) => value or "anon"`),
    ).rejects.toThrow(/Logical 'or' requires boolean operands/);
  });

  it("rejects optional string fallback with 'or'", async () => {
    await expect(
      compile(`export fallback = (x: JSNullish<String>) => x or "default"`),
    ).rejects.toThrow(/Logical 'or' requires boolean operands/);
  });

  it("rejects ternary-style 'cond and a or b'", async () => {
    await expect(
      compile(`export pick = (flag: Boolean) => flag and "yes" or "no"`),
    ).rejects.toThrow(/Logical '(and|or)' requires boolean operands/);
  });

  it("rejects 'and' with JSX element", async () => {
    await expect(
      Effect.runPromise(
        compileString(
          `export View = (show: Boolean) => <div>{show and <span>Hi</span>}</div>`,
          "boolean-jsx.funx",
        ),
      ),
    ).rejects.toThrow(/Logical '(and|or)' requires boolean operands/);
  });
});
