#!/usr/bin/env node

import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fork } from "node:child_process";
import { compileString, checkString } from "../compiler.js";
import { typeCheckFiles } from "../compiler/check.js";
import { loadProjectConfig, loadFormatConfigForFile, isEffectOnlyFile, isPathPolicyEnabled, type FunScriptProjectConfig } from "../compiler/project-config.js";

let projectPolicy: FunScriptProjectConfig = {};
import { checkCliFiles, collectCliFiles } from "./typecheck.js";
import { runTsc } from "./tsc.js";
import { startLspServer } from "../lsp/index.js";
import { format } from "../formatter/index.js";
import { convertPipelineStyle } from "../tooling/pipeline-style.js";
import { watchBuild } from "./build-watch.js";
import { startRepl } from "./repl.js";
import { renderCliHelp, validateCliArgs } from "./commands.js";
import { auditIdiomaticFunScript } from "../tooling/idiomatic.js";
import { FUNSCRIPT_VERSION } from "../version.js";
import { buildBunExecutable, buildRunBundle } from "./build-bun.js";

const readFile = (filePath: string) =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf-8"),
    catch: (error: any) => new Error(`Failed to read file '${filePath}': ${error.message}`),
  });

const writeFile = (filePath: string, content: string) =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    },
    catch: (error: any) => new Error(`Failed to write file '${filePath}': ${error.message}`),
  });

const findFunFiles = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFunFiles(fullPath)));
    } else if (entry.isFile() && (entry.name.endsWith(".fun") || entry.name.endsWith(".funx"))) {
      files.push(fullPath);
    }
  }
  return files;
};

const readStdin = () => new Promise<string>((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.once("end", () => resolve(input));
  process.stdin.once("error", reject);
  process.stdin.resume();
});

/** Audit source paths for standalone JS/TS, including declarations and symlinks. */
const findNonFunScriptSources = async (targets: string[]): Promise<string[]> => {
  const found = new Set<string>();
  const visitedDirectories = new Set<string>();
  const visit = async (target: string): Promise<void> => {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const real = await fs.realpath(target);
      if (visitedDirectories.has(real)) return;
      visitedDirectories.add(real);
      const entries = await fs.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        if (["node_modules", ".git", ".funscript"].includes(entry.name)) continue;
        await visit(path.join(target, entry.name));
      }
    } else if (stat.isFile()) {
      const real = await fs.realpath(target);
      if (/\.(?:[cm]?[jt]s|[jt]sx|as)$/i.test(target) || /\.(?:[cm]?[jt]s|[jt]sx|as)$/i.test(real)) found.add(target);
    }
  };
  for (const target of targets) await visit(target);
  return [...found].sort();
};

const checkNoTsPaths = (targets: string[], effectOnly = false, ownedOutputs?: ReadonlyMap<string, string>, quiet = false) =>
  Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: () => findNonFunScriptSources(targets),
      catch: (error: any) => new Error(`Cannot audit source paths: ${error.message}`),
    });
    const candidates = effectOnly ? files.filter(file => isEffectOnlyFile(projectPolicy, process.cwd(), file) || isPathPolicyEnabled(projectPolicy.noTs, process.cwd(), file)) : files;
    const rejected: string[] = [];
    for (const file of candidates) {
      const expected = ownedOutputs?.get(path.resolve(file));
      if (expected !== undefined && (yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))) === expected) continue;
      rejected.push(file);
    }
    if (rejected.length) {
      process.exitCode = 1;
      if (!quiet) for (const file of rejected) yield* Console.error(`${file}: error: JavaScript, TypeScript and AssemblyScript source files are disabled by ${effectOnly ? "project policy" : "--no-ts"}; write this code in FunScript`);
      return false;
    }
    return true;
  });

const buildCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isSourcemap = args.includes("--sourcemap");
    const isBin = args.includes("--bin");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const outDirIndex = args.indexOf("--outDir");
    const outDir = outDirIndex !== -1 ? args[outDirIndex + 1] : undefined;
    const targetIndex = args.indexOf("--target");
    const target = targetIndex !== -1 ? args[targetIndex + 1] : undefined;
    if (target !== undefined && target !== "bun") {
      process.exitCode = 1;
      return yield* Console.error(`Unsupported build target '${target}'; supported target: bun.`);
    }
    const bunTarget = target === "bun";

    const rawFileArgs = args.filter((arg, i) => {
      if (arg === "--sourcemap" || arg === "--no-check" || arg === "--no-ts" || arg === "--no-global-this" || arg === "--no-optional" || arg === "--bare-pipelines" || arg === "--bin" || arg === "--watch") return false;
      if (arg === "--out" || (outIndex !== -1 && i === outIndex + 1)) return false;
      if (arg === "--outDir" || (outDirIndex !== -1 && i === outDirIndex + 1)) return false;
      if (arg === "--target" || (targetIndex !== -1 && i === targetIndex + 1)) return false;
      return true;
    });

    let filesToBuild: string[] = [];
    let sourceRoots: string[] = [];

    if (!args.includes("--watch")) {
      if (rawFileArgs.length === 0) {
        const hasSrc = yield* Effect.tryPromise({
          try: async () => {
            const s = await fs.stat("src");
            return s.isDirectory();
          },
          catch: () => false,
        });
        const searchDir = hasSrc ? "src" : ".";
        sourceRoots = [path.resolve(searchDir)];
        if ((args.includes("--no-ts") || projectPolicy.noTs === true || projectPolicy.effectOnly?.length || Array.isArray(projectPolicy.noTs)) && !(yield* checkNoTsPaths([searchDir], !(args.includes("--no-ts") || projectPolicy.noTs === true)))) return;
        filesToBuild = yield* Effect.tryPromise({
          try: () => findFunFiles(searchDir),
          catch: (error: any) => new Error(`Failed to scan files in '${searchDir}': ${error.message}`),
        });
      } else {
        if ((args.includes("--no-ts") || projectPolicy.noTs === true || projectPolicy.effectOnly?.length || Array.isArray(projectPolicy.noTs)) && !(yield* checkNoTsPaths(rawFileArgs, !(args.includes("--no-ts") || projectPolicy.noTs === true)))) return;
        for (const target of rawFileArgs) {
          const absoluteTarget = path.resolve(target);
          const stat = yield* Effect.tryPromise({
            try: () => fs.stat(target),
            catch: (error: any) => new Error(`File or directory '${target}' not found: ${error.message}`),
          });
          if (stat.isDirectory()) {
            sourceRoots.push(absoluteTarget);
            const nested = yield* Effect.tryPromise({
              try: () => findFunFiles(target),
              catch: (error: any) => new Error(`Failed to scan files in '${target}': ${error.message}`),
            });
            filesToBuild.push(...nested);
          } else {
            const parts = absoluteTarget.split(path.sep);
            const srcIndex = parts.lastIndexOf("src");
            sourceRoots.push(srcIndex > 0 ? parts.slice(0, srcIndex + 1).join(path.sep) : path.dirname(absoluteTarget));
            filesToBuild.push(target);
          }
        }
      }
    }

    if (args.includes("--watch")) {
      if (bunTarget) {
        process.exitCode = 1;
        return yield* Console.error("Watch mode does not support --target bun.");
      }
      if (isSourcemap || isBin || args.includes("--no-check")) {
        process.exitCode = 1;
        return yield* Console.error("Watch mode does not yet support --sourcemap, --bin, or --no-check.");
      }
      const controller = new AbortController();
      const ownedOutputs = new Map<string, string>();
      let auditFailed = false;
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        yield* Effect.tryPromise({
          try: () => watchBuild({
            targets: rawFileArgs, out: outPath, outDir: outDir ?? (outPath ? undefined : "dist"),
            flags: { noTs: args.includes("--no-ts"), noGlobalThis: args.includes("--no-global-this"), noOptional: args.includes("--no-optional"), barePipelines: args.includes("--bare-pipelines") },
            onOutput: (file, content) => ownedOutputs.set(file, content),
            audit: async (targets, policy) => {
              projectPolicy = policy;
              const active = targets.filter(target => existsSync(target));
              if (!active.length || (!args.includes("--no-ts") && policy.noTs !== true && !policy.effectOnly?.length && !Array.isArray(policy.noTs))) return true;
              const valid = await Effect.runPromise(checkNoTsPaths(active, !(args.includes("--no-ts") || policy.noTs === true), ownedOutputs, auditFailed));
              auditFailed = !valid;
              return valid;
            },
          }, controller.signal),
          catch: error => error instanceof Error ? error : new Error(String(error)),
        });
      } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
      return;
    }

    if (filesToBuild.length === 0) {
      return yield* Console.log("No .fun or .funx files found to build");
    }

    if (bunTarget) {
      const entryFiles = [...new Set(filesToBuild.map(file => path.resolve(file)))];
      if (entryFiles.length !== 1) {
        process.exitCode = 1;
        return yield* Console.error("--target bun requires exactly one entry file; pass its path explicitly.");
      }
      const entryFile = entryFiles[0]!;
      const entryRoot = sourceRoots[0] ?? path.dirname(entryFile);
      const relativeEntry = path.relative(entryRoot, entryFile).replace(/\.funx?$/, ".js");
      const targetOut = outPath ?? path.join(outDir ?? "dist", relativeEntry || `${path.basename(entryFile).replace(/\.funx?$/, "")}.js`);
      if (!args.includes("--no-check") && !(yield* checkCliFiles([entryFile], { noTs: args.includes("--no-ts"), noGlobalThis: args.includes("--no-global-this"), noOptional: args.includes("--no-optional"), barePipelines: args.includes("--bare-pipelines"), effectOnly: projectPolicy.effectOnly, noTsPaths: Array.isArray(projectPolicy.noTs) ? projectPolicy.noTs : undefined, noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis) ? projectPolicy.noGlobalThis : undefined, noOptionalPaths: Array.isArray(projectPolicy.noOptional) ? projectPolicy.noOptional : undefined, barePipelinesPaths: Array.isArray(projectPolicy.barePipelines) ? projectPolicy.barePipelines : undefined }))) return;
      yield* Effect.tryPromise({
        try: () => buildBunExecutable(entryFile, targetOut, {
          sourcemap: isSourcemap,
          noTs: args.includes("--no-ts"),
          noGlobalThis: args.includes("--no-global-this"),
          noOptional: args.includes("--no-optional"),
          barePipelines: args.includes("--bare-pipelines"),
        }),
        catch: error => error instanceof Error ? error : new Error(String(error)),
      });
      yield* Console.log(`✓ Built executable ${targetOut}`);
      return;
    }

    const entryFiles = [...new Set(filesToBuild.map(file => path.resolve(file)))];
    filesToBuild = [...new Set(yield* collectCliFiles(entryFiles))];
    if (outPath && filesToBuild.length > 1) {
      process.exitCode = 1;
      return yield* Console.error("--out requires a single file with no local FunScript imports; use --outDir to build a module graph.");
    }

    // Resolve every destination before compiling or writing, so a collision never
    // leaves a partially overwritten build. With --outDir, preserve paths relative
    // to the common input root (for example src/a/main.fun -> dist/a/main.ts).
    const rootsForLayout = [...sourceRoots, ...filesToBuild.map(file => path.dirname(path.resolve(file)))];
    const commonSourceRoot = rootsForLayout.length
      ? rootsForLayout.map(root => root.split(path.sep)).reduce((common, parts) => {
          let length = 0;
          while (length < common.length && length < parts.length && common[length] === parts[length]) length++;
          return common.slice(0, length);
        }).join(path.sep) || path.parse(sourceRoots[0]!).root
      : process.cwd();
    const destinations = new Map<string, string[]>();
    for (const filePath of filesToBuild) {
      const ext = filePath.endsWith(".funx") ? ".tsx" : ".ts";
      const baseName = path.basename(filePath, path.extname(filePath)) + ext;
      const target = outPath && filesToBuild.length === 1
        ? outPath
        : outDir
          ? path.join(outDir, path.relative(commonSourceRoot, path.resolve(filePath)).replace(/\.funx?$/, ext))
          : path.join(path.dirname(filePath), baseName);
      const key = path.resolve(target);
      destinations.set(key, [...(destinations.get(key) ?? []), filePath]);
    }
    const collisions = [...destinations].filter(([, inputs]) => inputs.length > 1);
    if (collisions.length) {
      process.exitCode = 1;
      for (const [destination, inputs] of collisions) {
        yield* Console.error(`Build output collision at '${destination}': ${inputs.join(", ")}`);
      }
      return;
    }

    if (!args.includes("--no-check") && !(yield* checkCliFiles(filesToBuild, { noTs: args.includes("--no-ts"), noGlobalThis: args.includes("--no-global-this"), noOptional: args.includes("--no-optional"), barePipelines: args.includes("--bare-pipelines"), effectOnly: projectPolicy.effectOnly, noTsPaths: Array.isArray(projectPolicy.noTs) ? projectPolicy.noTs : undefined, noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis) ? projectPolicy.noGlobalThis : undefined, noOptionalPaths: Array.isArray(projectPolicy.noOptional) ? projectPolicy.noOptional : undefined, barePipelinesPaths: Array.isArray(projectPolicy.barePipelines) ? projectPolicy.barePipelines : undefined }))) return;

    for (const filePath of filesToBuild) {
      const source = yield* readFile(filePath);

      let targetOut: string;
      if (outPath && filesToBuild.length === 1) {
        targetOut = outPath;
      } else {
        const ext = filePath.endsWith(".funx") ? ".tsx" : ".ts";
        const baseName = path.basename(filePath, path.extname(filePath)) + ext;
        if (outDir) {
          targetOut = path.join(outDir, path.relative(commonSourceRoot, path.resolve(filePath)).replace(/\.funx?$/, ext));
        } else {
          targetOut = path.join(path.dirname(filePath), baseName);
        }
      }

      const result = yield* compileString(source, filePath, {
        sourcemap: isSourcemap,
        noTs: args.includes("--no-ts") || isPathPolicyEnabled(projectPolicy.noTs, process.cwd(), filePath),
        noGlobalThis: args.includes("--no-global-this") || isPathPolicyEnabled(projectPolicy.noGlobalThis, process.cwd(), filePath),
        noOptional: args.includes("--no-optional") || isPathPolicyEnabled(projectPolicy.noOptional, process.cwd(), filePath),
        barePipelines: args.includes("--bare-pipelines") || isPathPolicyEnabled(projectPolicy.barePipelines, process.cwd(), filePath),
        effectOnly: isEffectOnlyFile(projectPolicy, process.cwd(), filePath),
        effectOnlyDirectories: projectPolicy.effectOnly,
        policyRoot: process.cwd(),
        outputFile: path.basename(targetOut),
      });

      let tsCode = result.typescript;
      const isExecutable = isBin || source.startsWith("#!");
      if (isBin && !tsCode.startsWith("#!")) {
        tsCode = `#!/usr/bin/env bun\n${tsCode}`;
      }
      if (isSourcemap && result.map) {
        const mapFileName = `${path.basename(targetOut)}.map`;
        const mapPath = `${targetOut}.map`;
        tsCode += `\n//# sourceMappingURL=${mapFileName}\n`;
        yield* writeFile(mapPath, result.map.toString());
        yield* Console.log(`✓ Built ${mapPath}`);
      }

      yield* writeFile(targetOut, tsCode);
      if (isExecutable) {
        yield* Effect.tryPromise({
          try: () => fs.chmod(targetOut, 0o755),
          catch: (error: any) => new Error(`Failed to set executable permissions on '${targetOut}': ${error.message}`),
        });
      }
      yield* Console.log(`✓ Built ${targetOut}`);
    }
  });

const emitCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isSourcemap = args.includes("--sourcemap");
    const isBin = args.includes("--bin");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const fileArgs = args.filter((a, idx) => {
      if (a === "--sourcemap" || a === "--no-ts" || a === "--no-global-this" || a === "--no-optional" || a === "--bare-pipelines" || a === "--bin") return false;
      if (a === "--out" || (outIndex !== -1 && idx === outIndex + 1)) return false;
      return true;
    });

    const filePath = fileArgs[0];
    if (!filePath) {
      return yield* Console.error("Usage: funscript emit <file.fun|file.funx> [--out <file.ts|file.tsx>] [--sourcemap] [--no-ts] [--bin]");
    }

    if ((args.includes("--no-ts") || projectPolicy.noTs === true || projectPolicy.effectOnly?.length || Array.isArray(projectPolicy.noTs)) && !(yield* checkNoTsPaths([filePath], !(args.includes("--no-ts") || projectPolicy.noTs === true)))) return;
    const source = yield* readFile(filePath);
    const result = yield* compileString(source, filePath, {
      sourcemap: isSourcemap,
      noTs: args.includes("--no-ts") || isPathPolicyEnabled(projectPolicy.noTs, process.cwd(), filePath),
      noGlobalThis: args.includes("--no-global-this") || isPathPolicyEnabled(projectPolicy.noGlobalThis, process.cwd(), filePath),
      noOptional: args.includes("--no-optional") || isPathPolicyEnabled(projectPolicy.noOptional, process.cwd(), filePath),
      barePipelines: args.includes("--bare-pipelines") || isPathPolicyEnabled(projectPolicy.barePipelines, process.cwd(), filePath),
      effectOnly: isEffectOnlyFile(projectPolicy, process.cwd(), filePath),
      effectOnlyDirectories: projectPolicy.effectOnly,
      policyRoot: process.cwd(),
      outputFile: outPath ? path.basename(outPath) : undefined,
    });

    let tsCode = result.typescript;
    const isExecutable = isBin || source.startsWith("#!");
    if (isBin && !tsCode.startsWith("#!")) {
      tsCode = `#!/usr/bin/env bun\n${tsCode}`;
    }
    if (outPath) {
      if (isSourcemap && result.map) {
        const mapFileName = `${path.basename(outPath)}.map`;
        const mapPath = `${outPath}.map`;
        tsCode += `\n//# sourceMappingURL=${mapFileName}\n`;
        yield* writeFile(mapPath, result.map.toString());
        yield* Console.log(`✓ Emitted ${mapPath}`);
      }
      yield* writeFile(outPath, tsCode);
      if (isExecutable) {
        yield* Effect.tryPromise({
          try: () => fs.chmod(outPath, 0o755),
          catch: (error: any) => new Error(`Failed to set executable permissions on '${outPath}': ${error.message}`),
        });
      }
      yield* Console.log(`✓ Emitted ${outPath}`);
    } else {
      if (isSourcemap && result.map) {
        yield* Console.log(result.map.toString());
      } else {
        yield* Console.log(tsCode);
      }
    }
  });

const checkCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isIdiomatic = args.includes("--idiomatic");
    const jsonOutput = args.includes("--json");
    const warningsAsErrors = args.includes("--warnings-as-errors");
    const rawFileArgs = args.filter((arg) => !arg.startsWith("--"));

    let filesToCheck: string[] = [];
    if (rawFileArgs.length === 0) {
      const hasSrc = yield* Effect.tryPromise({
        try: async () => {
          const s = await fs.stat("src");
          return s.isDirectory();
        },
        catch: () => false,
      });
      const searchDir = hasSrc ? "src" : ".";
      if ((args.includes("--no-ts") || projectPolicy.noTs === true || projectPolicy.effectOnly?.length || Array.isArray(projectPolicy.noTs)) && !(yield* checkNoTsPaths([searchDir], !(args.includes("--no-ts") || projectPolicy.noTs === true)))) return;
      filesToCheck = yield* Effect.tryPromise({
        try: () => findFunFiles(searchDir),
        catch: (error: any) => new Error(`Failed to scan files in '${searchDir}': ${error.message}`),
      });
      if (filesToCheck.length === 0) {
        return yield* Console.error("Usage: funscript check [file.fun|file.funx...] [--idiomatic] [--no-ts]");
      }
    } else {
      if ((args.includes("--no-ts") || projectPolicy.noTs === true || projectPolicy.effectOnly?.length || Array.isArray(projectPolicy.noTs)) && !(yield* checkNoTsPaths(rawFileArgs, !(args.includes("--no-ts") || projectPolicy.noTs === true)))) return;
      for (const target of rawFileArgs) {
        const stat = yield* Effect.tryPromise({
          try: () => fs.stat(target),
          catch: (error: any) => new Error(`File or directory '${target}' not found: ${error.message}`),
        });
        if (stat.isDirectory()) {
          const nested = yield* Effect.tryPromise({
            try: () => findFunFiles(target),
            catch: (error: any) => new Error(`Failed to scan files in '${target}': ${error.message}`),
          });
          filesToCheck.push(...nested);
        } else {
          filesToCheck.push(target);
        }
      }
    }

    let idiomaticPassed = true;
    const idiomaticDiagnostics: Array<{ file: string; line: number; column: number; message: string }> = [];
    if (isIdiomatic) {
      for (const target of filesToCheck) {
        const source = yield* Effect.tryPromise({
          try: () => fs.readFile(target, "utf-8"),
          catch: () => "",
        });
        const audit = auditIdiomaticFunScript(source, target);
        if (!audit.success) {
          idiomaticPassed = false;
          for (const d of audit.diagnostics) {
            idiomaticDiagnostics.push({ file: d.file, line: d.line, column: d.column, message: d.message });
            if (!jsonOutput) yield* Console.error(`${d.file}:${d.line}:${d.column} - error: ${d.message}`);
          }
        }
      }
    }

    const allFiles = yield* collectCliFiles(filesToCheck);
    const result = yield* typeCheckFiles(allFiles, { noTs: args.includes("--no-ts"), noGlobalThis: args.includes("--no-global-this"), noOptional: args.includes("--no-optional"), barePipelines: args.includes("--bare-pipelines"), effectOnly: projectPolicy.effectOnly, noTsPaths: Array.isArray(projectPolicy.noTs) ? projectPolicy.noTs : undefined, noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis) ? projectPolicy.noGlobalThis : undefined, noOptionalPaths: Array.isArray(projectPolicy.noOptional) ? projectPolicy.noOptional : undefined, barePipelinesPaths: Array.isArray(projectPolicy.barePipelines) ? projectPolicy.barePipelines : undefined });
    const success = result.success && idiomaticPassed && !(warningsAsErrors && result.warningCount > 0);
    if (warningsAsErrors && result.warningCount > 0) process.exitCode = 1;
    if (jsonOutput) {
      const diagnostics = result.diagnostics.map(diagnostic => ({
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
        endLine: diagnostic.endLine,
        endColumn: diagnostic.endColumn,
        severity: diagnostic.category,
        code: diagnostic.diagnosticCode ?? diagnostic.code,
        message: diagnostic.message,
        explanation: diagnostic.explanation,
        help: diagnostic.suggestedAction,
      })).concat(idiomaticDiagnostics.map(diagnostic => ({
        ...diagnostic,
        severity: "error",
        code: "FS_IDIOMATIC",
        explanation: undefined,
        help: undefined,
        endLine: undefined,
        endColumn: undefined,
      })));
      yield* Console.log(JSON.stringify({ success, errorCount: result.errorCount, warningCount: result.warningCount, diagnostics }));
    } else if (!success) {
      process.exitCode = 1;
      if (!result.success || (warningsAsErrors && result.warningCount > 0)) {
        yield* Console.error(result.formattedOutput);
      }
    } else {
      if (filesToCheck.length === 1) {
        yield* Console.log(`✓ ${filesToCheck[0]} checked successfully (${result.errorCount} errors, ${result.warningCount} warnings)`);
      } else {
        yield* Console.log(`✓ Checked ${filesToCheck.length} files successfully (${result.errorCount} errors, ${result.warningCount} warnings)`);
      }
    }
  });

const fmtCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isCheck = args.includes("--check");
    const isStdin = args.includes("--stdin");
    const stdinPathIndex = args.indexOf("--stdin-filepath");
    const stdinFilepath = stdinPathIndex >= 0 ? args[stdinPathIndex + 1] : undefined;
    const fileArgs = args.filter((arg, index) => arg !== "--check" && arg !== "--stdin" && arg !== "--stdin-filepath" && !(stdinPathIndex >= 0 && index === stdinPathIndex + 1));

    if (isStdin) {
      if (fileArgs.length || isCheck) {
        process.exitCode = 1;
        return yield* Console.error("Usage: funscript fmt --stdin [--stdin-filepath <path>]");
      }
      const source = yield* Effect.tryPromise({ try: readStdin, catch: error => error instanceof Error ? error : new Error(String(error)) });
      const filename = stdinFilepath ? path.resolve(stdinFilepath) : path.resolve("stdin.fun");
      try {
        const formatted = format(source, { ...loadFormatConfigForFile(filename), filename });
        process.stdout.write(formatted);
      } catch (error: any) {
        process.exitCode = 1;
        yield* Console.error(`Format error in '${filename}': ${error.message}`);
      }
      return;
    }

    if (fileArgs.length === 0) {
      process.exitCode = 1;
      return yield* Console.error("Usage: funscript fmt <file.fun|directory...> [--check] | funscript fmt --stdin [--stdin-filepath <path>]");
    }

    const files = new Set<string>();
    for (const target of fileArgs) {
      const stat = yield* Effect.tryPromise({ try: () => fs.stat(target), catch: (error: any) => new Error(`Cannot read '${target}': ${error.message}`) });
      if (stat.isDirectory()) {
        const nested = yield* Effect.tryPromise({ try: () => findFunFiles(target), catch: (error: any) => new Error(`Failed to scan '${target}': ${error.message}`) });
        for (const file of nested) files.add(file);
      } else {
        files.add(target);
      }
    }

    let hasDiff = false;
    for (const filePath of files) {
      const source = yield* readFile(filePath);
      let formatted: string;
      try {
        formatted = format(source, { ...loadFormatConfigForFile(path.resolve(filePath)), filename: filePath });
      } catch (err: any) {
        process.exitCode = 1;
        hasDiff = true;
        yield* Console.error(`Format error in '${filePath}': ${err.message}`);
        continue;
      }

      if (isCheck) {
        if (source !== formatted) {
          hasDiff = true;
          yield* Console.error(`✗ '${filePath}' is not formatted`);
        } else {
          yield* Console.log(`✓ '${filePath}' is clean`);
        }
      } else {
        if (source !== formatted) {
          yield* writeFile(filePath, formatted);
          yield* Console.log(`✓ Formatted '${filePath}'`);
        } else {
          yield* Console.log(`✓ '${filePath}' already formatted`);
        }
      }
    }

    if (isCheck && hasDiff) {
      process.exitCode = 1;
    }
  });

const pipelineStyleCommand = (args: string[]) => Effect.gen(function* () {
  const style = args[0];
  const targets = args.slice(1);
  if ((style !== "bare" && style !== "qualified") || !targets.length) {
    process.exitCode = 1;
    return yield* Console.error("Usage: funscript pipeline-style <bare|qualified> <file or directory...>");
  }
  for (const target of targets) {
    const stat = yield* Effect.tryPromise({ try: () => fs.stat(target), catch: (error: any) => new Error(error.message) });
    const files = stat.isDirectory() ? yield* Effect.tryPromise({ try: () => findFunFiles(target), catch: (error: any) => new Error(error.message) }) : [target];
    for (const file of files) {
      try {
        const source = yield* readFile(file);
        const result = convertPipelineStyle(source, path.resolve(file), style);
        if (result.changed) yield* writeFile(file, result.text);
        yield* Console.log(`${file}: ${result.changed} converted, ${result.skipped} skipped`);
      } catch (error: any) {
        process.exitCode = 1;
        yield* Console.error(`${file}: ${error.message}`);
      }
    }
  }
});

const runCommand = (args: string[]) =>
  Effect.gen(function* () {
    const separator = args.indexOf("--");
    const commandArgs = separator < 0 ? args : args.slice(0, separator);
    const programArgs = separator < 0 ? [] : args.slice(separator + 1);
    const filePath = commandArgs.find((arg) => arg !== "--no-check" && arg !== "--no-ts" && arg !== "--no-global-this" && arg !== "--no-optional" && arg !== "--bare-pipelines");
    if (!filePath) {
      process.exitCode = 1;
      return yield* Console.error("Usage: funscript run <file.fun|file.funx> [--no-check] [--no-ts]");
    }

    if ((commandArgs.includes("--no-ts") || projectPolicy.noTs === true || projectPolicy.effectOnly?.length || Array.isArray(projectPolicy.noTs)) && !(yield* checkNoTsPaths([filePath], !(commandArgs.includes("--no-ts") || projectPolicy.noTs === true)))) return;
    if (!commandArgs.includes("--no-check") && !(yield* checkCliFiles([filePath], { noTs: commandArgs.includes("--no-ts"), noGlobalThis: commandArgs.includes("--no-global-this"), noOptional: commandArgs.includes("--no-optional"), barePipelines: commandArgs.includes("--bare-pipelines"), effectOnly: projectPolicy.effectOnly, noTsPaths: Array.isArray(projectPolicy.noTs) ? projectPolicy.noTs : undefined, noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis) ? projectPolicy.noGlobalThis : undefined, noOptionalPaths: Array.isArray(projectPolicy.noOptional) ? projectPolicy.noOptional : undefined, barePipelinesPaths: Array.isArray(projectPolicy.barePipelines) ? projectPolicy.barePipelines : undefined }))) return;

    const cacheDir = path.resolve(".funscript-cache");
    const ext = path.extname(filePath);
    const targetFile = path.join(cacheDir, `${path.basename(filePath, ext)}.mjs`);
    yield* Effect.tryPromise({
      try: () => buildRunBundle(filePath, targetFile, {
        noTs: commandArgs.includes("--no-ts"),
        noGlobalThis: commandArgs.includes("--no-global-this"),
        noOptional: commandArgs.includes("--no-optional"),
        barePipelines: commandArgs.includes("--bare-pipelines"),
      }),
      catch: error => error instanceof Error ? error : new Error(String(error)),
    });

    yield* Effect.callback<void, Error>((resume) => {
      const child = fork(targetFile, programArgs, { stdio: "inherit" });
      child.on("exit", (code) => {
        if (code === 0) resume(Effect.void);
        else resume(Effect.fail(new Error(`Program exited with code ${code}`)));
      });
      child.on("error", (err) => resume(Effect.fail(err)));
    });
  });

const lspCommand = (_args: string[]) =>
  Effect.callback<void, Error>(() => {
    const server = startLspServer({ reader: process.stdin, writer: process.stdout });
    server.onExit((code) => setImmediate(() => process.exit(code)));
  });

const replCommand = (args: string[]) =>
  Effect.callback<void, Error>((resume) => {
    const server = startRepl();
    server.on("exit", () => {
      resume(Effect.void);
    });
  });

const helpCommand = Console.log(renderCliHelp(FUNSCRIPT_VERSION));

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const commandArgs = argv.slice(1);
  if (command === "help") {
    const helpTarget = commandArgs.find(arg => !arg.startsWith("-"));
    return yield* Console.log(renderCliHelp(FUNSCRIPT_VERSION, helpTarget));
  }
  if (command && commandArgs.some(arg => arg === "--help" || arg === "-h")) {
    return yield* Console.log(renderCliHelp(FUNSCRIPT_VERSION, command));
  }
  if (command && !["help", "-h", "--help", "--version", "-v"].includes(command)) {
    const validationError = validateCliArgs(command, commandArgs);
    if (validationError) {
      process.exitCode = 1;
      return yield* Console.error(validationError);
    }
  }
  if (command && ["check", "build", "emit", "run"].includes(command)) {
    projectPolicy = yield* Effect.try({ try: () => loadProjectConfig(process.cwd()), catch: (error) => error instanceof Error ? error : new Error(String(error)) });
    if (!(command === "build" && commandArgs.includes("--watch"))) {
      if (projectPolicy.noTs === true && !commandArgs.includes("--no-ts")) commandArgs.push("--no-ts");
      if (projectPolicy.noGlobalThis === true && !commandArgs.includes("--no-global-this")) commandArgs.push("--no-global-this");
      if (projectPolicy.noOptional === true && !commandArgs.includes("--no-optional")) commandArgs.push("--no-optional");
      if (projectPolicy.barePipelines === true && !commandArgs.includes("--bare-pipelines")) commandArgs.push("--bare-pipelines");
    }
  }

  switch (command) {
    case "build":
      return yield* buildCommand(commandArgs);
    case "run":
      return yield* runCommand(commandArgs);
    case "repl":
      return yield* replCommand(commandArgs);
    case "emit":
      return yield* emitCommand(commandArgs);
    case "check":
      return yield* checkCommand(commandArgs);
    case "tsc": {
      const code = yield* Effect.tryPromise({ try: () => runTsc(commandArgs), catch: (error) => error instanceof Error ? error : new Error(String(error)) });
      process.exitCode = code;
      return;
    }
    case "lsp":
      return yield* lspCommand(commandArgs);
    case "pipeline-style":
      return yield* pipelineStyleCommand(commandArgs);
    case "fmt":
      return yield* fmtCommand(commandArgs);
    case "version":
    case "-v":
    case "--version":
      return yield* Console.log(`funscript ${FUNSCRIPT_VERSION}`);
    case "help":
    case "-h":
    case "--help":
    default:
      return yield* helpCommand;
  }
}).pipe(
  Effect.catch((err: any) => {
    process.exitCode = 1;
    return Console.error(`\x1b[31merror\x1b[0m: ${err.message || err}`);
  })
);

// Execute Effect program
void Effect.runPromise(program);
