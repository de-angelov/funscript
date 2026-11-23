import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const execFileAsync = promisify(execFile);
const binPath = path.resolve(__dirname, "../dist/cli/index.js");

describe("funscript check --fix CLI", () => {
  it("automatically fixes unformatted FunScript files during check", async () => {
    const tmpDir = path.resolve(__dirname, "../.tmp-fix-test");
    await fs.mkdir(tmpDir, { recursive: true });
    const targetFile = path.join(tmpDir, "unformatted.fun");

    // Code with irregular spacing and formatting
    const unformattedCode = `export   greet   =   (name: String)   =>   \n  =>   "Hello, {name}!"\n`;
    await fs.writeFile(targetFile, unformattedCode, "utf8");

    try {
      const { stdout } = await execFileAsync("node", [
        binPath,
        "check",
        targetFile,
        "--fix",
      ]);

      expect(stdout).toContain(`✓ Fixed ${targetFile}`);
      expect(stdout).toContain("✓ Fixed formatting and style");

      const fixedContent = await fs.readFile(targetFile, "utf8");
      expect(fixedContent).not.toBe(unformattedCode);
      expect(fixedContent).toContain("export greet = (name: String) =>");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
