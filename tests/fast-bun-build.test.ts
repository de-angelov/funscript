import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildBunExecutable,
  buildRunBundle,
  isBunAvailable,
} from "../src/cli/build-bun.js";

describe("Fast Bun Build Engine", () => {
  it("detects Bun availability in the system", () => {
    expect(typeof isBunAvailable()).toBe("boolean");
    expect(isBunAvailable()).toBe(true);
  });

  it("builds executable with native Bun engine and runs successfully", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fast-bun-test-"));
    const entryFile = path.join(tempDir, "app.fun");
    const outFile = path.join(tempDir, "app.js");

    await fs.writeFile(
      entryFile,
      `import { Console } from "effect"\nexport greet = (name: String) => \`Hello \${name}\`\nexport main = Console.log(greet("Bun"))\n`,
      "utf8",
    );

    await buildBunExecutable(entryFile, outFile, {
      cwd: tempDir,
      engine: "bun",
    });

    const stat = await fs.stat(outFile);
    expect(stat.isFile()).toBe(true);
    // Executable bit set
    expect((stat.mode & 0o111) !== 0).toBe(true);

    const content = await fs.readFile(outFile, "utf8");
    expect(content.startsWith("#!/usr/bin/env bun")).toBe(true);

    // Execute built file directly with Bun
    const runResult = spawnSync("bun", [outFile], { encoding: "utf8" });
    expect(runResult.status).toBe(0);
    expect(runResult.stdout).toContain("Hello Bun");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds executable with esbuild engine fallback and runs successfully", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "esbuild-fallback-test-"),
    );
    const entryFile = path.join(tempDir, "app.fun");
    const outFile = path.join(tempDir, "app.js");

    await fs.writeFile(
      entryFile,
      `import { Console } from "effect"\nexport add = (x: Int, y: Int) => x + y\nexport main = Console.log("sum=" + add(20, 22))\n`,
      "utf8",
    );

    await buildBunExecutable(entryFile, outFile, {
      cwd: tempDir,
      engine: "esbuild",
    });

    const stat = await fs.stat(outFile);
    expect(stat.isFile()).toBe(true);
    expect((stat.mode & 0o111) !== 0).toBe(true);

    const content = await fs.readFile(outFile, "utf8");
    expect(content.startsWith("#!/usr/bin/env bun")).toBe(true);

    const runResult = spawnSync("bun", [outFile], { encoding: "utf8" });
    expect(runResult.status).toBe(0);
    expect(runResult.stdout).toContain("sum=42");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds runnable bundle with runMain integration", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "bun-runmain-test-"),
    );
    const entryFile = path.join(tempDir, "main.fun");
    const outFile = path.join(tempDir, "main.mjs");

    await fs.writeFile(
      entryFile,
      `import { Console } from "effect"\nexport main = Console.log("effect-main-executed")\n`,
      "utf8",
    );

    await buildRunBundle(entryFile, outFile, {
      cwd: tempDir,
      engine: "bun",
    });

    const content = await fs.readFile(outFile, "utf8");
    expect(content).toContain("__funscript_effect.Effect.runPromise");

    const runResult = spawnSync("bun", [outFile], { encoding: "utf8" });
    expect(runResult.status).toBe(0);
    expect(runResult.stdout).toContain("effect-main-executed");

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
