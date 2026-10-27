#!/usr/bin/env node

import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fork } from "node:child_process";
import { transformSync } from "esbuild";
import { compileString, checkString } from "../compiler.js";

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

const emitCommand = (args: string[]) =>
  Effect.gen(function* () {
    const filePath = args[0];
    if (!filePath) {
      return yield* Console.error("Usage: funscript emit <file.fun> [--out <file.ts>]");
    }

    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;

    const source = yield* readFile(filePath);
    const result = yield* compileString(source, filePath);

    if (outPath) {
      yield* writeFile(outPath, result.typescript);
      yield* Console.log(`✓ Emitted ${outPath}`);
    } else {
      yield* Console.log(result.typescript);
    }
  });

const checkCommand = (args: string[]) =>
  Effect.gen(function* () {
    const filePath = args[0];
    if (!filePath) {
      return yield* Console.error("Usage: funscript check <file.fun>");
    }

    const source = yield* readFile(filePath);
    yield* checkString(source, filePath);
    yield* Console.log(`✓ ${filePath} checked successfully (0 errors)`);
  });

const runCommand = (args: string[]) =>
  Effect.gen(function* () {
    const filePath = args[0];
    if (!filePath) {
      return yield* Console.error("Usage: funscript run <file.fun>");
    }

    const source = yield* readFile(filePath);
    const result = yield* compileString(source, filePath);

    let tsCode = result.typescript;
    tsCode += `\nimport * as __effect from "effect";\nif (typeof main !== "undefined") {\n  if (__effect.Effect.isEffect(main)) {\n    await __effect.Effect.runPromise(main);\n  } else if (typeof main === "function") {\n    await main();\n  }\n}\n`;

    const transformed = transformSync(tsCode, { loader: "ts", format: "esm" });
    const cacheDir = path.resolve(".funscript-cache");
    const targetFile = path.join(cacheDir, `${path.basename(filePath, ".fun")}.mjs`);

    yield* writeFile(targetFile, transformed.code);

    yield* Effect.async<void, Error>((resume) => {
      const child = fork(targetFile, { stdio: "inherit" });
      child.on("exit", (code) => {
        if (code === 0) resume(Effect.void);
        else resume(Effect.fail(new Error(`Program exited with code ${code}`)));
      });
      child.on("error", (err) => resume(Effect.fail(err)));
    });
  });

const helpCommand = Console.log(`
FunScript 0.1.0 — A functional notation for TypeScript and Effect

Usage:
  funscript emit <file.fun> [--out <file.ts>]   Compile to TypeScript
  funscript check <file.fun>                   Parse and check syntax
  funscript version                            Display version

Examples:
  funscript emit src/main.fun --out src/main.ts
  funscript check examples/shapes.fun
`);

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const commandArgs = argv.slice(1);

  switch (command) {
    case "run":
      return yield* runCommand(commandArgs);
    case "emit":
      return yield* emitCommand(commandArgs);
    case "check":
      return yield* checkCommand(commandArgs);
    case "version":
    case "-v":
    case "--version":
      return yield* Console.log("funscript 0.1.0");
    case "help":
    case "-h":
    case "--help":
    default:
      return yield* helpCommand;
  }
}).pipe(
  Effect.catchAll((err: any) =>
    Console.error(`\x1b[31merror\x1b[0m: ${err.message || err}`)
  )
);

// Execute Effect program
Effect.runPromise(program);
