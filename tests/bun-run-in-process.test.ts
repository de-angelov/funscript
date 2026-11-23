import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isBunAvailable } from "../src/cli/build-bun.js";

const CLI_PATH = path.resolve("dist/cli/index.js");

describe("In-Process Bun Run Engine", () => {
  it("detects Bun availability", () => {
    expect(isBunAvailable()).toBe(true);
  });

  it("runs FunScript in-process when executed with bun runtime", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "bun-inprocess-test-"),
    );
    const testFile = path.join(tempDir, "hello.fun");

    await fs.writeFile(
      testFile,
      `import { Console } from "effect"\nexport main = Console.log("bun-inprocess-success")\n`,
      "utf8",
    );

    // Run directly via bun CLI runtime with --no-check for isolated temp dir
    const result = spawnSync("bun", [CLI_PATH, "run", "--no-check", testFile], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bun-inprocess-success");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs FunScript with --fast flag via Bun runner", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "bun-fast-run-test-"),
    );
    const testFile = path.join(tempDir, "fast.fun");

    await fs.writeFile(
      testFile,
      `import { Console } from "effect"\nexport main = Console.log("bun-fast-flag-success")\n`,
      "utf8",
    );

    // Run via node CLI with --fast flag
    const result = spawnSync(
      "node",
      [CLI_PATH, "run", "--fast", "--no-check", testFile],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bun-fast-flag-success");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("passes program arguments through -- to in-process Bun runner", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-args-test-"));
    const testFile = path.join(tempDir, "args.fun");

    await fs.writeFile(
      testFile,
      `import { Console } from "effect"\nexport main = Console.log("ARG=" + process.argv.slice(2).join(","))\n`,
      "utf8",
    );

    const result = spawnSync(
      "bun",
      [CLI_PATH, "run", "--no-check", testFile, "--", "foo", "bar"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARG=foo,bar");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs project example in-process under Bun with type checking", () => {
    const result = spawnSync("bun", [CLI_PATH, "run", "examples/hello.fun"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Hello, Ada!, Hello, Grace!, Hello, Alan!");
  });
});
