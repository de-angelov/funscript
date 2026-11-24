import * as Effect from "effect/Effect";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { findFunFiles } from "./io.js";

export const testCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isWatch = args.includes("--watch");
    const engineIndex = args.indexOf("--engine");
    const engine = engineIndex !== -1 ? args[engineIndex + 1] : undefined;
    const isFast = args.includes("--fast");
    const isBun =
      engine === "bun" ||
      isFast ||
      (!engine &&
        typeof process !== "undefined" &&
        Boolean(process.versions?.bun));

    const forwardArgs = args.filter(
      (arg, i) =>
        arg !== "--watch" &&
        arg !== "--engine" &&
        arg !== "--fast" &&
        (engineIndex === -1 || i !== engineIndex + 1),
    );

    if (isBun) {
      const explicitFunFiles = forwardArgs.filter((arg) =>
        /\.(fun|funx)$/.test(arg),
      );
      const nonFunArgs = forwardArgs.filter(
        (arg) => !/\.(fun|funx)$/.test(arg),
      );

      const bridgeDir = path.resolve(".funscript-cache/bun-tests");
      const bridges: string[] = [];

      try {
        let funTargets: string[] = [];
        if (explicitFunFiles.length > 0) {
          funTargets = explicitFunFiles;
        } else if (nonFunArgs.every((arg) => arg.startsWith("-"))) {
          const allFun = yield* Effect.tryPromise({
            try: () => findFunFiles(process.cwd()),
            catch: () => [],
          });
          funTargets = allFun.filter((f) =>
            /\.(test|spec)\.(fun|funx)$/.test(f),
          );
        }

        if (funTargets.length > 0) {
          mkdirSync(bridgeDir, { recursive: true });
          for (const file of funTargets) {
            const absPath = path.resolve(file);
            const baseName = path
              .basename(file)
              .replace(/\.(fun|funx)$/, "")
              .replace(/[^a-zA-Z0-9_-]/g, "_");
            const bridgeFile = path.join(
              bridgeDir,
              `__fun_${baseName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.test.ts`,
            );
            writeFileSync(bridgeFile, `import ${JSON.stringify(absPath)};\n`);
            bridges.push(bridgeFile);
          }
        }
      } catch {
        // Fall back to direct execution
      }

      const bunArgs = [
        "test",
        "--preload",
        "funscript/bun/preload",
        ...nonFunArgs,
        ...bridges,
      ];

      const cleanup = () => {
        for (const b of bridges) {
          try {
            unlinkSync(b);
          } catch {
            // Bridge already removed
          }
        }
      };

      return yield* Effect.callback<void, Error>((resume) => {
        const child = spawn("bun", bunArgs, { stdio: "inherit" });
        child.on("exit", (code) => {
          cleanup();
          if (code === 0) resume(Effect.void);
          else {
            process.exitCode = code ?? 1;
            resume(Effect.void);
          }
        });
        child.on("error", (err) => {
          cleanup();
          resume(Effect.fail(err));
        });
      });
    }

    const cwd = process.cwd();
    const localVitest = path.resolve(
      cwd,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "vitest.cmd" : "vitest",
    );
    const vitestCmd = existsSync(localVitest) ? localVitest : "npx";
    const effectiveArgs = forwardArgs.includes("--globals")
      ? forwardArgs
      : ["--globals", ...forwardArgs];
    const vitestArgs = existsSync(localVitest)
      ? (isWatch ? [] : ["run"]).concat(effectiveArgs)
      : ["vitest", ...(isWatch ? [] : ["run"]), ...effectiveArgs];

    return yield* Effect.callback<void, Error>((resume) => {
      const child = spawn(vitestCmd, vitestArgs, {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.on("exit", (code) => {
        if (code === 0) resume(Effect.void);
        else {
          process.exitCode = code ?? 1;
          resume(Effect.void);
        }
      });
      child.on("error", (err) => resume(Effect.fail(err)));
    });
  });
