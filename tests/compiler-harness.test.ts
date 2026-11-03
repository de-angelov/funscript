import { describe, it, expect } from "vitest";
import {
  compile,
  compileFailure,
  expectCompileError,
  compileAndRun,
  execute,
  evalExpression,
  typeCheck,
  expectNoDiagnostics,
  expectDiagnostic,
  assertFormattingIdempotent,
  assertFormat,
  assertFormattingIdempotentFile,
} from "./helpers/index.js";

describe("Reusable Compiler Test Harness", () => {
  describe("Compilation helpers", () => {
    it("compiles FunScript code without manual Effect runner boilerplate", async () => {
      const res = await compile("export a = 10\nexport b = a + 5");
      expect(res.typescript).toContain("export const a = 10;");
      expect(res.typescript).toContain("export const b = (a + 5);");
    });

    it("captures compilation failures cleanly", async () => {
      const failure = await compileFailure('export invalid = "a" < "b"');
      expect(failure.message).toContain("< is only available for numbers");
      expect((failure as any).span).toBeDefined();
    });

    it("asserts compilation errors with expectCompileError", async () => {
      const failure = await expectCompileError(
        'export invalid = (s: String) => s > "x"',
        "> is only available for numbers",
      );
      expect(failure.message).toContain("Order.isGreaterThan(String.Order)");
    });
  });

  describe("Execution and Compile-and-Run helpers", () => {
    it("compiles and executes arithmetic and lambdas", async () => {
      const code = `
export add = (a: Number, b: Number) => a + b
export sum = add(15, 27)
`;
      const exports = await execute(code);
      expect(exports.sum).toBe(42);
      expect(exports.add(3, 4)).toBe(7);
    });

    it("compiles and runs schemas and decodes input", async () => {
      const code = `
export schema User = {
  id: String
  name: String
}
`;
      const exports = await execute(code);
      expect(exports.User).toBeDefined();
      expect(exports.UserFromUnknown({ id: "u-123", name: "Alice" })).toEqual({
        id: "u-123",
        name: "Alice",
      });
    });

    it("injects custom external scope into execution environment", async () => {
      const code = `
export res = user.profile.name + " (" + (user.age + 1) + ")"
`;
      const exports = await execute(code, {
        scope: {
          user: { profile: { name: "Bob" }, age: 29 },
        },
      });
      expect(exports.res).toBe("Bob (30)");
    });

    it("evaluates custom expressions directly within compiled module scope", async () => {
      const code = `
export multiply = (x: Number, y: Number) => x * y
`;
      const val = await evalExpression<number>(code, "multiply(6, 7)");
      expect(val).toBe(42);
    });

    it("returns compiled typescript alongside evaluation results in compileAndRun", async () => {
      const res = await compileAndRun("export greet = (name: String) => \"Hello, \" + name");
      expect(res.typescript).toContain("export const greet");
      expect(res.exports.greet("World")).toBe("Hello, World");
    });
  });

  describe("Diagnostics and type check assertions", () => {
    it("asserts zero diagnostics on valid source code", async () => {
      const result = await expectNoDiagnostics(`
export num: Number = 42
export msg: String = "valid"
`);
      expect(result.success).toBe(true);
    });

    it("matches specific diagnostic expectations", async () => {
      const diag = await expectDiagnostic(
        'count: Number = "invalid-type"',
        "Type 'string' is not assignable to type 'number'",
      );
      expect(diag.category).toBe("error");
    });
  });

  describe("Formatting idempotence helpers", () => {
    it("asserts formatting matches expected string and is idempotent", () => {
      const formatted = assertFormat(
        "export   value =    123",
        "export value = 123\n",
      );
      expect(formatted).toBe("export value = 123\n");
    });

    it("asserts idempotence of an unformatted source snippet", () => {
      const pass = assertFormattingIdempotent("export updated = { ...user, role }");
      expect(pass).toContain("export updated =");
    });

    it("asserts idempotence of sample files on disk", () => {
      assertFormattingIdempotentFile("examples/hello.fun");
    });
  });
});
