import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve("dist/cli/index.js");

describe("--no-ts CLI", () => {
  it("enforces the mode in check, emit, build and run, including --no-check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-no-ts-"));
    const file = path.join(dir, "escape.fun");
    writeFileSync(file, 'ts { const value = 1; }\nexport result = 1\n');
    for (const args of [
      ["check", file, "--no-ts"],
      ["emit", file, "--no-ts"],
      ["build", file, "--no-check", "--no-ts", "--outDir", dir],
      ["run", file, "--no-check", "--no-ts"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      expect(result.status, result.error?.message).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("TypeScript escapes are disabled by --no-ts");
    }
  });

  it("checks imported FunScript modules", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-no-ts-import-"));
    const entry = path.join(dir, "main.fun");
    writeFileSync(entry, 'import { value } from "./dep.js"\nexport result = value\n');
    writeFileSync(path.join(dir, "dep.fun"), 'ts { const secret = 1; }\nexport value = 1\n');
    const result = spawnSync(process.execPath, [cli, "check", entry, "--no-ts"], { encoding: "utf8" });
    expect(result.status, result.error?.message).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("TypeScript escapes are disabled by --no-ts");
    expect(result.stdout + result.stderr).toContain("dep.fun");
  });
});
