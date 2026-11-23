import { funscriptBunPlugin } from "./bun.js";

declare const Bun: any;
if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin(funscriptBunPlugin());
}

export { funscriptBunPlugin };
export default funscriptBunPlugin;
