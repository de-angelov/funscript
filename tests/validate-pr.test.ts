import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CHECKS,
  runCheck,
  formatTerminalSummary,
  formatGitHubStepSummary,
} from "../scripts/validate-pr.js";

describe("GitHub Agent PR Validation & CI Tooling (TASK-022)", () => {
  it("defines all required validation checks in CHECKS", () => {
    const checkNames = CHECKS.map((c) => c.name);
    expect(checkNames).toContain("FunScript CLI Formatting Check");
    expect(checkNames).toContain("Prettier Formatting Check");
    expect(checkNames).toContain("Build Package Artifacts");
    expect(checkNames).toContain("Vitest Test Suite");

    // Verify commands
    const commands = CHECKS.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    expect(commands).toContain("npm run fmt:check");
    expect(commands).toContain("npm run prettier:check");
    expect(commands).toContain("npm run build");
    expect(commands).toContain("npm test");

    // The formatter commands load the built CLI and Prettier plugin from dist/.
    expect(checkNames.indexOf("Build Package Artifacts")).toBeLessThan(
      checkNames.indexOf("FunScript CLI Formatting Check")
    );
    expect(checkNames.indexOf("Build Package Artifacts")).toBeLessThan(
      checkNames.indexOf("Prettier Formatting Check")
    );
  });

  it("runCheck handles successful commands properly", () => {
    const check = {
      name: "Mock Success",
      cmd: process.execPath,
      args: ["-e", "console.log('mock ok'); process.exit(0);"],
    };

    const res = runCheck(check);
    expect(res.passed).toBe(true);
    expect(res.status).toBe("PASSED");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("mock ok");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runCheck handles failing commands with error output and non-zero exit code", () => {
    const check = {
      name: "Mock Failure",
      cmd: process.execPath,
      args: ["-e", "console.error('fatal error'); process.exit(42);"],
    };

    const res = runCheck(check);
    expect(res.passed).toBe(false);
    expect(res.status).toBe("FAILED");
    expect(res.exitCode).toBe(42);
    expect(res.stderr).toContain("fatal error");
  });

  it("formatTerminalSummary correctly displays passing and failing suites", () => {
    const passedResults = [
      {
        name: "Check 1",
        command: "cmd1",
        passed: true,
        status: "PASSED",
        exitCode: 0,
        durationMs: 120,
        stdout: "",
        stderr: "",
      },
    ];
    const passSummary = formatTerminalSummary(passedResults);
    expect(passSummary).toContain("ALL AGENT CHECKS PASSED");
    expect(passSummary).toContain("✓ [PASS]");

    const failedResults = [
      {
        name: "Check 1",
        command: "cmd1",
        passed: false,
        status: "FAILED",
        exitCode: 1,
        durationMs: 120,
        stdout: "",
        stderr: "syntax error on line 4",
      },
    ];
    const failSummary = formatTerminalSummary(failedResults);
    expect(failSummary).toContain("FAILED CHECKS DETECTED");
    expect(failSummary).toContain("✗ [FAIL]");
    expect(failSummary).toContain("syntax error on line 4");
  });

  it("formatGitHubStepSummary generates valid markdown table and details", () => {
    const mixedResults = [
      {
        name: "Typecheck",
        command: "npx tsc --noEmit",
        passed: true,
        status: "PASSED",
        exitCode: 0,
        durationMs: 400,
        stdout: "",
        stderr: "",
      },
      {
        name: "Build",
        command: "npm run build",
        passed: false,
        status: "FAILED",
        exitCode: 1,
        durationMs: 800,
        stdout: "",
        stderr: "Cannot find module 'foo'",
      },
    ];

    const md = formatGitHubStepSummary(mixedResults);
    expect(md).toContain("## 🤖 GitHub Agent PR Validation Summary");
    expect(md).toContain("| ✅ PASS | **Typecheck** | `npx tsc --noEmit` |");
    expect(md).toContain("| ❌ FAIL | **Build** | `npm run build` |");
    expect(md).toContain("<details open>");
    expect(md).toContain("Cannot find module 'foo'");
  });

  it("verifies .github/workflows/ci.yml configuration file exists and contains all required steps", () => {
    const ciPath = path.resolve(process.cwd(), ".github/workflows/ci.yml");
    expect(fs.existsSync(ciPath)).toBe(true);

    const content = fs.readFileSync(ciPath, "utf8");
    expect(content).toContain("pull_request:");
    expect(content).toContain("push:");
    expect(content).toContain("branches: [main]");
    expect(content).toContain("npm run fmt:check");
    expect(content).toContain("npm run prettier:check");
    expect(content).toContain("npm run build");
    expect(content).toContain("npm test");
    expect(content).toContain("timeout-minutes: 15");
    expect(content).not.toContain("node scripts/validate-pr.js");
  });

  it("excludes Slopboss workspaces from product test discovery", () => {
    const configPath = path.resolve(process.cwd(), "vitest.config.ts");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toContain("slopboss/workspaces/**");
  });

  it("verifies package.json contains verify and pr:check scripts", () => {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    expect(pkg.scripts.verify).toBe("npm run build && npm run fmt:check && npm test");
    expect(pkg.scripts["pr:check"]).toBe("node scripts/validate-pr.js");
  });
});
