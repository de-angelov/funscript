import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fork, spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compileString } from "../compiler.js";
import { checkCliFiles } from "./typecheck.js";
import { buildRunBundle, isBunAvailable } from "./build-bun.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { findFunFiles, checkNoTsPaths, readFile, writeFile } from "./io.js";

let projectPolicy: FunScriptProjectConfig = {};
const checkNoTsPathsProxy = (
  targets: string[],
  effectOnly = false,
  ownedOutputs?: ReadonlyMap<string, string>,
  quiet = false,
) => checkNoTsPaths(targets, effectOnly, ownedOutputs, quiet, projectPolicy);

export const runCommand = (
  args: string[],
  initialProjectPolicy: FunScriptProjectConfig = {},
) =>
  Effect.gen(function* () {
    projectPolicy = initialProjectPolicy;
    const separator = args.indexOf("--");
    const commandArgs = separator < 0 ? args : args.slice(0, separator);
    const programArgs = separator < 0 ? [] : args.slice(separator + 1);
    const isFast = commandArgs.includes("--fast");
    const engineIndex = commandArgs.indexOf("--engine");
    const engine =
      engineIndex !== -1 ? commandArgs[engineIndex + 1] : undefined;
    const filePath = commandArgs.find(
      (arg) =>
        arg !== "--no-check" &&
        arg !== "--no-ts" &&
        arg !== "--no-global-this" &&
        arg !== "--no-optional" &&
        arg !== "--bare-pipelines" &&
        arg !== "--fast" &&
        arg !== "--engine" &&
        (engineIndex === -1 || arg !== engine),
    );
    if (!filePath) {
      process.exitCode = 1;
      return yield* Console.error(
        "Usage: funscript run <file.fun|file.funx> [--no-check] [--no-ts]",
      );
    }

    if (
      (commandArgs.includes("--no-ts") ||
        projectPolicy.noTs === true ||
        projectPolicy.effectOnly?.length ||
        Array.isArray(projectPolicy.noTs)) &&
      !(yield* checkNoTsPathsProxy(
        [filePath],
        !(commandArgs.includes("--no-ts") || projectPolicy.noTs === true),
      ))
    )
      return;
    if (
      !commandArgs.includes("--no-check") &&
      !(yield* checkCliFiles([filePath], {
        noTs: commandArgs.includes("--no-ts"),
        noGlobalThis: commandArgs.includes("--no-global-this"),
        noOptional: commandArgs.includes("--no-optional"),
        barePipelines: commandArgs.includes("--bare-pipelines"),
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
      }))
    )
      return;

    const isUnderBun =
      typeof Bun !== "undefined" ||
      (typeof process !== "undefined" && Boolean(process.versions?.bun));
    const useNativeBun =
      engine === "bun" || isFast || (engine !== "esbuild" && isUnderBun);

    // In-process native execution under Bun
    if (isUnderBun && useNativeBun) {
      yield* Effect.tryPromise({
        try: async () => {
          const { plugin } = await import("bun");
          const { funscriptBunPlugin } = await import("../plugins/bun.js");
          plugin(
            funscriptBunPlugin({
              noTs: commandArgs.includes("--no-ts"),
              noGlobalThis: commandArgs.includes("--no-global-this"),
              noOptional: commandArgs.includes("--no-optional"),
              barePipelines: commandArgs.includes("--bare-pipelines"),
            }) as any,
          );
          const fullPath = path.resolve(filePath);
          const originalArgv = process.argv;
          process.argv = [process.argv[0], fullPath, ...programArgs];
          try {
            const mod = await import(fullPath);
            if (mod && mod.main) {
              if (Effect.isEffect(mod.main)) {
                await Effect.runPromise(mod.main);
              } else if (typeof mod.main === "function") {
                await mod.main();
              }
            }
          } finally {
            process.argv = originalArgv;
          }
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    // Direct Bun runner when invoked from Node with --fast or --engine bun
    if (useNativeBun && isBunAvailable()) {
      yield* Effect.callback<void, Error>((resume) => {
        const currentDir =
          typeof __dirname !== "undefined"
            ? __dirname
            : path.dirname(fileURLToPath(import.meta.url));
        const bunPluginPath = path.resolve(currentDir, "../plugins/bun.js");
        const fullPath = path.resolve(filePath);
        const runnerScript = `
import { plugin } from "bun";
import { funscriptBunPlugin } from ${JSON.stringify(bunPluginPath)};
import { Effect } from "effect";

plugin(funscriptBunPlugin({
  noTs: ${Boolean(commandArgs.includes("--no-ts"))},
  noGlobalThis: ${Boolean(commandArgs.includes("--no-global-this"))},
  noOptional: ${Boolean(commandArgs.includes("--no-optional"))},
  barePipelines: ${Boolean(commandArgs.includes("--bare-pipelines"))},
}));

process.argv = [process.argv[0], ${JSON.stringify(fullPath)}, ...${JSON.stringify(programArgs)}];
const mod = await import(${JSON.stringify(fullPath)});
if (mod && mod.main) {
  if (Effect.isEffect(mod.main)) {
    await Effect.runPromise(mod.main);
  } else if (typeof mod.main === "function") {
    await mod.main();
  }
}
`;
        const child = spawn("bun", ["-e", runnerScript], { stdio: "inherit" });
        child.on("exit", (code: any) => {
          if (code === 0) resume(Effect.void);
          else {
            process.exitCode = code ?? 1;
            resume(Effect.void);
          }
        });
        child.on("error", (err: any) => resume(Effect.fail(err)));
      });
      return;
    }

    const cacheDir = path.resolve(".funscript-cache");
    const ext = path.extname(filePath);
    const targetFile = path.join(
      cacheDir,
      `${path.basename(filePath, ext)}.mjs`,
    );
    yield* Effect.tryPromise({
      try: () =>
        buildRunBundle(filePath, targetFile, {
          noTs: commandArgs.includes("--no-ts"),
          noGlobalThis: commandArgs.includes("--no-global-this"),
          noOptional: commandArgs.includes("--no-optional"),
          barePipelines: commandArgs.includes("--bare-pipelines"),
          engine: isFast ? "bun" : undefined,
        }),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
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
