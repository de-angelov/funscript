import { funscriptBunPlugin } from "./bun.js";

type BunGlobal = {
  plugin: (plugin: unknown) => void;
};
declare const Bun: BunGlobal | undefined;
if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin(funscriptBunPlugin());
}

export { funscriptBunPlugin };
export default funscriptBunPlugin;
