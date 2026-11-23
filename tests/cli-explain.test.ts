import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
const binPath = path.resolve(__dirname, "../dist/cli/index.js");

describe("funscript explain CLI", () => {
  it("shows an overview catalogue when invoked without arguments", async () => {
    const { stdout } = await execFileAsync("node", [binPath, "explain"]);
    expect(stdout).toContain("FunScript Language Reference");
    expect(stdout).toContain("Keywords & Control Flow:");
    expect(stdout).toContain("service");
    expect(stdout).toContain("effect");
    expect(stdout).toContain("schema");
    expect(stdout).toContain("Run 'funscript explain <topic>'");
  });

  it("lists all items when --list is passed", async () => {
    const { stdout } = await execFileAsync("node", [
      binPath,
      "explain",
      "--list",
    ]);
    expect(stdout).toContain("FunScript Language Reference");
    expect(stdout).toContain("Effect Ecosystem:");
    expect(stdout).toContain("Effect");
    expect(stdout).toContain("Layer");
    expect(stdout).toContain("Context");
  });

  it("explains a specific keyword with signature and snippet", async () => {
    const { stdout } = await execFileAsync("node", [
      binPath,
      "explain",
      "effect",
    ]);
    expect(stdout).toContain("effect (keyword)");
    expect(stdout).toContain("Signature:");
    expect(stdout).toContain("Description:");
    expect(stdout).toContain("Example:");
    expect(stdout).toContain("See also:");
  });

  it("explains schema variant constructor", async () => {
    const { stdout } = await execFileAsync("node", [
      binPath,
      "explain",
      "variant",
    ]);
    expect(stdout).toContain("variant (keyword)");
    expect(stdout).toContain("schema TypeName =");
  });

  it("outputs JSON when --json is provided for a topic", async () => {
    const { stdout } = await execFileAsync("node", [
      binPath,
      "explain",
      "match",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("match");
    expect(parsed.category).toBe("keyword");
    expect(parsed.signature).toBeDefined();
    expect(parsed.snippet).toBeDefined();
  });

  it("outputs JSON catalogue when --list --json is provided", async () => {
    const { stdout } = await execFileAsync("node", [
      binPath,
      "explain",
      "--list",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.effect).toBeDefined();
    expect(parsed.schema).toBeDefined();
    expect(parsed.service).toBeDefined();
  });

  it("reports unknown topics and suggests similar names", async () => {
    let error: any;
    try {
      await execFileAsync("node", [binPath, "explain", "effct"]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("Unknown topic 'effct'");
    expect(error.stderr).toContain("Did you mean: effect");
  });
});
