import { describe, expect, it, vi } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { validateNumericComparisons } from "../src/compiler/numeric-comparisons.js";
import type { TypeScriptCompilationContext } from "../src/compiler/typescript-context.js";

function validate(source: string, check: ReturnType<typeof vi.fn>): void {
  const ast = new Parser(
    new Lexer(source, "test.fun").tokenize(),
    "test.fun",
    source,
  ).parse();
  validateNumericComparisons(ast, source, {
    check,
  } as unknown as TypeScriptCompilationContext);
}

describe("numeric comparison fast path", () => {
  it("checks direct primitive parameters without constructing a TypeScript program", () => {
    const check = vi.fn();
    expect(() =>
      validate("export compare = (a: Number, b: Number) => a < b", check),
    ).not.toThrow();
    expect(() =>
      validate("export compare = (a: String, b: String) => a < b", check),
    ).toThrow("< is only available for numbers; this operand has type string.");
    expect(check).not.toHaveBeenCalled();
  });

  it("points at the first nonnumeric operand", () => {
    const source = "export compare = (a: Number, b: String) => a < b";
    const check = vi.fn();
    try {
      validate(source, check);
      throw new Error("Expected a comparison diagnostic");
    } catch (error: any) {
      expect(error.message).toContain("operand has type string");
      expect(error.span.start.offset).toBe(source.lastIndexOf("b"));
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("falls back to TypeScript for expressions and non-primitive or optional parameters", () => {
    for (const source of [
      "export compare = (a: Number, b: Number) => a + 1 < b",
      "export compare = <A>(a: A, b: A) => a < b",
      "export compare = (a: Option<Number>, b: Option<Number>) => a < b",
      "export compare = (a: String, b: Number) => a < (b + 1)",
    ]) {
      const check = vi.fn().mockReturnValue(undefined);
      expect(() => validate(source, check)).not.toThrow();
      expect(check).toHaveBeenCalledOnce();
    }
  });
});
