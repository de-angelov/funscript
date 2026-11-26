import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { loadProjectConfig } from "../compiler/project-config.js";
import { isModuleNotFoundError, toErrorMessage } from "../errors.js";
import { findFunFiles } from "./io.js";

export const doctorCommand = (args: string[]) =>
  Effect.gen(function* () {
    type Check = {
      name: string;
      status: "pass" | "warning" | "fail";
      message: string;
    };
    const checks: Check[] = [];
    const add = (name: string, status: Check["status"], message: string) =>
      checks.push({ name, status, message });

    const major = Number(process.versions.node.split(".")[0]);
    add(
      "Node.js",
      major >= 20 ? "pass" : "fail",
      major >= 20
        ? `Node ${process.versions.node}`
        : `Node ${process.versions.node}; version 20 or newer is required`,
    );

    if (process.versions.bun) {
      add("Bun runtime", "pass", `Bun ${process.versions.bun}`);
    } else if (existsSync(path.resolve("bunfig.toml"))) {
      add("Bun config", "pass", "Found bunfig.toml");
    }

    let packageJson: Record<string, unknown> | undefined;
    const packageText = yield* Effect.promise(() =>
      fs.readFile("package.json", "utf8").catch(() => undefined),
    );
    try {
      if (packageText === undefined) throw new Error("file not found");
      packageJson = JSON.parse(packageText);
      add("package.json", "pass", "Found and parsed package.json");
    } catch (error: unknown) {
      add(
        "package.json",
        "fail",
        `Cannot read package.json: ${toErrorMessage(error)}`,
      );
    }
    if (packageJson) {
      add(
        "ES modules",
        packageJson.type === "module" ? "pass" : "fail",
        packageJson.type === "module"
          ? 'package.json sets "type": "module"'
          : 'Set "type": "module" in package.json',
      );
      const require = createRequire(path.resolve("package.json"));
      for (const dependency of ["effect", "typescript"]) {
        try {
          const resolved = require.resolve(dependency);
          add(dependency, "pass", `Resolved ${resolved}`);
        } catch (error) {
          if (!isModuleNotFoundError(error)) throw error;
          add(dependency, "fail", `Install ${dependency} in this project`);
        }
      }
    }

    try {
      loadProjectConfig(process.cwd());
      add(
        "FunScript config",
        "pass",
        existsSync(path.resolve("funscript.config.fun"))
          ? "funscript.config.fun is valid"
          : "No funscript.config.fun; defaults are active",
      );
    } catch (error: unknown) {
      add("FunScript config", "fail", toErrorMessage(error));
    }

    const hasSrc = yield* Effect.tryPromise({
      try: async () => (await fs.stat("src")).isDirectory(),
      catch: () => false,
    });
    const sourceRoot = hasSrc ? "src" : ".";
    const files: string[] = yield* Effect.tryPromise({
      try: () => findFunFiles(sourceRoot),
      catch: (error: unknown) =>
        new Error(`Failed to scan '${sourceRoot}': ${toErrorMessage(error)}`),
    });
    add(
      "FunScript sources",
      files.length ? "pass" : "warning",
      files.length
        ? `Found ${files.length} .fun/.funx file(s) under ${sourceRoot}`
        : `No .fun or .funx files found under ${sourceRoot}`,
    );

    const stems = new Map<string, Set<string>>();
    for (const file of files) {
      const stem = path.resolve(file).replace(/\.funx?$/, "");
      const extensions = stems.get(stem) ?? new Set<string>();
      extensions.add(path.extname(file));
      stems.set(stem, extensions);
    }
    const duplicates = [...stems]
      .filter(
        ([, extensions]) => extensions.has(".fun") && extensions.has(".funx"),
      )
      .map(([stem]) => stem);
    add(
      "Duplicate module stems",
      duplicates.length ? "fail" : "pass",
      duplicates.length
        ? `Both .fun and .funx exist for: ${duplicates.join(", ")}`
        : "No .fun/.funx stem collisions found",
    );

    const manifestPath = path.resolve(
      ".funscript/types/.funscript-type-view.json",
    );
    const manifestText = yield* Effect.promise(() =>
      fs.readFile(manifestPath, "utf8").catch(() => undefined),
    );
    try {
      if (manifestText === undefined)
        throw Object.assign(new Error("file not found"), { code: "ENOENT" });
      const manifest: unknown = JSON.parse(manifestText);
      const sourcePaths = Array.isArray(manifest)
        ? manifest
        : manifest && typeof manifest === "object"
          ? Object.keys(manifest)
          : [];
      const stale = sourcePaths.filter(
        (source): source is string =>
          typeof source === "string" &&
          /\.funx?$/.test(source) &&
          !existsSync(path.resolve(source)),
      );
      add(
        "Generated type view",
        stale.length ? "warning" : "pass",
        stale.length
          ? `Stale entries in ${manifestPath}: ${stale.join(", ")}`
          : "Generated type view manifest is current",
      );
    } catch (error: unknown) {
      const errCode = (error as { code?: string })?.code;
      add(
        "Generated type view",
        errCode === "ENOENT" ? "pass" : "warning",
        errCode === "ENOENT"
          ? "No generated type view"
          : `Cannot read type view manifest: ${toErrorMessage(error)}`,
      );
    }

    const healthy = checks.every((check) => check.status !== "fail");
    if (!healthy) process.exitCode = 1;
    if (args.includes("--json")) {
      yield* Console.log(JSON.stringify({ healthy, checks }));
    } else {
      for (const check of checks)
        yield* Console.log(
          `${check.status.toUpperCase()}: ${check.name} — ${check.message}`,
        );
      yield* Console.log(`Overall: ${healthy ? "HEALTHY" : "UNHEALTHY"}`);
    }
  });
