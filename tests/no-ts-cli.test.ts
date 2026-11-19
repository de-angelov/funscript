import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("rejects standalone JS and TS sources in audited directories, including declarations and symlinks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-no-ts-files-"));
    writeFileSync(path.join(dir, "main.fun"), "export value = 1\n");
    for (const file of ["helper.ts", "component.tsx", "types.d.ts", "types.d.mts", "script.js", "module.mjs", "legacy.cjs", "view.jsx", "kernel.as"]) {
      writeFileSync(path.join(dir, file), "");
    }
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", "dependency.ts"), "");
    const external = mkdtempSync(path.join(tmpdir(), "funscript-no-ts-target-"));
    writeFileSync(path.join(external, "hidden.ts"), "");
    symlinkSync(path.join(external, "hidden.ts"), path.join(dir, "hidden.fun"));
    for (const args of [["check", dir, "--no-ts"], ["build", dir, "--no-ts", "--no-check"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      expect(result.status, result.error?.message).not.toBe(0);
      const output = result.stdout + result.stderr;
      for (const file of ["helper.ts", "component.tsx", "types.d.ts", "types.d.mts", "script.js", "module.mjs", "legacy.cjs", "view.jsx", "kernel.as", "hidden.fun"]) expect(output).toContain(file);
      expect(output).not.toContain("dependency.ts");
    }
  });

  it("accepts FunScript-only source directories while ignoring dependencies", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-no-ts-clean-"));
    writeFileSync(path.join(dir, "main.fun"), "export value = 1\n");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", "dependency.js"), "export const x = 1;");
    const result = spawnSync(process.execPath, [cli, "check", dir, "--no-ts"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  });

  it("rejects an explicitly targeted TypeScript file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-no-ts-target-file-"));
    const file = path.join(dir, "ambient.d.ts");
    writeFileSync(file, "declare const value: number;");
    const result = spawnSync(process.execPath, [cli, "check", file, "--no-ts"], { encoding: "utf8" });
    expect(result.status, result.error?.message).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("JavaScript, TypeScript and AssemblyScript source files are disabled by --no-ts");
  });

});
