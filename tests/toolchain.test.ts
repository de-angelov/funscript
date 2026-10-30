import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("../scripts/toolchain.sh", import.meta.url).pathname;

describe("toolchain helper", () => {
  it("reports status and dry-runs without invoking npm mutations", () => {
    const dir = mkdtempSync(join(tmpdir(), "funscript-toolchain-"));
    const bin = join(dir, "bin");
    const log = join(dir, "calls");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho v20.11.0\n");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1" = --version ] && { echo 10.2.0; exit; }\n[ "$1" = ls ] && exit 1\nexit 0\n`);
    for (const name of ["node", "npm"]) execFileSync("chmod", ["+x", join(bin, name)]);
    try {
      const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
      expect(execFileSync("sh", [script, "status"], { encoding: "utf8", env })).toContain("FunScript CLI: not linked");
      const proposal = execFileSync("sh", [script, "uninstall", "--dry-run"], { encoding: "utf8", env });
      expect(proposal).toContain("npm unlink -g funscript");
      const calls = readFileSync(log, "utf8");
      expect(calls).not.toContain("link");
      expect(calls).not.toContain("unlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limits uninstall to the exact FunScript global link", () => {
    const posix = readFileSync(script, "utf8");
    const powershell = readFileSync(new URL("../scripts/toolchain.ps1", import.meta.url), "utf8");
    expect(posix).toContain("npm unlink -g funscript");
    expect(powershell).toContain("npm unlink -g funscript");
    expect(posix).not.toMatch(/npm\s+uninstall\s+-g\s+(node|npm|code)/);
    expect(powershell).not.toMatch(/npm\s+uninstall\s+-g\s+(node|npm|code)/);
  });
});
