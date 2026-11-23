import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import { findFunFiles } from "./io.js";
import { generateDocs } from "../tooling/doc.js";

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
        catch: (err: any) =>
          new Error(`Target '${target}' not found: ${err.message}`),
      });
      if (stat.isDirectory()) {
        const found = yield* Effect.tryPromise({
          try: () => findFunFiles(target),
          catch: (err: any) =>
            new Error(`Failed scanning '${target}': ${err.message}`),
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
      catch: (err: any) =>
        new Error(`Failed generating documentation: ${err.message}`),
    });

    yield* Console.log(
      `Generated documentation for ${res.project.modules.length} modules (${format}): ${res.mainFile}`,
    );
  });
