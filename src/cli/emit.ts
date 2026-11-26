import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileString } from "../compiler.js";
import { toErrorMessage } from "../errors.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { checkNoTsPaths, readFile, writeFile } from "./io.js";

export const emitCommand = (
  args: string[],
  projectPolicy: FunScriptProjectConfig = {},
) =>
  Effect.gen(function* () {
    const isSourcemap = args.includes("--sourcemap");
    const isBin = args.includes("--bin");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const fileArgs = args.filter((a, idx) => {
      if (
        a === "--sourcemap" ||
        a === "--no-ts" ||
        a === "--no-global-this" ||
        a === "--bare-pipelines" ||
        a === "--no-deep-destructure" ||
        a === "--bin" ||
        a === "--modular-effect" ||
        a === "--effect-subpaths"
      )
        return false;
      if (a === "--out" || (outIndex !== -1 && idx === outIndex + 1))
        return false;
      return true;
    });

    const filePath = fileArgs[0];
    if (!filePath) {
      return yield* Console.error(
        "Usage: funscript emit <file.fun|file.funx> [--out <file.ts|file.tsx>] [--sourcemap] [--no-ts] [--bin]",
      );
    }

    if (
      (args.includes("--no-ts") ||
        projectPolicy.noTs === true ||
        projectPolicy.effectOnly?.length ||
        Array.isArray(projectPolicy.noTs)) &&
      !(yield* checkNoTsPaths(
        [filePath],
        !(args.includes("--no-ts") || projectPolicy.noTs === true),
        undefined,
        false,
        projectPolicy,
      ))
    )
      return;
    const source = yield* readFile(filePath);
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
        isPathPolicyEnabled(projectPolicy.allowHoles, process.cwd(), filePath),
      allowEarlyReturns:
        args.includes("--allow-early-returns") ||
        isPathPolicyEnabled(
          projectPolicy.allowEarlyReturns,
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
          catch: (error: unknown) =>
            new Error(
              `Failed to set executable permissions on '${outPath}': ${toErrorMessage(error)}`,
            ),
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
