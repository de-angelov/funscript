import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { collectCliFiles } from "./typecheck.js";
import { IncrementalBuildSession } from "../compiler/incremental-build.js";
import { incrementalDependencyKeys } from "../compiler/incremental-dependencies.js";
import { loadProjectConfig, type FunScriptProjectConfig } from "../compiler/project-config.js";
import type { CheckOptions } from "../compiler/check.js";

export interface WatchBuildOptions {
  targets: string[];
  cwd?: string;
  outDir?: string;
  out?: string;
  flags: { noTs: boolean; noGlobalThis: boolean; noOptional: boolean; barePipelines: boolean };
  audit?: (targets: string[], policy: FunScriptProjectConfig) => Promise<boolean>;
  onOutput?: (filename: string, content: string) => void;
  intervalMs?: number;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

/** Poll complete source and dependency snapshots; never overlap builds. */
export async function watchBuild(options: WatchBuildOptions, signal: AbortSignal): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const interval = options.intervalMs ?? 2000;
  const roots = options.targets.length ? options.targets.map(target => path.resolve(cwd, target)) : [path.resolve(cwd, await fs.stat(path.join(cwd, "src")).then(s => s.isDirectory()).catch(() => false) ? "src" : ".")];
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
      if (entry.isDirectory() || (entry.isFile() && /\.funx?$/.test(entry.name))) files.push(...await findFiles(path.join(target, entry.name)));
    }
    return files.sort();
  };
  const report = (message: string) => { if (message !== lastError) error(message); lastError = message; };
  if (!signal.aborted) log("Watching for changes (Ctrl+C to stop).");
  while (!signal.aborted) {
    try {
      const policy = loadProjectConfig(cwd);
      const nextPolicyKey = JSON.stringify(policy);
      const entries = [...new Set((await Promise.all(roots.map(findFiles))).flat())].sort();
      const all = entries.length ? await Effect.runPromise(collectCliFiles(entries, { cwd })) : [];
      const snapshot: Record<string, string> = {};
      for (const file of all.sort()) snapshot[file] = await fs.readFile(file, "utf8");
      const sources = new Map(Object.entries(snapshot));
      const dependencies = incrementalDependencyKeys(sources, cwd);
      const volatile = [...dependencies.values()].some(value => value === undefined);
      const policyValid = !options.audit || await options.audit(roots, policy);
      let outputChanged = false;
      for (const [file, content] of managedOutputs) {
        if ((await fs.readFile(file, "utf8").catch(() => undefined)) !== content) { outputChanged = true; break; }
      }
      const signature = createHash("sha256").update(JSON.stringify([nextPolicyKey, entries, [...sources], [...dependencies], policyValid])).digest("hex");
      if (signature !== previous || outputChanged || auditFailed || (volatile && Date.now() - volatileAt >= 15000)) {
        if (signal.aborted) break;
        if (!session || nextPolicyKey !== policyKey) {
          const checks: Omit<CheckOptions, "cwd" | "cache"> = {
            noTs: options.flags.noTs || policy.noTs === true,
            noGlobalThis: options.flags.noGlobalThis || policy.noGlobalThis === true,
            noOptional: options.flags.noOptional || policy.noOptional === true,
            barePipelines: options.flags.barePipelines || policy.barePipelines === true,
            noTsPaths: Array.isArray(policy.noTs) ? policy.noTs : undefined,
            noGlobalThisPaths: Array.isArray(policy.noGlobalThis) ? policy.noGlobalThis : undefined,
            noOptionalPaths: Array.isArray(policy.noOptional) ? policy.noOptional : undefined,
            barePipelinesPaths: Array.isArray(policy.barePipelines) ? policy.barePipelines : undefined,
            effectOnly: policy.effectOnly,
          };
          session = new IncrementalBuildSession(cwd, checks);
          policyKey = nextPolicyKey;
        }
        if (options.out && entries.length > 1) throw new Error("--out requires exactly one input file in watch mode");
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
          if (!result.check.success) { process.exitCode = 1; report(result.check.formattedOutput); }
          else {
            const currentEntries = [...new Set((await Promise.all(roots.map(findFiles))).flat())].sort();
            const currentAll = currentEntries.length ? await Effect.runPromise(collectCliFiles(currentEntries, { cwd })) : [];
            const currentSources: Record<string, string> = {};
            for (const file of currentAll.sort()) currentSources[file] = await fs.readFile(file, "utf8");
            const currentDependencies = incrementalDependencyKeys(new Map(Object.entries(currentSources)), cwd);
            const currentPolicy = loadProjectConfig(cwd);
            const currentPolicyValid = !options.audit || await options.audit(roots, currentPolicy);
            const currentSignature = createHash("sha256").update(JSON.stringify([JSON.stringify(currentPolicy), currentEntries, Object.entries(currentSources), [...currentDependencies], currentPolicyValid])).digest("hex");
            if (currentSignature !== signature) { previous = ""; continue; }
            if (!currentPolicyValid) { auditFailed = true; throw new Error("Source policy audit failed"); }
            const destinations = new Set<string>();
            const writes = entries.map(file => {
              const ext = file.endsWith(".funx") ? ".tsx" : ".ts";
              const destination = path.resolve(cwd, options.out && entries.length === 1 ? options.out : options.outDir ? path.join(options.outDir, path.basename(file, path.extname(file)) + ext) : file.replace(/\.funx?$/, ext));
              if (destinations.has(destination) || sources.has(destination)) throw new Error(`Multiple inputs or an input would be overwritten by ${destination}`);
              destinations.add(destination);
              const content = result.outputs[file];
              if (content === undefined) throw new Error(`Missing build output for ${file}`);
              return { destination, content };
            });
            for (const { destination, content } of writes) {
              const previousContent = await fs.readFile(destination, "utf8").catch(() => undefined);
              if (previousContent !== content) { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content, "utf8"); }
              options.onOutput?.(destination, content);
            }
            managedOutputs.clear();
            for (const { destination, content } of writes) managedOutputs.set(destination, content);
            process.exitCode = 0;
            log(`Built ${entries.length} file(s); ${result.compiled} compiled, ${result.reused} reused.`);
            lastError = "";
          }
        }
        previous = signature;
        volatileAt = Date.now();
      }
    } catch (cause) { report(cause instanceof Error ? cause.message : String(cause)); }
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, interval);
      const stop = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}
