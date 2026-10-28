#!/usr/bin/env node

import { Effect, Console } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fork } from "node:child_process";
import { transformSync } from "esbuild";
import { compileString, checkString } from "../compiler.js";
import { typeCheckFiles } from "../compiler/check.js";
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

const findFunFiles = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFunFiles(fullPath)));
    } else if (entry.isFile() && (entry.name.endsWith(".fun") || entry.name.endsWith(".funx"))) {
      files.push(fullPath);
    }
  }
  return files;
};

const buildCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isSourcemap = args.includes("--sourcemap");
    const outIndex = args.indexOf("--out");
    const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;
    const outDirIndex = args.indexOf("--outDir");
    const outDir = outDirIndex !== -1 ? args[outDirIndex + 1] : undefined;

    const rawFileArgs = args.filter((arg, i) => {
      if (arg === "--sourcemap") return false;
      if (arg === "--out" || (outIndex !== -1 && i === outIndex + 1)) return false;
      if (arg === "--outDir" || (outDirIndex !== -1 && i === outDirIndex + 1)) return false;
      return true;
    });

    let filesToBuild: string[] = [];

    if (rawFileArgs.length === 0) {
      const hasSrc = yield* Effect.tryPromise({
        try: async () => {
          const s = await fs.stat("src");
          return s.isDirectory();
        },
        catch: () => false,
      });
      const searchDir = hasSrc ? "src" : ".";
      filesToBuild = yield* Effect.tryPromise({
        try: () => findFunFiles(searchDir),
        catch: (error: any) => new Error(`Failed to scan files in '${searchDir}': ${error.message}`),
      });
    } else {
      for (const target of rawFileArgs) {
        const stat = yield* Effect.tryPromise({
          try: () => fs.stat(target),
          catch: (error: any) => new Error(`File or directory '${target}' not found: ${error.message}`),
        });
        if (stat.isDirectory()) {
          const nested = yield* Effect.tryPromise({
            try: () => findFunFiles(target),
            catch: (error: any) => new Error(`Failed to scan files in '${target}': ${error.message}`),
          });
          filesToBuild.push(...nested);
        } else {
          filesToBuild.push(target);
        }
      }
    }

    if (filesToBuild.length === 0) {
      return yield* Console.log("No .fun or .funx files found to build");
    }

    for (const filePath of filesToBuild) {
      const source = yield* readFile(filePath);

      let targetOut: string;
      if (outPath && filesToBuild.length === 1) {
        targetOut = outPath;
      } else {
        const ext = filePath.endsWith(".funx") ? ".tsx" : ".ts";
        const baseName = path.basename(filePath, path.extname(filePath)) + ext;
        if (outDir) {
          targetOut = path.join(outDir, baseName);
        } else {
          targetOut = path.join(path.dirname(filePath), baseName);
        }
      }

      const result = yield* compileString(source, filePath, {
        sourcemap: isSourcemap,
        outputFile: path.basename(targetOut),
      });

      let tsCode = result.typescript;
      if (isSourcemap && result.map) {
        const mapFileName = `${path.basename(targetOut)}.map`;
        const mapPath = `${targetOut}.map`;
        tsCode += `\n//# sourceMappingURL=${mapFileName}\n`;
        yield* writeFile(mapPath, result.map.toString());
        yield* Console.log(`✓ Built ${mapPath}`);
      }

      yield* writeFile(targetOut, tsCode);
      yield* Console.log(`✓ Built ${targetOut}`);
    }
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
      return yield* Console.error("Usage: funscript emit <file.fun|file.funx> [--out <file.ts|file.tsx>] [--sourcemap]");
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

const checkCommand = (args: string[]) =>
  Effect.gen(function* () {
    const rawFileArgs = args.filter((a) => !a.startsWith("--"));

    let filesToCheck: string[] = [];
    if (rawFileArgs.length === 0) {
      const hasSrc = yield* Effect.tryPromise({
        try: async () => {
          const s = await fs.stat("src");
          return s.isDirectory();
        },
        catch: () => false,
      });
      const searchDir = hasSrc ? "src" : ".";
      filesToCheck = yield* Effect.tryPromise({
        try: () => findFunFiles(searchDir),
        catch: (error: any) => new Error(`Failed to scan files in '${searchDir}': ${error.message}`),
      });
      if (filesToCheck.length === 0) {
        return yield* Console.error("Usage: funscript check <file.fun|file.funx...>");
      }
    } else {
      for (const target of rawFileArgs) {
        const stat = yield* Effect.tryPromise({
          try: () => fs.stat(target),
          catch: (error: any) => new Error(`File or directory '${target}' not found: ${error.message}`),
        });
        if (stat.isDirectory()) {
          const nested = yield* Effect.tryPromise({
            try: () => findFunFiles(target),
            catch: (error: any) => new Error(`Failed to scan files in '${target}': ${error.message}`),
          });
          filesToCheck.push(...nested);
        } else {
          filesToCheck.push(target);
        }
      }
    }

    const result = yield* typeCheckFiles(filesToCheck);
    if (!result.success) {
      process.exitCode = 1;
      yield* Console.error(result.formattedOutput);
    } else {
      if (filesToCheck.length === 1) {
        yield* Console.log(`✓ ${filesToCheck[0]} checked successfully (0 errors)`);
      } else {
        yield* Console.log(`✓ Checked ${filesToCheck.length} files successfully (0 errors)`);
      }
    }
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
      return yield* Console.error("Usage: funscript run <file.fun|file.funx>");
    }

    const source = yield* readFile(filePath);
    const result = yield* compileString(source, filePath);

    let tsCode = result.typescript;
    tsCode += `\nimport * as __effect from "effect";\nif (typeof main !== "undefined") {\n  if (__effect.Effect.isEffect(main)) {\n    await __effect.Effect.runPromise(main);\n  } else if (typeof main === "function") {\n    await main();\n  }\n}\n`;

    const isFunx = filePath.endsWith(".funx");
    const loader = isFunx ? "tsx" : "ts";
    const transformed = transformSync(tsCode, { loader, format: "esm" });
    const cacheDir = path.resolve(".funscript-cache");
    const ext = path.extname(filePath);
    const targetFile = path.join(cacheDir, `${path.basename(filePath, ext)}.mjs`);

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
  funscript build <file.fun|file.funx...> [--out <file>] [--outDir <dir>] [--sourcemap]  Build to TypeScript / TSX
  funscript emit <file.fun|file.funx> [--out <file>] [--sourcemap]                       Compile to TypeScript / TSX
  funscript check <file.fun|file.funx...>                                                Static type-check via TypeScript API
  funscript run <file.fun|file.funx>                                                     Compile and run with Node
  funscript lsp [--stdio]                                                                Start Language Server Protocol server
  funscript fmt <file.fun...> [--check]                                                  Format FunScript source code
  funscript version                                                                      Display version

Examples:
  funscript build src/Button.funx --sourcemap
  funscript emit src/main.fun --out src/main.ts --sourcemap
  funscript check examples/shapes.fun
  funscript lsp --stdio
  funscript fmt examples/hello.fun --check
`);

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const commandArgs = argv.slice(1);

  switch (command) {
    case "build":
      return yield* buildCommand(commandArgs);
    case "run":
      return yield* runCommand(commandArgs);
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
