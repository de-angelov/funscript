#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const CHECKS = [
  {
    name: "Typecheck (Core & LSP)",
    cmd: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    name: "Typecheck (VS Code Extension)",
    cmd: "npx",
    args: ["tsc", "-p", "editors/vscode", "--noEmit"],
  },
  {
    name: "FunScript CLI Formatting Check",
    cmd: "npm",
    args: ["run", "fmt:check"],
  },
  {
    name: "Prettier Formatting Check",
    cmd: "npm",
    args: ["run", "prettier:check"],
  },
  {
    name: "Build Package Artifacts",
    cmd: "npm",
    args: ["run", "build"],
  },
  {
    name: "Vitest Test Suite",
    cmd: "npm",
    args: ["test"],
  },
];

export function runCheck(check, options = {}) {
  const startTime = Date.now();
  const res = spawnSync(check.cmd, check.args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    shell: process.platform === "win32",
  });
  const durationMs = Date.now() - startTime;
  const passed = res.status === 0;
  return {
    name: check.name,
    command: `${check.cmd} ${check.args.join(" ")}`,
    passed,
    status: passed ? "PASSED" : "FAILED",
    exitCode: res.status ?? 1,
    durationMs,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

export function formatTerminalSummary(results) {
  const lines = [];
  lines.push("\n=======================================================");
  lines.push("           GitHub Agent PR Validation Summary          ");
  lines.push("=======================================================");

  for (const r of results) {
    const icon = r.passed ? "✓ [PASS]" : "✗ [FAIL]";
    const dur = (r.durationMs / 1000).toFixed(2) + "s";
    lines.push(`  ${icon.padEnd(9)} ${r.name.padEnd(35)} (${dur})`);
  }
  lines.push("-------------------------------------------------------");

  const allPassed = results.every((r) => r.passed);
  if (allPassed) {
    lines.push("  Result: ALL AGENT CHECKS PASSED (Ready for PR/Merge) ");
    lines.push("=======================================================\n");
  } else {
    lines.push("  Result: FAILED CHECKS DETECTED                      ");
    lines.push("=======================================================\n");
    for (const r of results) {
      if (!r.passed) {
        lines.push(`>>> FAILED: ${r.name}`);
        lines.push(`    Command: ${r.command}`);
        lines.push(`    Exit Code: ${r.exitCode}`);
        const output = (r.stderr || r.stdout || "").trim();
        if (output) {
          lines.push("    Error Output:");
          for (const line of output.split("\n").slice(-25)) {
            lines.push(`      ${line}`);
          }
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

export function formatGitHubStepSummary(results) {
  const lines = [];
  const allPassed = results.every((r) => r.passed);

  lines.push("## 🤖 GitHub Agent PR Validation Summary");
  lines.push("");
  lines.push(`**Overall Status**: ${allPassed ? "✅ All checks passed" : "❌ Some checks failed"}`);
  lines.push("");
  lines.push("| Status | Check Name | Command | Duration | Exit Code |");
  lines.push("| :---: | :--- | :--- | :---: | :---: |");

  for (const r of results) {
    const icon = r.passed ? "✅ PASS" : "❌ FAIL";
    const dur = (r.durationMs / 1000).toFixed(2) + "s";
    lines.push(`| ${icon} | **${r.name}** | \`${r.command}\` | ${dur} | ${r.exitCode} |`);
  }

  lines.push("");

  if (!allPassed) {
    lines.push("### ❌ Error Details");
    lines.push("");
    for (const r of results) {
      if (!r.passed) {
        lines.push(`<details open>`);
        lines.push(`<summary><b>${r.name} (exit code ${r.exitCode})</b></summary>`);
        lines.push("");
        lines.push("```");
        const output = (r.stderr || r.stdout || "").trim();
        lines.push(output || "(no output captured)");
        lines.push("```");
        lines.push("</details>");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

export function runAll(checks = CHECKS, options = {}) {
  const results = [];
  console.log(`Running GitHub Agent PR Validation (${checks.length} checks)...`);

  for (let i = 0; i < checks.length; i++) {
    const check = checks[i];
    process.stdout.write(`  [${i + 1}/${checks.length}] Running ${check.name}... `);
    const result = runCheck(check, options);
    results.push(result);
    console.log(result.passed ? "✓ PASS" : "✗ FAIL");
  }

  const terminalSummary = formatTerminalSummary(results);
  console.log(terminalSummary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMarkdown = formatGitHubStepSummary(results);
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown + "\n");
    } catch (err) {
      console.error("Warning: Failed to write to GITHUB_STEP_SUMMARY:", err.message);
    }
  }

  const allPassed = results.every((r) => r.passed);
  return { allPassed, results };
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const { allPassed } = runAll();
  process.exit(allPassed ? 0 : 1);
}
