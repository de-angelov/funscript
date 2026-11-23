import { createTwoFilesPatch } from "diff";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadFormatConfigForFile } from "../compiler/project-config.js";
import { format } from "../formatter/index.js";
import { toErrorMessage } from "../errors.js";
import { findFormatFiles, readFile, readStdin, writeFile } from "./io.js";

export const fmtCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isCheck = args.includes("--check");
    const isDiff = args.includes("--diff");
    const isStdin = args.includes("--stdin");
    const stdinPathIndex = args.indexOf("--stdin-filepath");
    const stdinFilepath =
      stdinPathIndex >= 0 ? args[stdinPathIndex + 1] : undefined;
    const fileArgs = args.filter(
      (arg, index) =>
        arg !== "--check" &&
        arg !== "--diff" &&
        arg !== "--stdin" &&
        arg !== "--stdin-filepath" &&
        !(stdinPathIndex >= 0 && index === stdinPathIndex + 1),
    );

    if (isStdin) {
      if (fileArgs.length) {
        process.exitCode = 1;
        return yield* Console.error(
          "Usage: funscript fmt --stdin [--check|--diff] [--stdin-filepath <path>]",
        );
      }
      const source = yield* Effect.tryPromise({
        try: readStdin,
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
      const filename = stdinFilepath
        ? path.resolve(stdinFilepath)
        : path.resolve("stdin.fun");
      try {
        const formatted = format(source, {
          ...loadFormatConfigForFile(filename),
          filename,
        });
        if (isDiff && source !== formatted) {
          process.stdout.write(
            createTwoFilesPatch(
              stdinFilepath ?? "stdin.fun",
              stdinFilepath ?? "stdin.fun",
              source,
              formatted,
            ),
          );
          process.exitCode = 1;
        } else if (isCheck) {
          if (source !== formatted) {
            process.exitCode = 1;
            yield* Console.error(
              `✗ '${stdinFilepath ?? "stdin"}' is not formatted`,
            );
          }
        } else {
          process.stdout.write(formatted);
        }
      } catch (error: unknown) {
        process.exitCode = 1;
        yield* Console.error(
          `Format error in '${filename}': ${toErrorMessage(error)}`,
        );
      }
      return;
    }

    if (fileArgs.length === 0) {
      process.exitCode = 1;
      return yield* Console.error(
        "Usage: funscript fmt <file|directory|glob...> [--check|--diff] | funscript fmt --stdin [--check|--diff] [--stdin-filepath <path>]",
      );
    }

    const files = new Set<string>();
    for (const target of fileArgs) {
      const hasGlob = /[*?{}[\]()!]/.test(target);
      const stat = hasGlob
        ? undefined
        : yield* Effect.tryPromise({
            try: () => fs.stat(target),
            catch: () => undefined,
          });
      if (hasGlob) {
        const matches = yield* Effect.tryPromise({
          try: () => findFormatFiles(target, false),
          catch: (error: unknown) =>
            new Error(`Cannot expand '${target}': ${toErrorMessage(error)}`),
        });
        for (const file of matches) files.add(file);
        if (!matches.length) {
          process.exitCode = 1;
          yield* Console.error(`No FunScript files matched '${target}'`);
        }
        continue;
      }
      if (!stat) {
        process.exitCode = 1;
        yield* Console.error(
          `Cannot read '${target}': no such file or directory`,
        );
        continue;
      }
      if (stat.isDirectory()) {
        const nested = yield* Effect.tryPromise({
          try: () => findFormatFiles(target, true),
          catch: (error: unknown) =>
            new Error(`Failed to scan '${target}': ${toErrorMessage(error)}`),
        });
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
        formatted = format(source, {
          ...loadFormatConfigForFile(path.resolve(filePath)),
          filename: filePath,
        });
      } catch (err: unknown) {
        process.exitCode = 1;
        hasDiff = true;
        yield* Console.error(
          `Format error in '${filePath}': ${toErrorMessage(err)}`,
        );
        continue;
      }

      if (isDiff) {
        if (source !== formatted) {
          hasDiff = true;
          process.stdout.write(
            createTwoFilesPatch(filePath, filePath, source, formatted),
          );
        }
      } else if (isCheck) {
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

    if ((isCheck || isDiff) && hasDiff) {
      process.exitCode = 1;
    }
  });
