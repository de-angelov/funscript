import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import fg from "fast-glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { toErrorMessage } from "../errors.js";

export const readFile = (filePath: string) =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf-8"),
    catch: (error: unknown) =>
      new Error(`Failed to read file '${filePath}': ${toErrorMessage(error)}`),
  });

export const writeFile = (filePath: string, content: string) =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    },
    catch: (error: unknown) =>
      new Error(`Failed to write file '${filePath}': ${toErrorMessage(error)}`),
  });

export const findFunFiles = async (dir: string): Promise<string[]> => {
  const matches = await fg.glob("**/*.{fun,funx}", {
    cwd: dir,
    onlyFiles: true,
    dot: false,
    ignore: FORMATTER_IGNORES,
  });
  return matches.map((file) => path.join(dir, file));
};

export const FORMATTER_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.funscript/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
];

export const findFormatFiles = async (
  target: string,
  isDirectory: boolean,
): Promise<string[]> => {
  const pattern = isDirectory ? "**/*.{fun,funx}" : target;
  const matches = await fg.glob(pattern, {
    cwd: isDirectory ? target : undefined,
    onlyFiles: true,
    dot: false,
    ignore: FORMATTER_IGNORES,
  });
  return matches
    .filter((file) => /\.funx?$/i.test(file))
    .map((file) => (isDirectory ? path.join(target, file) : file));
};

export const readStdin = () =>
  new Promise<string>((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += String(chunk);
    });
    process.stdin.once("end", () => resolve(input));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });

/** Audit source paths for standalone JS/TS, including declarations and symlinks. */
export const findNonFunScriptSources = async (
  targets: string[],
): Promise<string[]> => {
  const found = new Set<string>();
  const visitedDirectories = new Set<string>();
  const visit = async (target: string): Promise<void> => {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const real = await fs.realpath(target);
      if (visitedDirectories.has(real)) return;
      visitedDirectories.add(real);
      const entries = await fs.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        if (["node_modules", ".git", ".funscript"].includes(entry.name))
          continue;
        await visit(path.join(target, entry.name));
      }
    } else if (stat.isFile()) {
      const real = await fs.realpath(target);
      if (
        /\.(?:[cm]?[jt]s|[jt]sx|as)$/i.test(target) ||
        /\.(?:[cm]?[jt]s|[jt]sx|as)$/i.test(real)
      )
        found.add(target);
    }
  };
  for (const target of targets) await visit(target);
  return [...found].sort();
};

export const checkNoTsPaths = (
  targets: string[],
  effectOnly = false,
  ownedOutputs?: ReadonlyMap<string, string>,
  quiet = false,
  projectPolicy: FunScriptProjectConfig = {},
) =>
  Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: () => findNonFunScriptSources(targets),
      catch: (error: unknown) =>
        new Error(`Cannot audit source paths: ${toErrorMessage(error)}`),
    });
    const candidates = effectOnly
      ? files.filter(
          (file) =>
            isEffectOnlyFile(projectPolicy, process.cwd(), file) ||
            isPathPolicyEnabled(projectPolicy.noTs, process.cwd(), file),
        )
      : files;
    const rejected: string[] = [];
    for (const file of candidates) {
      const expected = ownedOutputs?.get(path.resolve(file));
      if (
        expected !== undefined &&
        (yield* Effect.promise(() =>
          fs.readFile(file, "utf8").catch(() => undefined),
        )) === expected
      )
        continue;
      rejected.push(file);
    }
    if (rejected.length) {
      process.exitCode = 1;
      if (!quiet)
        for (const file of rejected)
          yield* Console.error(
            `${file}: error: JavaScript, TypeScript and AssemblyScript source files are disabled by ${effectOnly ? "project policy" : "--no-ts"}; write this code in FunScript`,
          );
      return false;
    }
    return true;
  });
