import { type Plugin, createFilter } from "vite";
import { Effect } from "effect";
import { compileString } from "../compiler.js";

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
}

/**
 * Vite & Vitest plugin for FunScript and FunX (.fun, .funx) compilation.
 */
export function funscriptPlugin(options: FunscriptPluginOptions = {}): Plugin {
  const filter = createFilter(
    options.include ?? [/\.fun$/, /\.funx$/],
    options.exclude,
  );

  return {
    name: "vite-plugin-funscript",
    enforce: "pre",

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

export default funscriptPlugin;
