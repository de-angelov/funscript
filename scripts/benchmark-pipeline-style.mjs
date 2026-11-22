#!/usr/bin/env node
// Run after `npm run build`: node scripts/benchmark-pipeline-style.mjs path/to/file.fun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { convertPipelineStyle } from "../dist/tooling/pipeline-style.js";

const file = process.argv[2];
const style = process.argv[3] ?? "bare";
if (!file || !["bare", "qualified"].includes(style)) {
  console.error("Usage: node scripts/benchmark-pipeline-style.mjs <file.fun> [bare|qualified]");
  process.exitCode = 1;
} else {
  const filename = resolve(file);
  const source = readFileSync(filename, "utf8");
  const start = performance.now();
  const result = convertPipelineStyle(source, filename, style);
  console.log(JSON.stringify({
    file: filename, style, elapsedMs: Math.round(performance.now() - start),
    changed: result.changed, skipped: result.skipped,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    node: process.version, platform: process.platform, arch: process.arch,
  }, null, 2));
}
