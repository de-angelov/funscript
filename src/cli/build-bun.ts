import * as fs from "node:fs/promises";
import * as path from "node:path";
import { build } from "esbuild";
import { Effect } from "effect";
import { compileString } from "../compiler.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  loadProjectConfig,
} from "../compiler/project-config.js";
import { collectCliFiles } from "./typecheck.js";

export interface BunExecutableOptions {
  cwd?: string;
  sourcemap?: boolean;
  noTs?: boolean;
  noGlobalThis?: boolean;
  noOptional?: boolean;
  barePipelines?: boolean;
}

interface BundleOptions extends BunExecutableOptions {
  executable: boolean;
  runMain?: boolean;
}

async function bundleFunScriptEntry(
  entryFile: string,
  outfile: string,
  options: BundleOptions,
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const entry = path.resolve(cwd, entryFile);
  const projectPolicy = loadProjectConfig(cwd);
  const graphFiles = await Effect.runPromise(collectCliFiles([entry], { cwd }));
  const virtualSources = new Map<string, string>();
  for (const file of graphFiles)
    virtualSources.set(path.resolve(file), await fs.readFile(file, "utf8"));

  await build({
    absWorkingDir: cwd,
    entryPoints: [entry],
    outfile: path.resolve(cwd, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "esnext",
    packages: "external",
    sourcemap: options.sourcemap ? "linked" : false,
    banner: options.executable ? { js: "#!/usr/bin/env bun" } : undefined,
    plugins: [
      {
        name: "funscript-bun-executable",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            const specifier = args.path;
            if (!specifier.startsWith(".") && !path.isAbsolute(specifier))
              return undefined;

            const target = path.resolve(
              args.resolveDir || path.dirname(args.importer || entry),
              specifier,
            );
            if (/\.funx?$/.test(target)) return { path: target };
            if (
              await fs.stat(target).then(
                (stat) => stat.isFile(),
                () => false,
              )
            )
              return undefined;

            const stem = target.replace(/\.(?:[cm]?[jt]sx?)$/, "");
            for (const extension of [".fun", ".funx"]) {
              const candidate = stem + extension;
              if (
                await fs.stat(candidate).then(
                  (stat) => stat.isFile(),
                  () => false,
                )
              )
                return { path: candidate };
            }
            return undefined;
          });

          builder.onLoad({ filter: /\.funx?$/ }, async (args) => {
            const filename = path.resolve(args.path);
            const source =
              virtualSources.get(filename) ??
              (await fs.readFile(filename, "utf8"));
            const result = await Effect.runPromise(
              compileString(source, filename, {
                sourcemap: false,
                noTs:
                  options.noTs ||
                  isPathPolicyEnabled(projectPolicy.noTs, cwd, filename),
                noGlobalThis:
                  options.noGlobalThis ||
                  isPathPolicyEnabled(
                    projectPolicy.noGlobalThis,
                    cwd,
                    filename,
                  ),
                noOptional:
                  options.noOptional ||
                  isPathPolicyEnabled(projectPolicy.noOptional, cwd, filename),
                barePipelines:
                  options.barePipelines ||
                  isPathPolicyEnabled(
                    projectPolicy.barePipelines,
                    cwd,
                    filename,
                  ),
                effectOnly: isEffectOnlyFile(projectPolicy, cwd, filename),
                effectOnlyDirectories: projectPolicy.effectOnly,
                policyRoot: cwd,
                virtualSources,
              }),
            );
            const contents =
              options.runMain && filename === entry
                ? `${result.typescript}\nimport * as __funscript_effect from "effect";\nif (typeof main !== "undefined") {\n  if (__funscript_effect.Effect.isEffect(main)) await __funscript_effect.Effect.runPromise(main);\n  else if (typeof main === "function") await main();\n}\n`
                : result.typescript;
            return {
              contents,
              loader: filename.endsWith(".funx") ? "tsx" : "ts",
              resolveDir: path.dirname(filename),
            };
          });
        },
      },
    ],
  });

  if (options.executable) await fs.chmod(path.resolve(cwd, outfile), 0o755);
}

/** Bundle a FunScript entry and its local modules as a Bun-runnable executable. */
export async function buildBunExecutable(
  entryFile: string,
  outfile: string,
  options: BunExecutableOptions = {},
): Promise<void> {
  return bundleFunScriptEntry(entryFile, outfile, {
    ...options,
    executable: true,
  });
}

/** Bundle a runnable FunScript entry and its local modules for the Node-based run command. */
export async function buildRunBundle(
  entryFile: string,
  outfile: string,
  options: BunExecutableOptions = {},
): Promise<void> {
  return bundleFunScriptEntry(entryFile, outfile, {
    ...options,
    executable: false,
    runMain: true,
  });
}
