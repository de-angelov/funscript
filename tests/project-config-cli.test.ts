import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve("dist/cli/index.js");
const run = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });

describe("project configuration CLI", () => {
  it("builds with noDeepDestructure configured and enforces the policy", () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), "funscript-destructure-policy-"),
    );
    writeFileSync(
      path.join(dir, "funscript.config.fun"),
      "export config = { noDeepDestructure: true }",
    );
    mkdirSync(path.join(dir, "src"));
    const file = path.join(dir, "src/main.fun");
    writeFileSync(file, "export value = 1");

    for (const args of [
      ["build", "--no-check"],
      ["build", file, "--no-check"],
    ]) {
      const result = run(dir, args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }

    writeFileSync(file, "export f = ({ user: { profile: { name } } }) => name");
    const rejected = run(dir, ["build", file, "--no-check"]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain(
      "Destructuring depth of 3 exceeds the maximum allowed depth of 2",
    );
  });

  it("applies noTs and noGlobalThis without command-line flags", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-policy-"));
    writeFileSync(
      path.join(dir, "funscript.config.fun"),
      "export config = { noTs: true, noGlobalThis: true }",
    );
    const file = path.join(dir, "main.fun");
    writeFileSync(file, "export value = globalThis");
    for (const args of [
      ["check", file],
      ["emit", file],
      ["build", file, "--no-check", "--outDir", dir],
      ["run", file, "--no-check"],
    ]) {
      const result = run(dir, args);
      expect(result.status, result.error?.message).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "globalThis is disabled by project policy",
      );
    }
    writeFileSync(file, "ts { const x = 1; }");
    const result = run(dir, ["check", file]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "TypeScript escapes are disabled by --no-ts",
    );

    writeFileSync(
      path.join(dir, "funscript.config.fun"),
      "export config = { barePipelines: true }",
    );
    writeFileSync(
      file,
      'sec = { name: "test" }\nexport cleanName = sec.name |> String.trim',
    );
    const pipeResult = run(dir, ["check", file]);
    expect(pipeResult.status).not.toBe(0);
    expect(pipeResult.stdout + pipeResult.stderr).toContain(
      "Redundant pipeline prefix 'String.trim'",
    );
  });

  it("applies Effect-only rules within configured directories", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-effect-policy-"));
    writeFileSync(
      path.join(dir, "funscript.config.fun"),
      'export config = { effectOnly: ["src/domain"] }',
    );
    mkdirSync(path.join(dir, "src/domain"), { recursive: true });
    const domain = path.join(dir, "src/domain/model.fun");
    const other = path.join(dir, "src/other.fun");
    writeFileSync(
      domain,
      'import { readFile } from "node:fs"\nexport value = 1',
    );
    writeFileSync(
      other,
      'import { readFile } from "node:fs"\nexport value = 1',
    );
    const rejected = run(dir, ["emit", domain]);
    expect(rejected.status, rejected.error?.message).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain(
      "Effect-only policy disallows import",
    );
    const accepted = run(dir, ["emit", other]);
    expect(accepted.status, accepted.stderr || accepted.error?.message).toBe(0);
    writeFileSync(path.join(dir, "src/domain/helper.fun"), "export value = 1");
    writeFileSync(
      domain,
      'import { value } from "./helper.js"\nexport result = value',
    );
    const local = run(dir, ["emit", domain]);
    expect(local.status, local.stderr || local.error?.message).toBe(0);
    writeFileSync(
      domain,
      'import { value } from "../other.js"\nexport result = value',
    );
    const escape = run(dir, ["emit", domain]);
    expect(escape.status).not.toBe(0);
    expect(escape.stderr).toContain(
      "must remain within an Effect-only directory",
    );
    symlinkSync(other, path.join(dir, "src/domain/linked.fun"));
    writeFileSync(
      domain,
      'import { value } from "./linked.js"\nexport result = value',
    );
    const symlinkEscape = run(dir, ["emit", domain]);
    expect(symlinkEscape.status).not.toBe(0);
    expect(symlinkEscape.stderr).toContain(
      "must resolve to FunScript inside an Effect-only directory",
    );
    writeFileSync(
      path.join(dir, "src/domain/hidden.ts"),
      "export const x = 1;",
    );
    const scan = run(dir, ["check", "src"]);
    expect(scan.status).not.toBe(0);
    expect(scan.stdout + scan.stderr).toContain("hidden.ts");
  });

  it("scopes noTs and noGlobalThis to selected folders", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-folder-policy-"));
    writeFileSync(
      path.join(dir, "funscript.config.fun"),
      'export config = { noTs: ["src/domain"], noGlobalThis: ["src/domain"] }',
    );
    mkdirSync(path.join(dir, "src/domain"), { recursive: true });
    const domain = path.join(dir, "src/domain/model.fun");
    const other = path.join(dir, "src/other.fun");
    writeFileSync(domain, "export value = globalThis");
    writeFileSync(other, "export value = globalThis");
    for (const args of [
      ["check", domain],
      ["emit", domain],
      ["build", domain, "--no-check", "--outDir", dir],
    ]) {
      const denied = run(dir, args);
      expect(denied.status, denied.error?.message).not.toBe(0);
      expect(denied.stdout + denied.stderr).toContain(
        "globalThis is disabled by project policy",
      );
    }
    expect(run(dir, ["emit", other]).status).toBe(0);
    writeFileSync(domain, "ts { const x = 1; }");
    expect(run(dir, ["emit", domain]).stderr).toContain(
      "TypeScript escapes are disabled by --no-ts",
    );
    writeFileSync(path.join(dir, "src/domain/hidden.d.ts"), "");
    expect(run(dir, ["check", "src"]).stderr).toContain("hidden.d.ts");
  });

  it("fails closed on malformed policy", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-policy-invalid-"));
    writeFileSync(
      path.join(dir, "funscript.config.fun"),
      "export config = { noTS: true }",
    );
    writeFileSync(path.join(dir, "main.fun"), "export value = 1");
    const result = run(dir, ["emit", "main.fun"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("invalid FunScript config");
  });
});
