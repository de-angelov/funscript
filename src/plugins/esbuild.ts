import * as Effect from "effect/Effect";
import type { BuildOptions, Plugin, PluginBuild } from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileString } from "../compiler.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  loadProjectConfig,
} from "../compiler/project-config.js";
import type { ServerBoundaryOptions } from "./bun.js";
import { TypeView, type TypeViewOptions } from "./type-view.js";

export { TypeView, type ServerBoundaryOptions, type TypeViewOptions };

export interface EsbuildPluginOptions {
  /** Reject raw TypeScript escapes in compiled FunScript modules. */
  noTs?: boolean;
  noGlobalThis?: boolean;
  barePipelines?: boolean;
  noDeepDestructure?: boolean;
  maxDestructureDepth?: number;
  allowEarlyReturns?: boolean;
  /** Working directory for resolving project configs and files. Defaults to process.cwd(). */
  cwd?: string;
  /** Filter pattern for onResolve/onLoad. Defaults to /\.funx?$/ */
  filter?: RegExp;
  /** Filter pattern(s) for files to include. */
  include?: string | RegExp | readonly (string | RegExp)[];
  /** Filter pattern(s) for files to exclude. */
  exclude?: string | RegExp | readonly (string | RegExp)[];
  /** Whether to generate sourcemaps. Defaults to true. */
  sourcemap?: boolean;
  /** Whether to resolve .js imports to companion .fun or .funx files. Defaults to true. */
  resolveJsToFun?: boolean;
  /** Generate a disk-backed type view for external tools and IDEs. */
  types?: TypeViewOptions;
  /** Compile-time server/client boundary enforcement. */
  serverBoundary?: boolean | ServerBoundaryOptions;
  /** Preloaded virtual sources map (filename -> content). */
  virtualSources?: Map<string, string>;
  /** Automatically append the Effect / main runner snippet to the entry file. */
  runMain?: boolean;
  /** Whether building an executable (also appends the main runner snippet). */
  executable?: boolean;
  /** Explicit entry file for runMain insertion (defaults to the first compiled module). */
  entryFile?: string;
}

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string"
    ? value.includes(pattern)
    : pattern.test(value);
}

function matchesAnyPattern(
  value: string,
  patterns: (string | RegExp)[],
): boolean {
  return patterns.some((p) => matchesPattern(value, p));
}

function isEsbuildEntry(
  filename: string,
  cwd: string,
  entryFile: string | undefined,
  entryPoints: BuildOptions["entryPoints"] | undefined,
): boolean {
  if (entryFile) {
    return filename === path.resolve(cwd, entryFile);
  }
  if (!entryPoints) {
    return false;
  }
  const entries = Array.isArray(entryPoints)
    ? entryPoints.map((entry) => (typeof entry === "string" ? entry : entry.in))
    : Object.values(entryPoints);
  return entries.some((entry) => filename === path.resolve(cwd, entry));
}

/**
 * Official esbuild plugin for FunScript (.fun) and FunX (.funx) compilation.
 * Provides on-the-fly compilation to TypeScript, automatic companion resolution,
 * server/client boundary enforcement, and TypeView .d.ts generation.
 */
export function funscriptEsbuildPlugin(
  options: EsbuildPluginOptions = {},
): Plugin {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectPolicy = loadProjectConfig(cwd);
  const filter = options.filter ?? /\.funx?$/;
  const resolveJsToFun = options.resolveJsToFun ?? true;

  let typeView: TypeView | undefined;
  let typeViewInitPromise: Promise<void> | undefined;

  const ensureTypeView = async () => {
    if (options.types && !typeView) {
      const tv = new TypeView(cwd, options.types);
      typeView = tv;
      typeViewInitPromise = tv.generate().catch((err) => {
        typeView = undefined;
        typeViewInitPromise = undefined;
        throw err;
      });
    }
    if (typeViewInitPromise) {
      await typeViewInitPromise;
    }
  };

  return {
    name: "funscript-esbuild",
    async setup(build: PluginBuild) {
      if (options.types) {
        await ensureTypeView();
      }

      const boundaryOption = options.serverBoundary;
      const boundaryEnabled =
        typeof boundaryOption === "boolean"
          ? boundaryOption
          : boundaryOption
            ? boundaryOption.enabled !== false
            : false;

      const serverPatterns = (typeof boundaryOption === "object" &&
        boundaryOption?.serverPatterns) || [/\.server(\.|$)/];
      const allowedImporters =
        (typeof boundaryOption === "object" &&
          boundaryOption?.allowedImporters) ||
        [];

      build.onResolve({ filter: /.*/ }, async (args) => {
        const specifier = args.path;

        // Check server boundary enforcement
        if (
          boundaryEnabled &&
          args.importer &&
          matchesAnyPattern(specifier, serverPatterns)
        ) {
          const isServerImporter = matchesAnyPattern(
            args.importer,
            serverPatterns,
          );
          if (!isServerImporter) {
            const isAllowedImporter = matchesAnyPattern(
              args.importer,
              allowedImporters,
            );
            if (!isAllowedImporter) {
              return {
                errors: [
                  {
                    text: `[funscript-esbuild] Server module '${specifier}' cannot be imported into client module '${args.importer}'. FunScript enforces strict server/client boundary separation. To permit framework bridge modules (e.g. route loaders), configure 'serverBoundary.allowedImporters' in funscriptEsbuildPlugin().`,
                  },
                ],
              };
            }
          }
        }

        if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
          return undefined;
        }

        const resolveDir =
          args.resolveDir ||
          (args.importer ? path.dirname(args.importer) : cwd);
        const target = path.isAbsolute(specifier)
          ? specifier
          : path.resolve(resolveDir, specifier);

        // If direct .fun / .funx
        if (/\.funx?$/.test(target) && filter.test(target)) {
          return { path: target };
        }

        // If target file already exists as JS/TS, let standard resolver handle it
        if (
          await fs.stat(target).then(
            (s) => s.isFile(),
            () => false,
          )
        ) {
          return undefined;
        }

        // If resolveJsToFun is enabled, check companion .fun/.funx
        if (resolveJsToFun) {
          const stem = target.replace(/\.(?:[cm]?[jt]sx?)$/, "");
          for (const extension of [".fun", ".funx"]) {
            const candidate = stem + extension;
            if (
              await fs.stat(candidate).then(
                (s) => s.isFile(),
                () => false,
              )
            ) {
              return { path: candidate };
            }
          }
        }

        return undefined;
      });

      build.onLoad({ filter }, async (args) => {
        const filename = path.resolve(args.path);

        if (options.include) {
          const includes = Array.isArray(options.include)
            ? options.include
            : [options.include];
          if (!matchesAnyPattern(filename, includes as (string | RegExp)[])) {
            return undefined;
          }
        }

        if (options.exclude) {
          const excludes = Array.isArray(options.exclude)
            ? options.exclude
            : [options.exclude];
          if (matchesAnyPattern(filename, excludes as (string | RegExp)[])) {
            return undefined;
          }
        }

        const source =
          options.virtualSources?.get(filename) ??
          (await fs.readFile(filename, "utf8"));

        const sourcemap =
          options.sourcemap ??
          (build.initialOptions.sourcemap !== false &&
            build.initialOptions.sourcemap !== undefined);

        const result = await Effect.runPromise(
          compileString(source, filename, {
            sourcemap,
            noTs:
              options.noTs ||
              isPathPolicyEnabled(projectPolicy.noTs, cwd, filename),
            noGlobalThis:
              options.noGlobalThis ||
              isPathPolicyEnabled(projectPolicy.noGlobalThis, cwd, filename),
            barePipelines:
              options.barePipelines ||
              isPathPolicyEnabled(projectPolicy.barePipelines, cwd, filename),
            noDeepDestructure:
              options.noDeepDestructure ||
              isPathPolicyEnabled(
                projectPolicy.noDeepDestructure,
                cwd,
                filename,
              ),
            maxDestructureDepth:
              options.maxDestructureDepth ?? projectPolicy.maxDestructureDepth,
            allowEarlyReturns:
              options.allowEarlyReturns ||
              isPathPolicyEnabled(
                projectPolicy.allowEarlyReturns,
                cwd,
                filename,
              ),
            effectOnly: isEffectOnlyFile(projectPolicy, cwd, filename),
            effectOnlyDirectories: projectPolicy.effectOnly,
            policyRoot: cwd,
            virtualSources: options.virtualSources,
          }),
        );

        if (typeView) {
          await typeView.update(filename);
        }

        let contents = result.typescript;
        const isEntry = isEsbuildEntry(
          filename,
          cwd,
          options.entryFile,
          build.initialOptions.entryPoints,
        );
        if ((options.runMain || options.executable) && isEntry) {
          contents = `${contents}\nimport * as __funscript_effect from "effect";\nif (typeof main !== "undefined") {\n  if (__funscript_effect.Effect.isEffect(main)) await __funscript_effect.Effect.runPromise(main);\n  else if (typeof main === "function") await main();\n}\n`;
        }
        const rawMap = result.sourcemap ?? result.map;
        if (sourcemap && rawMap) {
          const encodedMap = Buffer.from(
            JSON.stringify(rawMap),
            "utf8",
          ).toString("base64");
          contents = `${contents}\n//# sourceMappingURL=data:application/json;base64,${encodedMap}\n`;
        }

        return {
          contents,
          loader: filename.endsWith(".funx") ? "tsx" : "ts",
          resolveDir: path.dirname(filename),
        };
      });
    },
  };
}

export default funscriptEsbuildPlugin;
