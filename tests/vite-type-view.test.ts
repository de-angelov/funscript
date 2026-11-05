import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { build, createServer } from "vite";
import { TypeView } from "../src/plugins/type-view.js";
import { funscriptPlugin } from "../src/plugins/vite.js";

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "fun-type-view-"));
  roots.push(root);
  await mkdir(path.join(root, "app"));
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Vite type view", () => {
  it("lets TypeScript infer a FunScript route's default and named exports from the generated cache", async () => {
    const root = await project();
    await writeFile(path.join(root, "app/route.funx"), 'export loader = () => 42\nexport Page = () => <div />\nexport default Page');
    await writeFile(path.join(root, "app/test.ts"), 'import Page, { loader } from "./route.funx"; const n: number = loader(); const s: string = loader(); void Page;');
    await writeFile(path.join(root, "app/jsx.d.ts"), 'declare namespace JSX { interface IntrinsicElements { div: {} } }');
    await new TypeView(root).generate();
    const opts: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowArbitraryExtensions: true, rootDirs: [root, path.join(root, ".funscript/types")] };
    const program = ts.createProgram([path.join(root, "app/test.ts"), path.join(root, "app/jsx.d.ts")], opts);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((d) => d.code)).toContain(2322);
    expect(diagnostics.map((d) => d.code)).not.toContain(2307);
    expect(diagnostics.map((d) => d.code)).not.toContain(1192);
    expect(await readFile(path.join(root, ".funscript/types/app/route.d.funx.ts"), "utf8")).toContain('export { default }');
  });

  it("resolves generated imports from the original source location before falling back to the cache", async () => {
    const root = await project();
    await writeFile(path.join(root, "app/main.fun"), 'import { other } from "./real.js"\nimport { value } from "./dependency.js"\nexport result = other\nexport count = value');
    await writeFile(path.join(root, "app/real.js"), 'export const other = "real";');
    await writeFile(path.join(root, "app/real.d.ts"), 'export declare const other: string;');
    await writeFile(path.join(root, "app/real.fun"), "export other = 999");
    await writeFile(path.join(root, "app/dependency.fun"), "export value = 42");
    await writeFile(path.join(root, "app/test.ts"), 'import { result, count } from "./main.fun"; const text: string = result; const n: number = count;');
    await new TypeView(root).generate();
    const opts: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowArbitraryExtensions: true, rootDirs: [root, path.join(root, ".funscript/types")] };
    const program = ts.createProgram([path.join(root, "app/test.ts")], opts);
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  });

  it("keeps the cache up to date and removes only known generated files", async () => {
    const root = await project();
    const file = path.join(root, "app/data.fun");
    await writeFile(file, "export value = 1");
    const view = new TypeView(root);
    await view.generate();
    await writeFile(file, "export value = 2");
    await view.update(file);
    expect(await readFile(path.join(root, ".funscript/types/app/data.ts"), "utf8")).toContain("value = 2");
    await view.remove(file);
    await expect(readFile(path.join(root, ".funscript/types/app/data.ts"), "utf8")).rejects.toThrow();
  });

  it("invalidates stale types when a changed source no longer compiles", async () => {
    const root = await project();
    const file = path.join(root, "app/broken.fun");
    await writeFile(file, "export value = 1");
    const view = new TypeView(root);
    await view.generate();
    await writeFile(file, "export =");
    await expect(view.refresh(file)).rejects.toThrow();
    await expect(readFile(path.join(root, ".funscript/types/app/broken.d.fun.ts"), "utf8")).rejects.toThrow();
  });

  it("removes stale generated files after restarting the type view", async () => {
    const root = await project();
    const file = path.join(root, "app/deleted.fun");
    await writeFile(file, "export value = 1");
    await new TypeView(root).generate();
    await rm(file);
    await new TypeView(root).generate();
    await expect(readFile(path.join(root, ".funscript/types/app/deleted.d.fun.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects colliding FunScript filenames before overwriting the type view", async () => {
    const root = await project();
    await writeFile(path.join(root, "app/page.fun"), "export value = 1");
    await writeFile(path.join(root, "app/page.funx"), "export value = 2");
    await expect(new TypeView(root).generate()).rejects.toThrow("cannot represent both");
  });

  it("detects default exports inside legacy TypeScript blocks", async () => {
    const root = await project();
    await writeFile(path.join(root, "app/legacy.funx"), 'ts { export default function Legacy() { return null; } }');
    await new TypeView(root).generate();
    expect(await readFile(path.join(root, ".funscript/types/app/legacy.d.funx.ts"), "utf8")).toContain("export { default }");
  });

  it("refreshes the generated view when Vite observes source edits and deletion", async () => {
    const root = await project();
    const file = path.join(root, "app/live.fun");
    const generated = path.join(root, ".funscript/types/app/live.ts");
    await writeFile(file, "export value = 1");
    const server = await createServer({ configFile: false, root, logLevel: "silent", plugins: [funscriptPlugin({ types: {} })], server: { watch: { ignored: ["**/*"] } } });
    const eventually = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("type view was not updated");
    };
    try {
      await writeFile(file, "export value = 2");
      server.watcher.emit("change", file);
      await eventually(async () => (await readFile(generated, "utf8")).includes("value = 2"));
      await rm(file);
      server.watcher.emit("unlink", file);
      await eventually(async () => readFile(generated, "utf8").then(() => false, () => true));
    } finally {
      await server.close();
    }
  });

  it("builds .js-style imports from FunScript and preserves real JavaScript imports", async () => {
    const root = await project();
    await writeFile(path.join(root, "app/main.fun"), 'import { value } from "./dependency.js"\nimport { other } from "./real.js"\nexport result = value + other');
    await writeFile(path.join(root, "app/dependency.fun"), "export value = 40");
    await writeFile(path.join(root, "app/real.js"), "export const other = 2;");
    await writeFile(path.join(root, "app/real.fun"), "export other = 999");
    const result = await build({ configFile: false, root, logLevel: "silent", plugins: [funscriptPlugin({ types: {} })], build: { lib: { entry: path.join(root, "app/main.fun"), formats: ["es"], fileName: "entry" }, write: false, minify: false } });
    const output = Array.isArray(result) ? result[0].output : result.output;
    const code = output.find((item) => item.type === "chunk");
    expect(code && code.type === "chunk" && code.code).not.toContain("999");
    expect(await readFile(path.join(root, ".funscript/types/app/main.d.fun.ts"), "utf8")).toContain('export * from "./main.js"');
  });
});
