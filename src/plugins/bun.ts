import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileString } from "../compiler.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  loadProjectConfig,
} from "../compiler/project-config.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import { TypeView, type TypeViewOptions } from "./type-view.js";

export { TypeView, type TypeViewOptions };

export interface ServerBoundaryOptions {
  /**
   * Whether to enforce compile-time separation of server modules in client builds.
   * Defaults to false (opt-in).
   */
  enabled?: boolean;
  /**
   * Matchers for server-only modules that must not be bundled into client builds.
   * Defaults to [/\.server(\.|$)/].
   */
  serverPatterns?: (string | RegExp)[];
  /**
   * Matchers for permitted boundary/bridge modules (e.g. route modules in full-stack
   * frameworks) where a framework compiler plugin tree-shakes server code from client outputs.
   * Defaults to [].
   */
  allowedImporters?: (string | RegExp)[];
}

export interface BunPluginOptions {
  /** Reject raw TypeScript escapes in compiled FunScript modules. */
  noTs?: boolean;
  noGlobalThis?: boolean;
  noOptional?: boolean;
  barePipelines?: boolean;
  noDeepDestructure?: boolean;
  maxDestructureDepth?: number;
  allowEarlyReturns?: boolean;
  /**
   * Filter pattern for files to compile.
   * Defaults to /\.funx?$/
   */
  filter?: RegExp;
  /**
   * Filter pattern(s) for files to include.
   */
  include?: string | RegExp | readonly (string | RegExp)[];
  /**
   * Filter pattern(s) for files to exclude.
   */
  exclude?: string | RegExp | readonly (string | RegExp)[];
  /**
   * Whether to generate sourcemaps.
   * Defaults to true.
   */
  sourcemap?: boolean;
  /**
   * Whether to resolve .js imports to .fun or .funx files when a companion exists.
   * Defaults to true.
   */
  resolveJsToFun?: boolean;
  /** Generate a disk-backed type view for tools outside Bun. */
  types?: TypeViewOptions;
  /**
   * Compile-time server/client boundary enforcement.
   * When enabled, prevents server-only modules from accidentally leaking into client-side bundles.
   * Defaults to false.
   */
  serverBoundary?: boolean | ServerBoundaryOptions;
  /** Automatically append the Effect / main runner snippet to the entry file. */
  runMain?: boolean;
  /** Whether building an executable (also appends the main runner snippet). */
  executable?: boolean;
  /** Explicit entry file for runMain insertion (defaults to the first compiled module). */
  entryFile?: string;
}

export interface BunPluginBuilder {
  onLoad(
    args: { filter: RegExp; namespace?: string },
    callback: (args: { path: string; namespace: string; loader: string }) =>
      | {
          contents?: string;
          loader?:
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "json"
            | "toml"
            | "text"
            | "wasm"
            | "napi";
          exports?: Record<string, unknown>;
        }
      | Promise<
          | {
              contents?: string;
              loader?:
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "json"
                | "toml"
                | "text"
                | "wasm"
                | "napi";
              exports?: Record<string, unknown>;
            }
          | undefined
        >,
  ): void;
  onResolve(
    args: { filter: RegExp; namespace?: string },
    callback: (args: {
      path: string;
      importer: string;
      namespace: string;
      resolveDir: string;
    }) =>
      | { path?: string; namespace?: string; external?: boolean }
      | undefined
      | Promise<
          { path?: string; namespace?: string; external?: boolean } | undefined
        >,
  ): void;
  config?: unknown;
}

export interface BunPlugin {
  name: string;
  setup(build: BunPluginBuilder): void | Promise<void>;
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

/**
 * Bun runtime loader plugin for FunScript and FunX (.fun, .funx) compilation.
 * Compiles FunScript in-memory directly to TypeScript for Bun's JavaScriptCore runtime,
 * with full parity to the Vite plugin (TypeView .d.ts generation, server boundaries, and resolution).
 */
export function funscriptBunPlugin(options: BunPluginOptions = {}): BunPlugin {
  const projectPolicy = loadProjectConfig(process.cwd());
  const filter = options.filter ?? /\.funx?$/;
  const resolveJsToFun = options.resolveJsToFun ?? true;
  const context = new TypeScriptCompilationContext(
    path.resolve("__funscript_bun__.fun"),
  );

  let typeView: TypeView | undefined;
  let typeViewInitPromise: Promise<void> | undefined;

  const ensureTypeView = async () => {
    if (options.types && !typeView) {
      typeView = new TypeView(process.cwd(), options.types);
      typeViewInitPromise = typeView.generate();
    }
    if (typeViewInitPromise) {
      await typeViewInitPromise;
    }
  };

  return {
    name: "bun-plugin-funscript",
    async setup(build: BunPluginBuilder) {
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

      if (boundaryEnabled || resolveJsToFun) {
        const serverPatterns = (typeof boundaryOption === "object" &&
          boundaryOption?.serverPatterns) || [/\.server(\.|$)/];
        const allowedImporters =
          (typeof boundaryOption === "object" &&
            boundaryOption?.allowedImporters) ||
          [];

        build.onResolve({ filter: /.*/ }, (args) => {
          if (
            boundaryEnabled &&
            args.importer &&
            matchesAnyPattern(args.path, serverPatterns)
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
                throw new Error(
                  `[bun-plugin-funscript] Server module '${args.path}' cannot be imported into client module '${args.importer}'. FunScript enforces strict server/client boundary separation. To permit framework bridge modules (e.g. route loaders), configure 'serverBoundary.allowedImporters' in funscriptBunPlugin().`,
                );
              }
            }
          }

          if (resolveJsToFun) {
            if (!args.path.endsWith(".js") && !args.path.endsWith(".jsx")) {
              return undefined;
            }
            if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) {
              return undefined;
            }
            const dir = args.importer
              ? path.dirname(args.importer)
              : args.resolveDir || process.cwd();
            const target = path.isAbsolute(args.path)
              ? args.path
              : path.resolve(dir, args.path);
            const base = target.slice(0, target.lastIndexOf("."));

            for (const ext of [".fun", ".funx"]) {
              const candidate = base + ext;
              if (fs.existsSync(candidate)) {
                return { path: candidate };
              }
            }
          }

          return undefined;
        });
      }

      build.onLoad({ filter }, async (args) => {
        if (options.include) {
          const includes = Array.isArray(options.include)
            ? options.include
            : [options.include];
          if (!matchesAnyPattern(args.path, includes as (string | RegExp)[])) {
            return undefined;
          }
        }

        if (options.exclude) {
          const excludes = Array.isArray(options.exclude)
            ? options.exclude
            : [options.exclude];
          if (matchesAnyPattern(args.path, excludes as (string | RegExp)[])) {
            return undefined;
          }
        }

        let text: string;
        if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
          text = await Bun.file(args.path).text();
        } else {
          text = await fs.promises.readFile(args.path, "utf-8");
        }

        const isFunx = args.path.endsWith(".funx");
        const loader = isFunx ? "tsx" : "ts";

        const res = await Effect.runPromise(
          compileString(text, args.path, {
            noTs:
              options.noTs ||
              isPathPolicyEnabled(projectPolicy.noTs, process.cwd(), args.path),
            noGlobalThis:
              options.noGlobalThis ||
              isPathPolicyEnabled(
                projectPolicy.noGlobalThis,
                process.cwd(),
                args.path,
              ),
            noOptional:
              options.noOptional ||
              isPathPolicyEnabled(
                projectPolicy.noOptional,
                process.cwd(),
                args.path,
              ),
            barePipelines:
              options.barePipelines ||
              isPathPolicyEnabled(
                projectPolicy.barePipelines,
                process.cwd(),
                args.path,
              ),
            noDeepDestructure:
              options.noDeepDestructure ||
              isPathPolicyEnabled(
                projectPolicy.noDeepDestructure,
                process.cwd(),
                args.path,
              ),
            maxDestructureDepth:
              options.maxDestructureDepth ?? projectPolicy.maxDestructureDepth,
            allowEarlyReturns:
              options.allowEarlyReturns ||
              isPathPolicyEnabled(
                projectPolicy.allowEarlyReturns,
                process.cwd(),
                args.path,
              ),
            effectOnly: isEffectOnlyFile(
              projectPolicy,
              process.cwd(),
              args.path,
            ),
            effectOnlyDirectories: projectPolicy.effectOnly,
            policyRoot: process.cwd(),
            sourcemap: options.sourcemap ?? true,
            context,
          }),
        );

        if (options.types) {
          await ensureTypeView();
          if (typeView) {
            await typeView.update(args.path);
          }
        }

        let contents = res.typescript;
        const isEntry = options.entryFile
          ? path.resolve(args.path) === path.resolve(options.entryFile)
          : typeof process !== "undefined" && process.argv?.[1]
            ? path.resolve(args.path) === path.resolve(process.argv[1])
            : true;
        const shouldRunMain =
          options.runMain ||
          options.executable ||
          (options.runMain !== false &&
            typeof process !== "undefined" &&
            process.argv?.[1] &&
            path.resolve(args.path) === path.resolve(process.argv[1]));
        if (shouldRunMain && isEntry) {
          contents = `${contents}\nimport * as __funscript_effect from "effect";\nif (typeof main !== "undefined") {\n  if (__funscript_effect.Effect.isEffect(main)) await __funscript_effect.Effect.runPromise(main);\n  else if (typeof main === "function") await main();\n}\n`;
        }

        return {
          contents,
          loader,
        };
      });
    },
  };
}

// Auto-register when imported in a Bun environment (e.g. via bunfig.toml `preload = ["funscript/bun"]`)
type BunGlobal = {
  file: (path: string) => { text: () => Promise<string> };
  plugin: (plugin: unknown) => void;
};
declare const Bun: BunGlobal | undefined;
if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin(funscriptBunPlugin());
}

export const bunPlugin = funscriptBunPlugin;
export default funscriptBunPlugin;
