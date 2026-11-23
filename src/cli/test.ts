import { Effect } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

export const testCommand = (args: string[]) =>
  Effect.callback<void, Error>((resume) => {
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
      const bunArgs = [
        "test",
        "--preload",
        "funscript/bun/preload",
        ...forwardArgs,
      ];
      const child = spawn("bun", bunArgs, { stdio: "inherit" });
      child.on("exit", (code) => {
        if (code === 0) resume(Effect.void);
        else {
          process.exitCode = code ?? 1;
          resume(Effect.void);
        }
      });
      child.on("error", (err) => resume(Effect.fail(err)));
      return;
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
