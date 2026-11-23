import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findFunFiles, readFile, writeFile } from "./io.js";
import { convertPipelineStyle } from "../tooling/pipeline-style.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";

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
        catch: (error: any) => new Error(error.message),
      });
      const files = stat.isDirectory()
        ? yield* Effect.tryPromise({
            try: () => findFunFiles(target),
            catch: (error: any) => new Error(error.message),
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
        } catch (error: any) {
          process.exitCode = 1;
          yield* Console.error(`${file}: ${error.message}`);
        }
      }
    }
  });
