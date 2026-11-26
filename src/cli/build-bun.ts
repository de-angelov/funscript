import * as Effect from "effect/Effect";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isFileNotFoundError } from "../errors.js";
import { funscriptEsbuildPlugin } from "../plugins/esbuild.js";
import { collectCliFiles } from "./typecheck.js";

export interface BunExecutableOptions {
  cwd?: string;
  sourcemap?: boolean;
  noTs?: boolean;
  noGlobalThis?: boolean;
  noOptional?: boolean;
  barePipelines?: boolean;
  noDeepDestructure?: boolean;
  maxDestructureDepth?: number;
  /**
   * Bundler engine to use:
   * - "auto": Use native Bun.build if Bun is available, otherwise fall back to esbuild.
   * - "bun": Force native Bun bundler.
   * - "esbuild": Force esbuild-based bundling.
   */
  engine?: "auto" | "bun" | "esbuild";
}

interface BundleOptions extends BunExecutableOptions {
  executable: boolean;
  runMain?: boolean;
}

/** Check if Bun runtime is available (either running under Bun or in PATH). */
export function isBunAvailable(): boolean {
  if (typeof Bun !== "undefined") return true;
  try {
    const res = spawnSync("bun", ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    return false;
  }
}

async function buildWithNativeBun(
  entry: string,
  outfile: string,
  options: BundleOptions,
  cwd: string,
): Promise<void> {
  const targetOut = path.resolve(cwd, outfile);
  const outdir = path.dirname(targetOut);
  const naming = path.basename(targetOut);

  if (typeof Bun !== "undefined") {
    const { funscriptBunPlugin } = await import("../plugins/bun.js");
    const result = await Bun.build({
      entrypoints: [entry],
      outdir,
      naming,
      target: "bun",
      packages: "external",
      sourcemap: options.sourcemap ? "external" : "none",
      plugins: [
        funscriptBunPlugin({
          noTs: options.noTs,
          noGlobalThis: options.noGlobalThis,
          noOptional: options.noOptional,
          barePipelines: options.barePipelines,
          noDeepDestructure: options.noDeepDestructure,
          maxDestructureDepth: options.maxDestructureDepth,
        }) as unknown as NonNullable<
          Parameters<typeof Bun.build>[0]["plugins"]
        >[number],
      ],
    });
    if (!result.success) {
      const messages = result.logs
        .map((log: { message?: string } | string) =>
          typeof log === "string"
            ? log
            : log && typeof log === "object" && typeof log.message === "string"
              ? log.message
              : JSON.stringify(log),
        )
        .join("\n");
      throw new Error(`Bun build failed: ${messages}`);
    }
  } else {
    const currentDir =
      typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
    const bunPluginPath = path.resolve(currentDir, "../plugins/bun.js");
    const runnerScript = `
import { funscriptBunPlugin } from ${JSON.stringify(bunPluginPath)};
const result = await Bun.build({
  entrypoints: [${JSON.stringify(entry)}],
  outdir: ${JSON.stringify(outdir)},
  naming: ${JSON.stringify(naming)},
  target: "bun",
  packages: "external",
  sourcemap: ${options.sourcemap ? '"external"' : '"none"'},
  plugins: [
    funscriptBunPlugin({
      noTs: ${Boolean(options.noTs)},
      noGlobalThis: ${Boolean(options.noGlobalThis)},
      noOptional: ${Boolean(options.noOptional)},
      barePipelines: ${Boolean(options.barePipelines)},
      noDeepDestructure: ${Boolean(options.noDeepDestructure)},
      maxDestructureDepth: ${typeof options.maxDestructureDepth === "number" ? options.maxDestructureDepth : "undefined"},
      runMain: ${Boolean(options.runMain)},
      executable: ${Boolean(options.executable)},
      entryFile: ${JSON.stringify(entry)},
    })
  ]
});
if (!result.success) {
  for (const log of result.logs) console.error(log.message || log);
  process.exit(1);
}
`;
    const res = spawnSync("bun", ["-e", runnerScript], {
      cwd,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      throw new Error(`Native Bun build failed:\n${res.stderr || res.stdout}`);
    }
  }

  let code = await fs.readFile(targetOut, "utf8");
  let modified = false;

  if (options.executable) {
    if (!code.startsWith("#!/usr/bin/env bun")) {
      code = `#!/usr/bin/env bun\n${code}`;
      modified = true;
    }
  }

  if (modified) {
    await fs.writeFile(targetOut, code, "utf8");
  }

  if (options.executable) {
    await fs.chmod(targetOut, 0o755);
  }
}

async function buildWithEsbuild(
  entry: string,
  outfile: string,
  options: BundleOptions,
  cwd: string,
  virtualSources: Map<string, string>,
): Promise<void> {
  const targetOut = path.resolve(cwd, outfile);
  await build({
    absWorkingDir: cwd,
    entryPoints: [entry],
    outfile: targetOut,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "esnext",
    packages: "external",
    sourcemap: options.sourcemap ? "linked" : false,
    banner: options.executable ? { js: "#!/usr/bin/env bun" } : undefined,
    plugins: [
      funscriptEsbuildPlugin({
        cwd,
        sourcemap: options.sourcemap,
        noTs: options.noTs,
        noGlobalThis: options.noGlobalThis,
        noOptional: options.noOptional,
        barePipelines: options.barePipelines,
        noDeepDestructure: options.noDeepDestructure,
        maxDestructureDepth: options.maxDestructureDepth,
        runMain: options.runMain,
        executable: options.executable,
        entryFile: entry,
        virtualSources,
      }),
    ],
  });

  if (options.executable) {
    await fs.chmod(targetOut, 0o755);
  }
}

async function bundleFunScriptEntry(
  entryFile: string,
  outfile: string,
  options: BundleOptions,
): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const entry = path.resolve(cwd, entryFile);
  const engine = options.engine ?? "auto";

  // When engine is "auto" or "bun", attempt fast native Bun build
  if (engine === "bun" || (engine === "auto" && isBunAvailable())) {
    try {
      await buildWithNativeBun(entry, outfile, options, cwd);
      return;
    } catch (error) {
      if (engine === "bun") throw error;
      // When auto, gracefully fallback to esbuild
    }
  }

  const graphFiles = await Effect.runPromise(collectCliFiles([entry], { cwd }));
  const virtualSources = new Map<string, string>();
  for (const file of graphFiles) {
    virtualSources.set(path.resolve(file), await fs.readFile(file, "utf8"));
  }

  await buildWithEsbuild(entry, outfile, options, cwd, virtualSources);
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
