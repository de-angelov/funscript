import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import { toErrorMessage } from "../errors.js";
import { convertPipelineStyle } from "../tooling/pipeline-style.js";
import { findFunFiles, readFile, writeFile } from "./io.js";

export const pipelineStyleCommand = (args: string[]) =>
  Effect.gen(function* () {
    const style = args[0];
    const targets = args.slice(1);
    if ((style !== "bare" && style !== "qualified") || !targets.length) {
      process.exitCode = 1;
      return yield* Console.error(
        "Usage: funscript pipeline-style <bare|qualified> <file or directory...>",
      );
    }
    for (const target of targets) {
      const stat = yield* Effect.tryPromise({
        try: () => fs.stat(target),
        catch: (error: unknown) => new Error(toErrorMessage(error)),
      });
      const files = stat.isDirectory()
        ? yield* Effect.tryPromise({
            try: () => findFunFiles(target),
            catch: (error: unknown) => new Error(toErrorMessage(error)),
          })
        : [target];
      const compilationContext =
        files.length > 0
          ? new TypeScriptCompilationContext(path.resolve(files[0]))
          : undefined;
      for (const file of files) {
        try {
          const source = yield* readFile(file);
          const result = convertPipelineStyle(
            source,
            path.resolve(file),
            style,
            undefined,
            compilationContext,
          );
          if (result.changed) yield* writeFile(file, result.text);
          yield* Console.log(
            `${file}: ${result.changed} converted, ${result.skipped} skipped`,
          );
        } catch (error: unknown) {
          process.exitCode = 1;
          yield* Console.error(`${file}: ${toErrorMessage(error)}`);
        }
      }
    }
  });
