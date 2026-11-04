import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { auditIdiomaticFunScript } from "../src/tooling/idiomatic.js";
import { checkIdiomatic, findFunScriptFiles } from "../scripts/check-idiomatic.mjs";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/cli/index.js");

describe("Audit Showcase Examples and Restrict Unjustified 'ts { }' Blocks (TASK-181)", () => {
  describe("Showcase examples idiomatic verification", () => {
    it("verifies all examples contain zero non-ambient 'ts { }' blocks", async () => {
      const { success, totalFiles, totalViolations, results } = await checkIdiomatic();
      expect(totalFiles).toBeGreaterThan(15);
      expect(totalViolations).toBe(0);
      expect(success).toBe(true);

      const failed = results.filter((r) => !r.success);
      expect(failed).toEqual([]);
    });

    it("verifies examples/todo-service.fun uses native FunScript arrays and zero ts blocks", async () => {
      const content = await fs.readFile(path.resolve("examples/todo-service.fun"), "utf-8");
      expect(content).not.toContain("ts {");
      expect(content).toContain("mut store: Array<Todo> = []");
      expect(content).toContain("store = store |> Array.append(newTodo)");
    });

    it("verifies examples/markdown-task-manager.fun uses native TaskManager schema and zero ts blocks", async () => {
      const content = await fs.readFile(path.resolve("examples/markdown-task-manager.fun"), "utf-8");
      expect(content).not.toContain("ts {");
      expect(content).toContain("export schema TaskManager = {");
      expect(content).toContain("tasks: Array<Task>");
      expect(content).toContain("nextId: Number");
      expect(content).toContain('import { writeFile, readFile, unlink } from "node:fs/promises"');
    });

    it("verifies examples/github-api-client.fun uses native RawApiResponse schema and zero ts blocks", async () => {
      const content = await fs.readFile(path.resolve("examples/github-api-client.fun"), "utf-8");
      expect(content).not.toContain("ts {");
      expect(content).toContain("export schema RawApiResponse = {");
      expect(content).toContain("export executeFetch = (repoPath: String) =>");
      expect(content).toContain("raw <- js executeFetch(repoPath)");
    });

    it("verifies examples/order-fulfillment.fun uses native FunScript types and zero ts blocks", async () => {
      const content = await fs.readFile(path.resolve("examples/order-fulfillment.fun"), "utf-8");
      expect(content).not.toContain("ts {");
      expect(content).toContain("export appendAuditEntry = (logs: Array<String>, entry: String) =>");
      expect(content).toContain("mut paymentCallCount: Number = 0");
    });

    it("verifies examples/todo-dashboard.funx implements addTodo in native FunScript", async () => {
      const content = await fs.readFile(path.resolve("examples/todo-dashboard.funx"), "utf-8");
      expect(content).toContain("export addTodo = (todos: Array<Todo>, title: String): Array<Todo> =>");
      expect(content).toContain("draft.push({ id: \"new-task\", title, completed: false })");

      // Verify that any ts block in todo-dashboard is restricted strictly to runtime React polyfill
      const audit = auditIdiomaticFunScript(content, "examples/todo-dashboard.funx");
      expect(audit.success).toBe(true);
      expect(audit.diagnostics).toEqual([]);
    });
  });

  describe("Static audit linter diagnostic detection", () => {
    it("flags top-level function declarations inside 'ts { }' blocks", () => {
      const code = `
ts {
  export async function writeTaskFile(filePath: string, content: string): Promise<boolean> {
    return true;
  }
}
      `.trim();
      const res = auditIdiomaticFunScript(code, "test.fun");
      expect(res.success).toBe(false);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].kind).toBe("non-ambient-function-declaration");
      expect(res.diagnostics[0].message).toContain("Top-level function declaration 'writeTaskFile' inside 'ts { }' block is forbidden");
    });

    it("flags function definitions assigned to variables inside 'ts { }' blocks", () => {
      const code = `
ts {
  export const addTodo = (todos: any[], title: string) => {
    return [];
  };
}
      `.trim();
      const res = auditIdiomaticFunScript(code, "test.fun");
      expect(res.success).toBe(false);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].kind).toBe("non-ambient-function-definition");
      expect(res.diagnostics[0].message).toContain("Function definition 'addTodo' inside 'ts { }' block is forbidden");
    });

    it("flags imports declared inside 'ts { }' blocks", () => {
      const code = `
ts {
  import * as fs from "node:fs/promises";
}
      `.trim();
      const res = auditIdiomaticFunScript(code, "test.fun");
      expect(res.success).toBe(false);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].kind).toBe("import-inside-ts-block");
      expect(res.diagnostics[0].message).toContain("Import declaration inside 'ts { }' block is forbidden");
    });

    it("flags function expressions inside inline 'ts { }' escape expressions", () => {
      const code = `
export helper = ts { () => 42 }
      `.trim();
      const res = auditIdiomaticFunScript(code, "test.fun");
      expect(res.success).toBe(false);
      expect(res.diagnostics).toHaveLength(1);
      expect(res.diagnostics[0].kind).toBe("non-ambient-expression");
      expect(res.diagnostics[0].message).toContain("Function expression inside 'ts { }' escape is forbidden");
    });

    it("allows ambient type declarations and valid runtime polyfills in 'ts { }'", () => {
      const code = `
ts {
  type Timestamp = number;
  interface Config { timeout: number }
  declare global { namespace JSX { interface IntrinsicElements {} } }
  declare function externalApi(): void;
  declare const ambientEnv: string;
  export const React = {
    createElement: (tag: any, props: any, ...children: any[]) => ({ tag, props, children })
  };
}
      `.trim();
      const res = auditIdiomaticFunScript(code, "test.fun");
      expect(res.success).toBe(true);
      expect(res.diagnostics).toEqual([]);
    });
  });

  describe("CLI integration and audit script verification", () => {
    it("runs scripts/check-idiomatic.mjs via CLI and exits 0 on valid codebase", async () => {
      const { stdout, stderr } = await execFileAsync("node", ["scripts/check-idiomatic.mjs"]);
      expect(stderr).toBe("");
      expect(stdout).toContain("✓ Idiomatic check passed");
    }, 30_000);

    it("checks with funscript check --idiomatic and passes cleanly on valid files", async () => {
      const { stdout, stderr } = await execFileAsync("node", [
        cliPath,
        "check",
        "examples/todo-service.fun",
        "--idiomatic",
      ]);
      expect(stderr).toBe("");
      expect(stdout).toContain("✓ examples/todo-service.fun checked successfully (0 errors)");
    }, 30_000);

    it("fails funscript check --idiomatic when non-ambient ts blocks are detected", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "idiomatic-cli-test-"));
      const badFile = path.join(tmpDir, "bad-ts.fun");
      await fs.writeFile(
        badFile,
        `
ts {
  export function helper(): number {
    return 42;
  }
}

export value = 1
        `.trim(),
        "utf-8",
      );

      try {
        let failed = false;
        try {
          await execFileAsync("node", [cliPath, "check", badFile, "--idiomatic"]);
        } catch (err: any) {
          failed = true;
          expect(err.code).toBe(1);
          expect(err.stderr).toContain("Top-level function declaration 'helper' inside 'ts { }' block is forbidden");
        }
        expect(failed).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
