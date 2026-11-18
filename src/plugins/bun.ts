import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileString } from "../compiler.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";

export interface BunPluginOptions {
  /**
   * Filter pattern for files to compile.
   * Defaults to /\.funx?$/
   */
  filter?: RegExp;
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
}

export interface BunPluginBuilder {
  onLoad(
    args: { filter: RegExp; namespace?: string },
    callback: (args: { path: string; namespace: string; loader: string }) =>
      | { contents?: string; loader?: "js" | "jsx" | "ts" | "tsx" | "json" | "toml" | "text" | "wasm" | "napi"; exports?: Record<string, any> }
      | Promise<{ contents?: string; loader?: "js" | "jsx" | "ts" | "tsx" | "json" | "toml" | "text" | "wasm" | "napi"; exports?: Record<string, any> }>,
  ): void;
  onResolve(
    args: { filter: RegExp; namespace?: string },
    callback: (args: { path: string; importer: string; namespace: string; resolveDir: string }) =>
      | { path?: string; namespace?: string; external?: boolean }
      | undefined
      | Promise<{ path?: string; namespace?: string; external?: boolean } | undefined>,
  ): void;
  config?: any;
}

export interface BunPlugin {
  name: string;
  setup(build: BunPluginBuilder): void | Promise<void>;
}

/**
 * Bun runtime loader plugin for FunScript and FunX (.fun, .funx) compilation.
 * Compiles FunScript in-memory directly to TypeScript for Bun's JavaScriptCore runtime.
 */
export function funscriptBunPlugin(options: BunPluginOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.funx?$/;
  const resolveJsToFun = options.resolveJsToFun ?? true;
  const context = new TypeScriptCompilationContext(path.resolve("__funscript_bun__.fun"));

  return {
    name: "bun-plugin-funscript",
    setup(build: BunPluginBuilder) {
      if (resolveJsToFun) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (!args.path.endsWith(".js") && !args.path.endsWith(".jsx")) {
            return undefined;
          }
          if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) {
            return undefined;
          }
          const dir = args.importer ? path.dirname(args.importer) : args.resolveDir || process.cwd();
          const target = path.isAbsolute(args.path) ? args.path : path.resolve(dir, args.path);
          const base = target.slice(0, target.lastIndexOf("."));

          for (const ext of [".fun", ".funx"]) {
            const candidate = base + ext;
            if (fs.existsSync(candidate)) {
              return { path: candidate };
            }
          }
          return undefined;
        });
      }

      build.onLoad({ filter }, async (args) => {
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
            sourcemap: options.sourcemap ?? true,
            context,
          }),
        );

        return {
          contents: res.typescript,
          loader,
        };
      });
    },
  };
}

// Auto-register when imported in a Bun environment (e.g. via bunfig.toml `preload = ["funscript/bun"]`)
declare const Bun: any;
if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin(funscriptBunPlugin());
}

export const bunPlugin = funscriptBunPlugin;
export default funscriptBunPlugin;
