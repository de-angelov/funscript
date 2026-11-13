#!/usr/bin/env node
// Install the actual tarball in an isolated consumer and exercise its public surface.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "funscript-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, cwd = temp) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }))[0];
  const paths = packed.files.map((file) => file.path);
  for (const prefix of ["tests/", "slopboss/", ".github/", "scripts/"]) {
    if (paths.some((path) => path.startsWith(prefix))) throw new Error(`Unexpected package contents: ${prefix}`);
  }
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--engine-strict", join(temp, packed.filename)]);
  const imports = Object.keys(manifest.exports).map((key) => key === "." ? manifest.name : manifest.name + key.slice(1));
  run(process.execPath, ["--input-type=module", "-e", `for (const name of ${JSON.stringify(imports)}) await import(name);`]);
  run(process.execPath, [join(temp, "node_modules", manifest.name, "dist", "cli", "index.js"), "--help"]);
  console.log(`Package smoke test passed (${paths.length} files).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
