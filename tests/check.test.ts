import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  typeCheckSource,
  typeCheckVirtualFiles,
  typeCheckFiles,
  formatDiagnostics,
} from "../src/compiler/check.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("./dist/cli/index.js");

describe("In-Memory Type-Checking (funscript check via TypeScript API)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "funscript-check-test-"));
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("typeCheckSource unit checks", () => {
    it("type-checks brace-delimited Effect expressions", async () => {
      const result = await Effect.runPromise(typeCheckSource(`
fetchValue = () -> Effect.succeed(42)
export result: Effect<Number> = effect {
  value <- fetchValue()
  value + 1
}
`.trim(), "brace-effect.fun"));
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("passes cleanly on valid FunScript code with no diagnostics", async () => {
      const code = `
export name: String = "Ada"
export age: Number = 36
export fn greet(n: String) => "Hello, " + n
export message = greet(name)
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "valid.fun"));
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
      expect(result.errorCount).toBe(0);
      expect(result.formattedOutput).toBe("");
    });

    it("detects variable type mismatch and maps back to original line and column", async () => {
      const code = `
export title: String = "FunScript"
export count: Number = "not-a-number"
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "type-err.fun"));
      expect(result.success).toBe(false);
      expect(result.errorCount).toBeGreaterThanOrEqual(1);

      const err = result.diagnostics.find((d) => d.message.includes("not assignable to type 'number'"));
      expect(err).toBeDefined();
      expect(err?.diagnosticCode).toMatch(/^TS\d+$/);
      expect(err?.explanation).toContain("generated source");
      expect(err!.file).toBe("type-err.fun");
      expect(err!.line).toBe(2);
      expect(err!.column).toBeGreaterThan(0);
      expect(err!.frame).toBeDefined();
      expect(err!.frame).toContain("export count: Number = \"not-a-number\"");
      expect(err!.formatted).toContain("type-err.fun:2:");
    });

    it("detects function argument type mismatch with exact line and column", async () => {
      const code = `
fn calculate(a: Number, b: Number) => a + b
export result = calculate("hello", 42)
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "func-err.fun"));
      expect(result.success).toBe(false);

      const err = result.diagnostics.find((d) =>
        d.message.includes("Argument of type 'string' is not assignable to parameter of type 'number'")
      );
      expect(err).toBeDefined();
      expect(err!.file).toBe("func-err.fun");
      expect(err!.line).toBe(2);
      expect(err!.column).toBe(27); // Points to "hello"
      expect(err!.frame).toBeDefined();
      expect(err!.frame).toContain("calculate(\"hello\", 42)");
    });

    it("detects function return type mismatch", async () => {
      const code = `
fn getAnswer(): Number {
  => "forty-two"
}
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "ret-err.fun"));
      expect(result.success).toBe(false);
      const err = result.diagnostics.find((d) =>
        d.message.includes("Type 'string' is not assignable to type 'number'")
      );
      expect(err).toBeDefined();
      expect(err!.line).toBeGreaterThanOrEqual(1);
    });

    it("type checks Schema definitions and detects property type mismatches", async () => {
      const code = `
schema User = {
  id: Number
  email: String
}

export user: User = {
  id: "wrong-id",
  email: 12345
}
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "schema-err.fun"));
      expect(result.success).toBe(false);
      expect(result.errorCount).toBeGreaterThanOrEqual(2);

      const idErr = result.diagnostics.find(
        (d) => d.message.includes("Type 'string' is not assignable to type 'number'")
      );
      expect(idErr).toBeDefined();
      expect(idErr!.line).toBe(7);

      const emailErr = result.diagnostics.find(
        (d) => d.message.includes("Type 'number' is not assignable to type 'string'")
      );
      expect(emailErr).toBeDefined();
      expect(emailErr!.line).toBe(8);
    });

    it("type checks Effect structures imported from effect", async () => {
      const code = `
export eff: Effect<Number, Never, Never> = Effect.succeed("string-value")
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "effect-err.fun"));
      expect(result.success).toBe(false);
      const err = result.diagnostics.find((d) =>
        d.message.includes("Type 'string' is not assignable to type 'number'") ||
        d.message.includes("Effect<string, never, never>")
      );
      expect(err).toBeDefined();
      expect(err!.line).toBe(1);
    });

    it("handles FunScript syntax errors gracefully as diagnostics with code frames", async () => {
      const code = `
fn broken(
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "syntax-err.fun"));
      expect(result.success).toBe(false);
      expect(result.errorCount).toBe(1);
      expect(result.diagnostics[0].category).toBe("error");
      expect(result.diagnostics[0].code).toBe("SYNTAX");
      expect(result.diagnostics[0].diagnosticCode).toBe("FS_SYNTAX");
      expect(result.diagnostics[0].line).toBe(1);
      expect(result.diagnostics[0].frame).toBeDefined();
    });
  });

  describe("typeCheckVirtualFiles multi-file checks", () => {
    it("resolves and type checks imports between virtual modules", async () => {
      const files = {
        "src/utils.fun": `
export fn multiply(a: Number, b: Number) => a * b
`.trim(),
        "src/main.fun": `
import { multiply } from "./utils.js"
export res = multiply(6, "invalid")
`.trim(),
      };

      const result = await Effect.runPromise(typeCheckVirtualFiles(files));
      expect(result.success).toBe(false);

      const err = result.diagnostics.find((d) =>
        d.message.includes("Argument of type 'string' is not assignable to parameter of type 'number'")
      );
      expect(err).toBeDefined();
      expect(err!.file).toBe("src/main.fun");
      expect(err!.line).toBe(2);
      expect(err!.column).toBe(26);
    });

    it("passes cleanly when multiple virtual modules have correct types", async () => {
      const files = {
        "src/types.fun": `
schema Config = {
  port: Number
  host: String
}
export config: Config = { port: 8080, host: "localhost" }
`.trim(),
        "src/server.fun": `
import { config } from "./types.js"
export fn getUrl() => "http://" + config.host + ":" + config.port
`.trim(),
      };

      const result = await Effect.runPromise(typeCheckVirtualFiles(files));
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe(".funx component type checking", () => {
    it("type checks .funx UI components and detects prop errors", async () => {
      const code = `
schema Props = {
  label: String
}

export Button = (props: Props) ->
  <button>{props.unknownProp}</button>
`.trim();

      const result = await Effect.runPromise(typeCheckSource(code, "Button.funx"));
      expect(result.success).toBe(false);
      const err = result.diagnostics.find((d) =>
        d.message.includes("Property 'unknownProp' does not exist")
      );
      expect(err).toBeDefined();
      expect(err!.file).toBe("Button.funx");
      expect(err!.line).toBe(6);
    });
  });

  describe("formatDiagnostics utility", () => {
    it("formats empty diagnostics as empty string", () => {
      expect(formatDiagnostics([])).toBe("");
    });

    it("formats multiple diagnostics with headers, frames, and error summary", () => {
      const formatted = formatDiagnostics([
        {
          file: "a.fun",
          line: 1,
          column: 5,
          message: "Type mismatch",
          category: "error",
          code: 2322,
          formatted: "a.fun:1:5 - error TS2322: Type mismatch\n  1 | test",
        },
        {
          file: "b.fun",
          line: 3,
          column: 2,
          message: "Unused variable",
          category: "warning",
          code: 6133,
          formatted: "b.fun:3:2 - warning TS6133: Unused variable\n  3 | let unused",
        },
      ]);

      expect(formatted).toContain("a.fun:1:5 - error TS2322: Type mismatch");
      expect(formatted).toContain("b.fun:3:2 - warning TS6133: Unused variable");
      expect(formatted).toContain("Found 1 error and 1 warning.");
    });
  });

  describe("CLI integration (funscript check)", () => {
    it("exits with 0 and prints success message for a valid FunScript file", async () => {
      const testFile = path.join(tmpDir, "cli-valid.fun");
      await fs.writeFile(
        testFile,
        `
export fn square(x: Number) => x * x
export res = square(5)
`.trim(),
        "utf-8"
      );

      const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, "check", testFile]);
      expect(stderr).toBe("");
      expect(stdout).toContain(`✓ ${testFile} checked successfully (0 errors)`);
    });

    it("exits with 1 and prints mapped diagnostics with @babel/code-frame for a file with type errors", async () => {
      const testFile = path.join(tmpDir, "cli-invalid.fun");
      await fs.writeFile(
        testFile,
        `
fn greet(name: String) => "Hello, " + name
export res = greet(12345)
`.trim(),
        "utf-8"
      );

      let failed = false;
      try {
        await execFileAsync("node", [CLI_PATH, "check", testFile]);
      } catch (err: any) {
        failed = true;
        expect(err.code).toBe(1);
        const output = (err.stderr || "") + (err.stdout || "");
        expect(output).toContain("cli-invalid.fun:2:");
        expect(output).toContain("Argument of type 'number' is not assignable to parameter of type 'string'");
        expect(output).toContain("greet(12345)");
        expect(output).toContain("Found 1 error.");
      }
      expect(failed).toBe(true);
    });

    it("checks multiple files passed on the command line", async () => {
      const fileA = path.join(tmpDir, "cli-multi-a.fun");
      const fileB = path.join(tmpDir, "cli-multi-b.fun");
      await fs.writeFile(fileA, 'export name = "Ada"\n', "utf-8");
      await fs.writeFile(fileB, 'export age = 36\n', "utf-8");

      const { stdout } = await execFileAsync("node", [CLI_PATH, "check", fileA, fileB]);
      expect(stdout).toContain("✓ Checked 2 files successfully (0 errors)");
    });
  });
});
