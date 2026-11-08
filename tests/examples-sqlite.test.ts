import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileString } from "../src/compiler.js";
import { typeCheckFiles } from "../src/compiler/check.js";

const execFileAsync = promisify(execFile);
const examplePath = path.resolve("programs/09-sqlite-repository.fun");
const supportsSqlite = Number(process.versions.node.split(".")[0]) >= 22;

describe("SQLite repository example", () => {
  it("compiles and type-checks the native SQLite repository", async () => {
    const source = await fs.readFile(examplePath, "utf8");
    const compiled = await Effect.runPromise(compileString(source, examplePath));
    expect(compiled.typescript).toContain("createRequire(import.meta.url)");
    expect(compiled.typescript).toContain("Schema.Struct");

    const check = await Effect.runPromise(typeCheckFiles([examplePath]));
    expect(check.success, JSON.stringify(check.diagnostics)).toBe(true);
    expect(check.errorCount).toBe(0);
  });

  it.skipIf(!supportsSqlite)("runs create, update, and delete against an in-memory database", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.resolve("dist/cli/index.js"),
      "run",
      examplePath,
    ]);
    expect(stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings ...` to show where the warning was created\)\n?/g, "")).toBe("");
    expect(stdout).toContain(
      JSON.stringify({
        created: { id: 1, name: "Ada", email: "ada@example.com" },
        updated: { id: 1, name: "Ada Lovelace", email: "ada@example.com" },
        deleted: true,
      }),
    );
  });
});
