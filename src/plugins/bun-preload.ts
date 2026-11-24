import { funscriptBunPlugin } from "./bun.js";

type BunGlobal = {
  plugin: (plugin: unknown) => void;
};
declare const Bun: BunGlobal | undefined;
if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin(funscriptBunPlugin());
  try {
    const bunTest = (await import("bun:test")) as unknown as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(bunTest)) {
      if (typeof value === "function" && !(key in globalThis)) {
        (globalThis as Record<string, unknown>)[key] = value;
      }
    }
  } catch {
    // Non-test Bun runtime environment, bun:test may not be needed
  }
}

export { funscriptBunPlugin };
export default funscriptBunPlugin;
