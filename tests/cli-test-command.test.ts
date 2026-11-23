import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as testingAdapter from "../src/testing/index.js";

const CLI_PATH = path.resolve("dist/cli/index.js");

describe("CLI Test Command (funscript test)", () => {
  it("exports universal testing functions from testing module", () => {
    expect(typeof testingAdapter.describe).toBe("function");
    expect(typeof testingAdapter.it).toBe("function");
    expect(typeof testingAdapter.test).toBe("function");
    expect(typeof testingAdapter.expect).toBe("function");
    expect(typeof testingAdapter.assert).toBe("function");
  });

  it("displays test command in funscript --help and funscript help test", () => {
    const helpAll = spawnSync("node", [CLI_PATH, "--help"], {
      encoding: "utf8",
    });
    expect(helpAll.status).toBe(0);
    expect(helpAll.stdout).toContain("funscript test");

    const helpTest = spawnSync("node", [CLI_PATH, "help", "test"], {
      encoding: "utf8",
    });
    expect(helpTest.status).toBe(0);
    expect(helpTest.stdout).toContain(
      "Run unit and integration tests across FunScript",
    );
  });

  it("executes a native FunScript test file via funscript test", () => {
    const result = spawnSync(
      "node",
      [CLI_PATH, "test", "tests/native-funscript.test.fun"],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tests/native-funscript.test.fun");
    expect(result.stdout).toContain("3 passed");
    expect(result.stdout).toContain("1 passed");
  });
});
