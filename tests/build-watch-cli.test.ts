import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("CLI watch builds", () => {
  it("rebuilds changed files, enforces policy and recovers", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-watch-cli-"));
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(path.join(cwd, "funscript.config.fun"), "export config = { noTs: true }\n");
    const input = path.join(cwd, "src", "a.fun");
    const output = path.join(cwd, "dist", "a.ts");
    const forbidden = path.join(cwd, "src", "forbidden.ts");
    writeFileSync(input, "export value = 1\n");
    const child = spawn(process.execPath, [path.resolve("dist/cli/index.js"), "build", "src", "--watch"], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    try {
      await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 30000, interval: 100 });
      expect(readFileSync(output, "utf8")).toContain("1");
      writeFileSync(forbidden, "export const bad = 1;\n");
      await vi.waitFor(() => expect(stderr).toContain("disabled"), { timeout: 30000, interval: 100 });
      writeFileSync(input, "export value = 2\n");
      await new Promise(resolve => setTimeout(resolve, 2500));
      expect(readFileSync(output, "utf8")).toContain("1");
      unlinkSync(forbidden);
      await vi.waitFor(() => expect(readFileSync(output, "utf8")).toContain("2"), { timeout: 30000, interval: 100 });
      writeFileSync(input, "export value = 3\n");
      await vi.waitFor(() => expect(readFileSync(output, "utf8")).toContain("3"), { timeout: 30000, interval: 100 });
      expect(stdout).toContain("Built 1 file(s)");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
        await new Promise(resolve => child.once("exit", resolve));
      }
    }
  }, 100000);
});
