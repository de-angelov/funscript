import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import { generateDocs } from "../tooling/doc.js";
import { toErrorMessage } from "../errors.js";
import { findFunFiles } from "./io.js";

export const docCommand = (args: string[]) =>
  Effect.gen(function* () {
    let outDir = "docs/api";
    let format: "html" | "markdown" | "json" = "html";
    let open = false;
    const targets: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--outDir" && args[i + 1]) {
        outDir = args[++i];
      } else if (arg === "--format" && args[i + 1]) {
        const fmt = args[++i];
        if (fmt === "html" || fmt === "markdown" || fmt === "json") {
          format = fmt;
        } else {
          process.exitCode = 1;
          return yield* Console.error(
            `error: Unsupported format '${fmt}'. Expected 'html', 'markdown', or 'json'.`,
          );
        }
      } else if (arg === "--json") {
        format = "json";
      } else if (arg === "--open") {
        open = true;
      } else if (!arg.startsWith("-")) {
        targets.push(arg);
      }
    }

    if (targets.length === 0) {
      const hasSrc = yield* Effect.tryPromise({
        try: async () => (await fs.stat("src")).isDirectory(),
        catch: () => false,
      });
      targets.push(hasSrc ? "src" : ".");
    }

    const files: string[] = [];
    for (const target of targets) {
      const stat = yield* Effect.tryPromise({
        try: () => fs.stat(target),
        catch: (err: unknown) =>
          new Error(`Target '${target}' not found: ${toErrorMessage(err)}`),
      });
      if (stat.isDirectory()) {
        const found = yield* Effect.tryPromise({
          try: () => findFunFiles(target),
          catch: (err: unknown) =>
            new Error(`Failed scanning '${target}': ${toErrorMessage(err)}`),
        });
        files.push(...found);
      } else {
        files.push(target);
      }
    }

    if (files.length === 0) {
      process.exitCode = 1;
      return yield* Console.error(
        "error: No FunScript source files (.fun, .funx) found.",
      );
    }

    const res = yield* Effect.tryPromise({
      try: () => generateDocs(files, { outDir, format, open }),
      catch: (err: unknown) =>
        new Error(`Failed generating documentation: ${toErrorMessage(err)}`),
    });

    yield* Console.log(
      `Generated documentation for ${res.project.modules.length} modules (${format}): ${res.mainFile}`,
    );
  });
