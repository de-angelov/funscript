import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CLI_PATH = new URL("../dist/cli/index.js", import.meta.url).pathname;
const CLI_DOCS = new URL("../docs/reference/cli.md", import.meta.url);

const runCli = (...args: string[]) =>
  execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });

describe("CLI help contract", () => {
  it("lists the commands implemented by dispatch", () => {
    const help = runCli("--help");
    const docs = readFileSync(CLI_DOCS, "utf8");

    for (const command of ["build", "emit", "check", "run", "repl", "lsp", "fmt", "version"]) {
      expect(help).toContain(`funscript ${command}`);
      expect(docs).toContain(`\`funscript ${command}`);
    }
  });

  it("clearly marks planned wrappers as unavailable", () => {
    const help = runCli("--help");

    expect(help).toContain("not currently available");
    for (const command of ["new", "dev", "preview", "test", "add", "doctor"]) {
      expect(help).not.toMatch(new RegExp(`^\\s*funscript ${command}(?:\\s|$)`, "m"));
    }
  });

  it("prints help for an unknown command instead of dispatching it", () => {
    expect(runCli("unknown-command")).toContain("Usage:");
  });
});
