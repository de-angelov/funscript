import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { uniq } from "es-toolkit";
import { compileString } from "../compiler.js";
import { toErrorMessage } from "../errors.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { buildBunExecutable } from "./build-bun.js";
import { watchBuild } from "./build-watch.js";
import { checkNoTsPaths, findFunFiles, readFile, writeFile } from "./io.js";
import { checkCliFiles, collectCliFiles } from "./typecheck.js";

let projectPolicy: FunScriptProjectConfig = {};
const checkNoTsPathsProxy = (
  targets: string[],
  effectOnly = false,
  ownedOutputs?: ReadonlyMap<string, string>,
  quiet = false,
) => checkNoTsPaths(targets, effectOnly, ownedOutputs, quiet, projectPolicy);

export const buildCommand = (
  args: string[],
  initialProjectPolicy: FunScriptProjectConfig = {},
) =>
  Effect.gen(function* () {
    projectPolicy = initialProjectPolicy;
    const isSourcemap = args.includes("--sourcemap");
    const isBin = args.includes("--bin");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const outDirIndex = args.indexOf("--outDir");
    const outDir = outDirIndex !== -1 ? args[outDirIndex + 1] : undefined;
    const targetIndex = args.indexOf("--target");
    const target = targetIndex !== -1 ? args[targetIndex + 1] : undefined;
    const engineIndex = args.indexOf("--engine");
    const engine =
      engineIndex !== -1
        ? (args[engineIndex + 1] as "auto" | "bun" | "esbuild")
        : undefined;
    const isFast = args.includes("--fast");
    if (target !== undefined && target !== "bun") {
      process.exitCode = 1;
      return yield* Console.error(
        `Unsupported build target '${target}'; supported target: bun.`,
      );
    }
    const bunTarget = target === "bun";
    // `build` defaults to a project output directory. `--out` remains the
    // explicit single-file escape hatch for callers that need another layout.
    const buildOutDir = outDir ?? (outPath ? undefined : "dist");

    const rawFileArgs = args.filter((arg, i) => {
      if (
        arg === "--sourcemap" ||
        arg === "--no-check" ||
        arg === "--no-ts" ||
        arg === "--no-global-this" ||
        arg === "--no-optional" ||
        arg === "--bare-pipelines" ||
        arg === "--bin" ||
        arg === "--watch" ||
        arg === "--fast" ||
        arg === "--modular-effect" ||
        arg === "--effect-subpaths"
      )
        return false;
      if (arg === "--out" || (outIndex !== -1 && i === outIndex + 1))
        return false;
      if (arg === "--outDir" || (outDirIndex !== -1 && i === outDirIndex + 1))
        return false;
      if (arg === "--target" || (targetIndex !== -1 && i === targetIndex + 1))
        return false;
      if (arg === "--engine" || (engineIndex !== -1 && i === engineIndex + 1))
        return false;
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
        if (
          (args.includes("--no-ts") ||
            projectPolicy.noTs === true ||
            projectPolicy.effectOnly?.length ||
            Array.isArray(projectPolicy.noTs)) &&
          !(yield* checkNoTsPathsProxy(
            [searchDir],
            !(args.includes("--no-ts") || projectPolicy.noTs === true),
          ))
        )
          return;
        filesToBuild = yield* Effect.tryPromise({
          try: () => findFunFiles(searchDir),
          catch: (error: unknown) =>
            new Error(
              `Failed to scan files in '${searchDir}': ${toErrorMessage(error)}`,
            ),
        });
      } else {
        if (
          (args.includes("--no-ts") ||
            projectPolicy.noTs === true ||
            projectPolicy.effectOnly?.length ||
            Array.isArray(projectPolicy.noTs)) &&
          !(yield* checkNoTsPathsProxy(
            rawFileArgs,
            !(args.includes("--no-ts") || projectPolicy.noTs === true),
          ))
        )
          return;
        for (const target of rawFileArgs) {
          const absoluteTarget = path.resolve(target);
          const stat = yield* Effect.tryPromise({
            try: () => fs.stat(target),
            catch: (error: unknown) =>
              new Error(
                `File or directory '${target}' not found: ${toErrorMessage(error)}`,
              ),
          });
          if (stat.isDirectory()) {
            sourceRoots.push(absoluteTarget);
            const nested = yield* Effect.tryPromise({
              try: () => findFunFiles(target),
              catch: (error: unknown) =>
                new Error(
                  `Failed to scan files in '${target}': ${toErrorMessage(error)}`,
                ),
            });
            filesToBuild.push(...nested);
          } else {
            const parts = absoluteTarget.split(path.sep);
            const srcIndex = parts.lastIndexOf("src");
            sourceRoots.push(
              srcIndex > 0
                ? parts.slice(0, srcIndex + 1).join(path.sep)
                : path.dirname(absoluteTarget),
            );
            filesToBuild.push(target);
          }
        }
      }
    }

    if (args.includes("--watch")) {
      if (bunTarget) {
        process.exitCode = 1;
        return yield* Console.error(
          "Watch mode does not support --target bun.",
        );
      }
      if (isSourcemap || isBin || args.includes("--no-check")) {
        process.exitCode = 1;
        return yield* Console.error(
          "Watch mode does not yet support --sourcemap, --bin, or --no-check.",
        );
      }
      const controller = new AbortController();
      const ownedOutputs = new Map<string, string>();
      let auditFailed = false;
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        yield* Effect.tryPromise({
          try: () =>
            watchBuild(
              {
                targets: rawFileArgs,
                out: outPath,
                outDir: outDir ?? (outPath ? undefined : "dist"),
                flags: {
                  noTs: args.includes("--no-ts"),
                  noGlobalThis: args.includes("--no-global-this"),
                  noOptional: args.includes("--no-optional"),
                  barePipelines: args.includes("--bare-pipelines"),
                  noDeepDestructure: args.includes("--no-deep-destructure"),
                },
                onOutput: (file, content) => ownedOutputs.set(file, content),
                audit: async (targets, policy) => {
                  projectPolicy = policy;
                  const active = targets.filter((target) => existsSync(target));
                  if (
                    !active.length ||
                    (!args.includes("--no-ts") &&
                      policy.noTs !== true &&
                      !policy.effectOnly?.length &&
                      !Array.isArray(policy.noTs))
                  )
                    return true;
                  const valid = await Effect.runPromise(
                    checkNoTsPathsProxy(
                      active,
                      !(args.includes("--no-ts") || policy.noTs === true),
                      ownedOutputs,
                      auditFailed,
                    ),
                  );
                  auditFailed = !valid;
                  return valid;
                },
              },
              controller.signal,
            ),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      return;
    }

    if (filesToBuild.length === 0) {
      return yield* Console.log("No .fun or .funx files found to build");
    }

    if (bunTarget) {
      const entryFiles = uniq(filesToBuild.map((file) => path.resolve(file)));
      if (entryFiles.length !== 1) {
        process.exitCode = 1;
        return yield* Console.error(
          "--target bun requires exactly one entry file; pass its path explicitly.",
        );
      }
      const entryFile = entryFiles[0];
      const entryRoot = sourceRoots[0] ?? path.dirname(entryFile);
      const relativeEntry = path
        .relative(entryRoot, entryFile)
        .replace(/\.funx?$/, ".js");
      const targetOut =
        outPath ??
        path.join(
          buildOutDir ?? "dist",
          relativeEntry ||
            `${path.basename(entryFile).replace(/\.funx?$/, "")}.js`,
        );
      if (
        !args.includes("--no-check") &&
        !(yield* checkCliFiles([entryFile], {
          noTs: args.includes("--no-ts"),
          noGlobalThis: args.includes("--no-global-this"),
          noOptional: args.includes("--no-optional"),
          barePipelines: args.includes("--bare-pipelines"),
          noDeepDestructure:
            args.includes("--no-deep-destructure") ||
            projectPolicy.noDeepDestructure === true,
          maxDestructureDepth: projectPolicy.maxDestructureDepth,
          effectOnly: projectPolicy.effectOnly,
          noTsPaths: Array.isArray(projectPolicy.noTs)
            ? projectPolicy.noTs
            : undefined,
          noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis)
            ? projectPolicy.noGlobalThis
            : undefined,
          noOptionalPaths: Array.isArray(projectPolicy.noOptional)
            ? projectPolicy.noOptional
            : undefined,
          barePipelinesPaths: Array.isArray(projectPolicy.barePipelines)
            ? projectPolicy.barePipelines
            : undefined,
          noDeepDestructurePaths: Array.isArray(projectPolicy.noDeepDestructure)
            ? projectPolicy.noDeepDestructure
            : undefined,
        }))
      )
        return;
      yield* Effect.tryPromise({
        try: () =>
          buildBunExecutable(entryFile, targetOut, {
            sourcemap: isSourcemap,
            noTs: args.includes("--no-ts"),
            noGlobalThis: args.includes("--no-global-this"),
            noOptional: args.includes("--no-optional"),
            barePipelines: args.includes("--bare-pipelines"),
            engine: isFast ? "bun" : engine,
          }),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
      yield* Console.log(`✓ Built executable ${targetOut}`);
      return;
    }

    const entryFiles = uniq(filesToBuild.map((file) => path.resolve(file)));
    filesToBuild = uniq(yield* collectCliFiles(entryFiles));
    if (outPath && filesToBuild.length > 1) {
      process.exitCode = 1;
      return yield* Console.error(
        "--out requires a single file with no local FunScript imports; use --outDir to build a module graph.",
      );
    }

    // Resolve every destination before compiling or writing, so a collision never
    // leaves a partially overwritten build. With --outDir, preserve paths relative
    // to the common input root (for example src/a/main.fun -> dist/a/main.ts).
    const rootsForLayout = [
      ...sourceRoots,
      ...filesToBuild.map((file) => path.dirname(path.resolve(file))),
    ];
    const commonSourceRoot = rootsForLayout.length
      ? rootsForLayout
          .map((root) => root.split(path.sep))
          .reduce((common, parts) => {
            let length = 0;
            while (
              length < common.length &&
              length < parts.length &&
              common[length] === parts[length]
            )
              length++;
            return common.slice(0, length);
          })
          .join(path.sep) || path.parse(sourceRoots[0]).root
      : process.cwd();
    const destinations = new Map<string, string[]>();
    for (const filePath of filesToBuild) {
      const ext = filePath.endsWith(".funx") ? ".tsx" : ".ts";
      const baseName = path.basename(filePath, path.extname(filePath)) + ext;
      const target =
        outPath && filesToBuild.length === 1
          ? outPath
          : buildOutDir
            ? path.join(
                buildOutDir,
                path
                  .relative(commonSourceRoot, path.resolve(filePath))
                  .replace(/\.funx?$/, ext),
              )
            : path.join(path.dirname(filePath), baseName);
      const key = path.resolve(target);
      destinations.set(key, [...(destinations.get(key) ?? []), filePath]);
    }
    const collisions = [...destinations].filter(
      ([, inputs]) => inputs.length > 1,
    );
    if (collisions.length) {
      process.exitCode = 1;
      for (const [destination, inputs] of collisions) {
        yield* Console.error(
          `Build output collision at '${destination}': ${inputs.join(", ")}`,
        );
      }
      return;
    }

    if (
      !args.includes("--no-check") &&
      !(yield* checkCliFiles(filesToBuild, {
        noTs: args.includes("--no-ts"),
        noGlobalThis: args.includes("--no-global-this"),
        noOptional: args.includes("--no-optional"),
        barePipelines: args.includes("--bare-pipelines"),
        noDeepDestructure:
          args.includes("--no-deep-destructure") ||
          projectPolicy.noDeepDestructure === true,
        maxDestructureDepth: projectPolicy.maxDestructureDepth,
        effectOnly: projectPolicy.effectOnly,
        noTsPaths: Array.isArray(projectPolicy.noTs)
          ? projectPolicy.noTs
          : undefined,
        noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis)
          ? projectPolicy.noGlobalThis
          : undefined,
        noOptionalPaths: Array.isArray(projectPolicy.noOptional)
          ? projectPolicy.noOptional
          : undefined,
        barePipelinesPaths: Array.isArray(projectPolicy.barePipelines)
          ? projectPolicy.barePipelines
          : undefined,
        noDeepDestructurePaths: Array.isArray(projectPolicy.noDeepDestructure)
          ? projectPolicy.noDeepDestructure
          : undefined,
      }))
    )
      return;

    for (const filePath of filesToBuild) {
      const source = yield* readFile(filePath);

      let targetOut: string;
      if (outPath && filesToBuild.length === 1) {
        targetOut = outPath;
      } else {
        const ext = filePath.endsWith(".funx") ? ".tsx" : ".ts";
        const baseName = path.basename(filePath, path.extname(filePath)) + ext;
        if (buildOutDir) {
          targetOut = path.join(
            buildOutDir,
            path
              .relative(commonSourceRoot, path.resolve(filePath))
              .replace(/\.funx?$/, ext),
          );
        } else {
          targetOut = path.join(path.dirname(filePath), baseName);
        }
      }

      const result = yield* compileString(source, filePath, {
        sourcemap: isSourcemap,
        noTs:
          args.includes("--no-ts") ||
          isPathPolicyEnabled(projectPolicy.noTs, process.cwd(), filePath),
        noGlobalThis:
          args.includes("--no-global-this") ||
          isPathPolicyEnabled(
            projectPolicy.noGlobalThis,
            process.cwd(),
            filePath,
          ),
        noOptional:
          args.includes("--no-optional") ||
          isPathPolicyEnabled(
            projectPolicy.noOptional,
            process.cwd(),
            filePath,
          ),
        barePipelines:
          args.includes("--bare-pipelines") ||
          isPathPolicyEnabled(
            projectPolicy.barePipelines,
            process.cwd(),
            filePath,
          ),
        noDeepDestructure:
          args.includes("--no-deep-destructure") ||
          isPathPolicyEnabled(
            projectPolicy.noDeepDestructure,
            process.cwd(),
            filePath,
          ),
        maxDestructureDepth: projectPolicy.maxDestructureDepth,
        allowHoles:
          args.includes("--allow-holes") ||
          isPathPolicyEnabled(
            projectPolicy.allowHoles,
            process.cwd(),
            filePath,
          ),
        effectOnly: isEffectOnlyFile(projectPolicy, process.cwd(), filePath),
        effectOnlyDirectories: projectPolicy.effectOnly,
        modularEffectImports:
          args.includes("--modular-effect") ||
          args.includes("--effect-subpaths") ||
          projectPolicy.modularEffectImports,
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
          catch: (error: unknown) =>
            new Error(
              `Failed to set executable permissions on '${targetOut}': ${toErrorMessage(error)}`,
            ),
        });
      }
      yield* Console.log(`✓ Built ${targetOut}`);
    }
  });
