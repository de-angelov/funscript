#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { auditIdiomaticFunScript } from "../dist/tooling/idiomatic.js";

export async function findFunScriptFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return findFunScriptFiles(full);
      }
      if (entry.isFile() && (full.endsWith(".fun") || full.endsWith(".funx"))) {
        return [full];
      }
      return [];
    }),
  );
  return files.flat();
}

export async function checkIdiomatic(targetFiles = [], options = {}) {
  const rootDir = options.cwd || process.cwd();
  let files = targetFiles.filter((arg) => !arg.startsWith("--"));

  if (files.length === 0) {
    const candidateDirs = ["examples", "programs"].map((d) => path.resolve(rootDir, d));
    const nested = await Promise.all(candidateDirs.map(findFunScriptFiles));
    files = nested.flat().sort();
  } else {
    files = files.map((f) => path.resolve(rootDir, f));
  }

  const results = [];
  let totalViolations = 0;

  for (const filePath of files) {
    const rel = path.relative(rootDir, filePath).replaceAll("\\", "/");
    let content;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      results.push({
        file: rel,
        success: false,
        diagnostics: [
          {
            file: rel,
            line: 1,
            column: 1,
            kind: "file-read-error",
            message: `Failed to read file: ${err.message}`,
          },
        ],
      });
      totalViolations++;
      continue;
    }

    const audit = auditIdiomaticFunScript(content, rel);
    if (!audit.success) {
      totalViolations += audit.diagnostics.length;
    }
    results.push(audit);
  }

  return {
    success: totalViolations === 0,
    totalFiles: files.length,
    totalViolations,
    results,
  };
}

export async function main() {
  const args = process.argv.slice(2);
  const { success, totalFiles, totalViolations, results } = await checkIdiomatic(args);

  if (success) {
    console.log(`✓ Idiomatic check passed: ${totalFiles} file(s) checked, 0 non-ambient 'ts { }' violations found.`);
    process.exit(0);
  } else {
    console.error(`✗ Idiomatic check failed: ${totalViolations} violation(s) found across ${totalFiles} file(s):\n`);
    for (const r of results) {
      if (!r.success) {
        for (const diag of r.diagnostics) {
          console.error(`  ${diag.file}:${diag.line}:${diag.column} - [${diag.kind}] ${diag.message}`);
          if (diag.snippet) {
            console.error(`    > ${diag.snippet}`);
          }
        }
      }
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
