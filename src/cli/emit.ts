import { Effect, Console } from "effect";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileString } from "../compiler.js";
import {
  isPathPolicyEnabled,
  isEffectOnlyFile,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { readFile, writeFile, checkNoTsPaths } from "./io.js";

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
        a === "--no-optional" ||
        a === "--bare-pipelines" ||
        a === "--bin"
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
      noOptional:
        args.includes("--no-optional") ||
        isPathPolicyEnabled(projectPolicy.noOptional, process.cwd(), filePath),
      barePipelines:
        args.includes("--bare-pipelines") ||
        isPathPolicyEnabled(
          projectPolicy.barePipelines,
          process.cwd(),
          filePath,
        ),
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
          catch: (error: any) =>
            new Error(
              `Failed to set executable permissions on '${outPath}': ${error.message}`,
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
