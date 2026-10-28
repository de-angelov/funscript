#!/usr/bin/env node

import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fork } from "node:child_process";
import { transformSync } from "esbuild";
import { compileString, checkString } from "../compiler.js";
import { startLspServer } from "../lsp/index.js";
import { format } from "../formatter/index.js";

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
    const isSourcemap = args.includes("--sourcemap");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const fileArgs = args.filter((a, idx) => {
      if (a === "--sourcemap") return false;
      if (a === "--out" || (outIndex !== -1 && idx === outIndex + 1)) return false;
      return true;
    });

    const filePath = fileArgs[0];
    if (!filePath) {
      return yield* Console.error("Usage: funscript emit <file.fun> [--out <file.ts>] [--sourcemap]");
    }

    const source = yield* readFile(filePath);
    const result = yield* compileString(source, filePath, {
      sourcemap: isSourcemap,
      outputFile: outPath ? path.basename(outPath) : undefined,
    });

    let tsCode = result.typescript;
    if (outPath) {
      if (isSourcemap && result.map) {
        const mapFileName = `${path.basename(outPath)}.map`;
        const mapPath = `${outPath}.map`;
        tsCode += `\n//# sourceMappingURL=${mapFileName}\n`;
        yield* writeFile(mapPath, result.map.toString());
        yield* Console.log(`✓ Emitted ${mapPath}`);
      }
      yield* writeFile(outPath, tsCode);
      yield* Console.log(`✓ Emitted ${outPath}`);
    } else {
      if (isSourcemap && result.map) {
        yield* Console.log(result.map.toString());
      } else {
        yield* Console.log(tsCode);
      }
    }
  });

const buildCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isSourcemap = args.includes("--sourcemap");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const outDirIndex = args.indexOf("--outDir");
    const outDir = outDirIndex !== -1 ? args[outDirIndex + 1] : undefined;

    const fileArgs = args.filter((a, idx) => {
      if (a === "--sourcemap") return false;
      if (a === "--out" || (outIndex !== -1 && idx === outIndex + 1)) return false;
      if (a === "--outDir" || (outDirIndex !== -1 && idx === outDirIndex + 1)) return false;
      return true;
    });

    if (fileArgs.length === 0) {
      return yield* Console.error("Usage: funscript build <file.fun...> [--out <file.ts>] [--outDir <dir>] [--sourcemap]");
    }

    for (const filePath of fileArgs) {
      const source = yield* readFile(filePath);

      let targetTsPath: string;
      if (outPath && fileArgs.length === 1) {
        targetTsPath = outPath;
      } else if (outDir) {
        const baseName = path.basename(filePath).replace(/\.funx?$/, (ext) => ext === ".funx" ? ".tsx" : ".ts");
        targetTsPath = path.join(outDir, baseName);
      } else {
        targetTsPath = filePath.replace(/\.funx?$/, (ext) => ext === ".funx" ? ".tsx" : ".ts");
      }

      const result = yield* compileString(source, filePath, {
        sourcemap: isSourcemap,
        outputFile: path.basename(targetTsPath),
      });

      let tsCode = result.typescript;
      if (isSourcemap && result.map) {
        const mapFileName = `${path.basename(targetTsPath)}.map`;
        const mapPath = `${targetTsPath}.map`;
        tsCode += `\n//# sourceMappingURL=${mapFileName}\n`;
        yield* writeFile(mapPath, result.map.toString());
        yield* Console.log(`✓ Emitted ${mapPath}`);
      }

      yield* writeFile(targetTsPath, tsCode);
      yield* Console.log(`✓ Emitted ${targetTsPath}`);
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

const fmtCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isCheck = args.includes("--check");
    const fileArgs = args.filter((a) => a !== "--check");

    if (fileArgs.length === 0) {
      process.exitCode = 1;
      return yield* Console.error("Usage: funscript fmt <file.fun...> [--check]");
    }

    let hasDiff = false;
    for (const filePath of fileArgs) {
      const source = yield* readFile(filePath);
      let formatted: string;
      try {
        formatted = format(source);
      } catch (err: any) {
        process.exitCode = 1;
        hasDiff = true;
        yield* Console.error(`Format error in '${filePath}': ${err.message}`);
        continue;
      }

      if (isCheck) {
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

    if (isCheck && hasDiff) {
      process.exitCode = 1;
    }
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
    tsCode += `\nimport * as __effect from "effect";\nif (typeof main !== "undefined") {\n  if (__effect.Effect.isEffect(main)) {\n    await __effect.Effect.runPromise(main);\n  } else if (typeof main === "function") {\n    const __res = await main();\n    if (__effect.Effect.isEffect(__res)) {\n      await __effect.Effect.runPromise(__res);\n    }\n  }\n}\n`;

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

const lspCommand = (args: string[]) =>
  Effect.async<void, Error>((resume) => {
    const server = startLspServer({
      reader: process.stdin,
      writer: process.stdout,
    });
    server.onExit((code) => {
      setImmediate(() => {
        process.exit(code);
      });
    });
  });

const helpCommand = Console.log(`
FunScript 0.1.0 — A functional notation for TypeScript and Effect

Usage:
  funscript build <file.fun> [--out <file.ts>] [--sourcemap]   Build FunScript to TypeScript
  funscript emit <file.fun> [--out <file.ts>] [--sourcemap]    Compile to TypeScript
  funscript check <file.fun>                   Parse and check syntax
  funscript lsp [--stdio]                      Start Language Server Protocol server
  funscript fmt <file.fun> [--check]           Format FunScript source code
  funscript version                            Display version

Examples:
  funscript build src/main.fun --out src/main.ts --sourcemap
  funscript emit src/main.fun --out src/main.ts
  funscript check examples/shapes.fun
  funscript lsp --stdio
  funscript fmt examples/hello.fun --check
`);

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const commandArgs = argv.slice(1);

  switch (command) {
    case "run":
      return yield* runCommand(commandArgs);
    case "build":
      return yield* buildCommand(commandArgs);
    case "emit":
      return yield* emitCommand(commandArgs);
    case "check":
      return yield* checkCommand(commandArgs);
    case "lsp":
      return yield* lspCommand(commandArgs);
    case "fmt":
      return yield* fmtCommand(commandArgs);
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
  Effect.catchAll((err: any) => {
    process.exitCode = 1;
    return Console.error(`\x1b[31merror\x1b[0m: ${err.message || err}`);
  })
);

// Execute Effect program
Effect.runPromise(program);
