import { type Plugin, createFilter } from "vite";
import { Effect } from "effect";
import { compileString } from "../compiler.js";
import { TypeView, type TypeViewOptions } from "./type-view.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";

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

export interface FunscriptPluginOptions {
  /**
   * Filter pattern(s) for files to include. Defaults to [/\.fun$/, /\.funx$/].
   */
  include?: string | RegExp | readonly (string | RegExp)[];
  /**
   * Filter pattern(s) for files to exclude.
   */
  exclude?: string | RegExp | readonly (string | RegExp)[];
  /**
   * Whether to generate source maps. Defaults to true.
   */
  sourcemap?: boolean;
  /** Generate a disk-backed type view for tools outside Vite. */
  types?: TypeViewOptions;
  /**
   * Compile-time server/client boundary enforcement.
   * When enabled, prevents server-only modules from accidentally leaking into client-side bundles.
   * Defaults to false.
   */
  serverBoundary?: boolean | ServerBoundaryOptions;
}

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string" ? value.includes(pattern) : pattern.test(value);
}

function matchesAnyPattern(value: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((p) => matchesPattern(value, p));
}

/**
 * Vite & Vitest plugin for FunScript and FunX (.fun, .funx) compilation.
 */
export function funscriptPlugin(options: FunscriptPluginOptions = {}): Plugin {
  const filter = createFilter(
    options.include ?? [/\.fun$/, /\.funx$/],
    options.exclude,
  );

  let typeView: TypeView | undefined;
  const context = new TypeScriptCompilationContext(path.resolve("__funscript_vite__.fun"));
  return {
    name: "vite-plugin-funscript",
    enforce: "pre",

    async config(config) {
      const rootDir = path.resolve(config.root ?? process.cwd());
      if (options.types) {
        typeView = new TypeView(rootDir, options.types);
        await typeView.generate();
      }
      return {
        resolve: {
          extensions: [
            ...(config.resolve?.extensions ?? [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"]),
            ".fun",
            ".funx",
          ],
        },
        esbuild: {
          include: /\.[jt]sx?$|\.funx?$/,
          loader: "tsx",
        },
      };
    },

    async resolveId(source, importer, resolveOptions) {
      const boundaryOption = options.serverBoundary;
      const boundaryEnabled =
        typeof boundaryOption === "boolean"
          ? boundaryOption
          : (boundaryOption ? boundaryOption.enabled !== false : false);

      if (boundaryEnabled && importer && !resolveOptions?.ssr) {
        const serverPatterns =
          (typeof boundaryOption === "object" && boundaryOption?.serverPatterns) ||
          [/\.server(\.|$)/];

        if (matchesAnyPattern(source, serverPatterns)) {
          const isServerImporter = matchesAnyPattern(importer, serverPatterns);
          if (!isServerImporter) {
            const allowedImporters =
              (typeof boundaryOption === "object" && boundaryOption?.allowedImporters) ||
              [];

            const isAllowedImporter = matchesAnyPattern(importer, allowedImporters);
            if (!isAllowedImporter) {
              throw new Error(
                `[vite-plugin-funscript] Server module '${source}' cannot be imported into client module '${importer}'. FunScript enforces strict server/client boundary separation. To permit framework bridge modules (e.g. route loaders), configure 'serverBoundary.allowedImporters' in funscriptPlugin().`,
              );
            }
          }
        }
      }

      if (!importer || !source.endsWith(".js") || (!source.startsWith(".") && !path.isAbsolute(source))) return null;
      const existing = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      if (existing) return existing;
      for (const extension of [".fun", ".funx"]) {
        const resolved = await this.resolve(source.slice(0, -3) + extension, importer, { ...resolveOptions, skipSelf: true });
        if (resolved) return resolved;
      }
      return null;
    },

    configureServer(server) {
      if (!typeView) return;
      const view = typeView;
      let pending = Promise.resolve();
      const enqueue = (work: () => Promise<void>) => {
        pending = pending.then(work).catch((error) => server.config.logger.error(`FunScript type view: ${error.message}`));
      };
      const update = (file: string) => { if (/\.funx?$/.test(file)) enqueue(() => view.refresh(file)); };
      const remove = (file: string) => { if (/\.funx?$/.test(file)) enqueue(() => view.forget(file)); };
      server.watcher.on("add", update).on("change", update).on("unlink", remove);
    },

    async transform(code: string, id: string) {
      const [cleanPath] = id.split("?");
      const cleanId = cleanPath.split("#")[0];

      if (!cleanId.endsWith(".fun") && !cleanId.endsWith(".funx")) {
        return null;
      }

      if (!filter(cleanId) && !filter(id)) {
        return null;
      }

      const res = await Effect.runPromise(
        compileString(code, cleanId, {
          sourcemap: options.sourcemap ?? true,
          context,
        }),
      );

      return {
        code: res.typescript,
        map: (res.sourcemap ?? res.map ?? null) as any,
      };
    },

    handleHotUpdate(ctx) {
      const [cleanPath] = ctx.file.split("?");
      const cleanFile = cleanPath.split("#")[0];
      if (cleanFile.endsWith(".fun") || cleanFile.endsWith(".funx")) {
        return ctx.modules;
      }
    },
  };
}

export const funscript = funscriptPlugin;
export default funscriptPlugin;
