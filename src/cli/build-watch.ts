import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { uniq } from "es-toolkit";
import type { CheckOptions } from "../compiler/check.js";
import { IncrementalBuildSession } from "../compiler/incremental-build.js";
import { incrementalDependencyKeys } from "../compiler/incremental-dependencies.js";
import {
  loadProjectConfig,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { collectCliFiles } from "./typecheck.js";

export interface WatchBuildOptions {
  targets: string[];
  cwd?: string;
  outDir?: string;
  out?: string;
  flags: {
    noTs: boolean;
    noGlobalThis: boolean;
    barePipelines: boolean;
    noDeepDestructure?: boolean;
  };
  audit?: (
    targets: string[],
    policy: FunScriptProjectConfig,
  ) => Promise<boolean>;
  onOutput?: (filename: string, content: string) => void;
  intervalMs?: number;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

const sourceRootForFile = (filename: string): string => {
  const parts = path.resolve(filename).split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  return srcIndex > 0
    ? parts.slice(0, srcIndex + 1).join(path.sep)
    : path.dirname(filename);
};

const commonDirectory = (directories: string[]): string => {
  const [first, ...rest] = directories.map((directory) =>
    path.resolve(directory),
  );
  if (!first) return process.cwd();
  const commonParts = rest.reduce((common, directory) => {
    const parts = directory.split(path.sep);
    let length = 0;
    while (
      length < common.length &&
      length < parts.length &&
      common[length] === parts[length]
    )
      length++;
    return common.slice(0, length);
  }, first.split(path.sep));
  return commonParts.join(path.sep) || path.parse(first).root;
};

/** Poll complete source and dependency snapshots; never overlap builds. */
export async function watchBuild(
  options: WatchBuildOptions,
  signal: AbortSignal,
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const interval = options.intervalMs ?? 2000;
  const roots = options.targets.length
    ? options.targets.map((target) => path.resolve(cwd, target))
    : [
        path.resolve(
          cwd,
          (await fs
            .stat(path.join(cwd, "src"))
            .then((s) => s.isDirectory())
            .catch(() => false))
            ? "src"
            : ".",
        ),
      ];
  let previous = "";
  let lastError = "";
  let session: IncrementalBuildSession | undefined;
  let policyKey = "";
  let volatileAt = 0;
  let auditFailed = false;
  const managedOutputs = new Map<string, string>();
  const findFiles = async (target: string): Promise<string[]> => {
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) return [];
    if (!stat.isDirectory()) return /\.funx?$/.test(target) ? [target] : [];
    const files: string[] = [];
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (
        entry.isDirectory() ||
        (entry.isFile() && /\.funx?$/.test(entry.name))
      )
        files.push(...(await findFiles(path.join(target, entry.name))));
    }
    return files.sort();
  };
  const report = (message: string) => {
    if (message !== lastError) error(message);
    lastError = message;
  };
  if (!signal.aborted) log("Watching for changes (Ctrl+C to stop).");
  while (!signal.aborted) {
    try {
      const policy = loadProjectConfig(cwd);
      const nextPolicyKey = JSON.stringify(policy);
      const entries = uniq(
        (await Promise.all(roots.map(findFiles))).flat(),
      ).sort();
      const all = entries.length
        ? await Effect.runPromise(collectCliFiles(entries, { cwd }))
        : [];
      const snapshot: Record<string, string> = {};
      for (const file of all.sort())
        snapshot[file] = await fs.readFile(file, "utf8");
      const sources = new Map(Object.entries(snapshot));
      const dependencies = incrementalDependencyKeys(sources, cwd);
      const volatile = [...dependencies.values()].some(
        (value) => value === undefined,
      );
      const policyValid =
        !options.audit || (await options.audit(roots, policy));
      let outputChanged = false;
      for (const [file, content] of managedOutputs) {
        if (
          (await fs.readFile(file, "utf8").catch(() => undefined)) !== content
        ) {
          outputChanged = true;
          break;
        }
      }
      const signature = createHash("sha256")
        .update(
          JSON.stringify([
            nextPolicyKey,
            entries,
            [...sources],
            [...dependencies],
            policyValid,
          ]),
        )
        .digest("hex");
      if (
        signature !== previous ||
        outputChanged ||
        auditFailed ||
        (volatile && Date.now() - volatileAt >= 15000)
      ) {
        if (signal.aborted) break;
        if (!session || nextPolicyKey !== policyKey) {
          const checks: Omit<CheckOptions, "cwd" | "cache"> = {
            noTs: options.flags.noTs || policy.noTs === true,
            noGlobalThis:
              options.flags.noGlobalThis || policy.noGlobalThis === true,
            barePipelines:
              options.flags.barePipelines || policy.barePipelines === true,
            noDeepDestructure:
              options.flags.noDeepDestructure ||
              policy.noDeepDestructure === true,
            maxDestructureDepth: policy.maxDestructureDepth,
            noTsPaths: Array.isArray(policy.noTs) ? policy.noTs : undefined,
            noGlobalThisPaths: Array.isArray(policy.noGlobalThis)
              ? policy.noGlobalThis
              : undefined,
            barePipelinesPaths: Array.isArray(policy.barePipelines)
              ? policy.barePipelines
              : undefined,
            noDeepDestructurePaths: Array.isArray(policy.noDeepDestructure)
              ? policy.noDeepDestructure
              : undefined,
            effectOnly: policy.effectOnly,
          };
          session = new IncrementalBuildSession(cwd, checks);
          policyKey = nextPolicyKey;
        }
        if (options.out && all.length > 1)
          throw new Error(
            "--out requires exactly one FunScript file with no local FunScript imports in watch mode",
          );
        if (!policyValid) {
          previous = signature;
          volatileAt = Date.now();
          auditFailed = true;
          throw new Error("Source policy audit failed");
        }
        auditFailed = false;
        if (!entries.length) {
          managedOutputs.clear();
          log("No FunScript files found; watching for changes.");
        } else {
          const result = await Effect.runPromise(session.build(snapshot));
          if (signal.aborted) break;
          if (!result.check.success) {
            process.exitCode = 1;
            report(result.check.formattedOutput);
          } else {
            const currentEntries = uniq(
              (await Promise.all(roots.map(findFiles))).flat(),
            ).sort();
            const currentAll = currentEntries.length
              ? await Effect.runPromise(
                  collectCliFiles(currentEntries, { cwd }),
                )
              : [];
            const currentSources: Record<string, string> = {};
            for (const file of currentAll.sort())
              currentSources[file] = await fs.readFile(file, "utf8");
            const currentDependencies = incrementalDependencyKeys(
              new Map(Object.entries(currentSources)),
              cwd,
            );
            const currentPolicy = loadProjectConfig(cwd);
            const currentPolicyValid =
              !options.audit || (await options.audit(roots, currentPolicy));
            const currentSignature = createHash("sha256")
              .update(
                JSON.stringify([
                  JSON.stringify(currentPolicy),
                  currentEntries,
                  Object.entries(currentSources),
                  [...currentDependencies],
                  currentPolicyValid,
                ]),
              )
              .digest("hex");
            if (currentSignature !== signature) {
              previous = "";
              continue;
            }
            if (!currentPolicyValid) {
              auditFailed = true;
              throw new Error("Source policy audit failed");
            }
            const outputFiles = all;
            const targetRoots = await Promise.all(
              roots.map(async (root) => {
                const stat = await fs.stat(root).catch(() => undefined);
                return stat?.isDirectory() ? root : sourceRootForFile(root);
              }),
            );
            const commonRoot = commonDirectory([
              ...targetRoots,
              ...outputFiles.map((file) => path.dirname(file)),
            ]);
            const destinations = new Set<string>();
            const writes = outputFiles.map((file) => {
              const ext = file.endsWith(".funx") ? ".tsx" : ".ts";
              const outputRelative = path
                .relative(commonRoot, file)
                .replace(/\.funx?$/, ext);
              const destination = path.resolve(
                cwd,
                options.out && outputFiles.length === 1
                  ? options.out
                  : options.outDir
                    ? path.join(options.outDir, outputRelative)
                    : file.replace(/\.funx?$/, ext),
              );
              if (destinations.has(destination) || sources.has(destination))
                throw new Error(
                  `Multiple inputs or an input would be overwritten by ${destination}`,
                );
              destinations.add(destination);
              const content = result.outputs[file];
              if (content === undefined)
                throw new Error(`Missing build output for ${file}`);
              return { destination, content };
            });
            for (const { destination, content } of writes) {
              const previousContent = await fs
                .readFile(destination, "utf8")
                .catch(() => undefined);
              if (previousContent !== content) {
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, content, "utf8");
              }
              options.onOutput?.(destination, content);
            }
            managedOutputs.clear();
            for (const { destination, content } of writes)
              managedOutputs.set(destination, content);
            process.exitCode = 0;
            log(
              `Built ${outputFiles.length} file(s); ${result.compiled} compiled, ${result.reused} reused.`,
            );
            lastError = "";
          }
        }
        previous = signature;
        volatileAt = Date.now();
      }
    } catch (cause) {
      report(cause instanceof Error ? cause.message : String(cause));
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, interval);
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}
