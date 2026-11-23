import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { funscriptBunPlugin, bunPlugin } from "../src/plugins/bun.js";
import defaultPlugin from "../src/plugins/bun.js";

describe("Bun Plugin (bun-plugin-funscript)", () => {
  it("exports funscriptBunPlugin as named and default export", () => {
    expect(typeof funscriptBunPlugin).toBe("function");
    expect(typeof bunPlugin).toBe("function");
    expect(typeof defaultPlugin).toBe("function");
    expect(funscriptBunPlugin).toBe(defaultPlugin);
  });

  it("creates a plugin with correct name and setup hook", () => {
    const plugin = funscriptBunPlugin();
    expect(plugin.name).toBe("bun-plugin-funscript");
    expect(typeof plugin.setup).toBe("function");
  });

  it("registers onResolve and onLoad handlers in setup", () => {
    const plugin = funscriptBunPlugin();
    let registeredResolve = false;
    let registeredLoad = false;

    const mockBuild: any = {
      onResolve: (opts: any, cb: any) => {
        registeredResolve = true;
        expect(opts.filter).toBeDefined();
        expect(typeof cb).toBe("function");
      },
      onLoad: (opts: any, cb: any) => {
        registeredLoad = true;
        expect(opts.filter).toBeDefined();
        expect(typeof cb).toBe("function");
      },
    };

    plugin.setup(mockBuild);
    expect(registeredResolve).toBe(true);
    expect(registeredLoad).toBe(true);
  });

  it("compiles .fun source code to TypeScript in onLoad", async () => {
    const plugin = funscriptBunPlugin();
    let loadHandler: any;

    const mockBuild: any = {
      onResolve: () => {},
      onLoad: (_opts: any, cb: any) => {
        loadHandler = cb;
      },
    };

    plugin.setup(mockBuild);
    expect(loadHandler).toBeDefined();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-plugin-test-"));
    const tempFile = path.join(tempDir, "sample.fun");
    try {
      await fs.writeFile(tempFile, 'export answer = 42\nexport add = (a: Int, b: Int) => a + b');

      const result = await loadHandler({ path: tempFile, namespace: "file", loader: "ts" });
      expect(result).toBeDefined();
      expect(result.loader).toBe("ts");
      expect(result.contents).toContain("export const answer = 42");
      expect(result.contents).toContain("export const add =");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects raw TypeScript when noTs is enabled", async () => {
    let loadHandler: any;
    const plugin = funscriptBunPlugin({ noTs: true });
    plugin.setup({ onResolve: () => {}, onLoad: (_options: any, cb: any) => { loadHandler = cb; } });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "funscript-no-ts-bun-"));
    try {
      const file = path.join(dir, "example.fun");
      await fs.writeFile(file, "ts { const x = 1; }");
      await expect(loadHandler({ path: file, namespace: "file", loader: "ts" })).rejects.toThrow("TypeScript escapes are disabled by --no-ts");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves companion .fun file when .js is imported", async () => {
    const plugin = funscriptBunPlugin();
    let resolveHandler: any;

    const mockBuild: any = {
      onResolve: (_opts: any, cb: any) => {
        resolveHandler = cb;
      },
      onLoad: () => {},
    };

    plugin.setup(mockBuild);
    expect(resolveHandler).toBeDefined();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-plugin-res-"));
    const funFile = path.join(tempDir, "helper.fun");
    const importer = path.join(tempDir, "index.ts");
    try {
      await fs.writeFile(funFile, "export helper = 1");

      const resolved = await resolveHandler({
        path: "./helper.js",
        importer,
        namespace: "file",
        resolveDir: tempDir,
      });

      expect(resolved).toBeDefined();
      expect(resolved.path).toBe(funFile);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("enforces server boundary restrictions in onResolve", async () => {
    let resolveHandler: any;
    const plugin = funscriptBunPlugin({ serverBoundary: true });

    const mockBuild: any = {
      onResolve: (_opts: any, cb: any) => {
        resolveHandler = cb;
      },
      onLoad: () => {},
    };

    await plugin.setup(mockBuild);
    expect(resolveHandler).toBeDefined();

    expect(() =>
      resolveHandler({
        path: "./database.server.fun",
        importer: "/project/src/ClientComponent.funx",
        namespace: "file",
        resolveDir: "/project/src",
      }),
    ).toThrow("Server module './database.server.fun' cannot be imported into client module");
  });

  it("generates and updates TypeView when types option is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-plugin-types-"));
    const typesDir = path.join(tempDir, ".funscript", "types");
    const appDir = path.join(tempDir, "app");
    await fs.mkdir(appDir, { recursive: true });

    const funFile = path.join(appDir, "component.funx");
    await fs.writeFile(funFile, "export Button = () => <button>Click</button>");

    const origCwd = process.cwd();
    try {
      process.chdir(tempDir);
      let loadHandler: any;
      const plugin = funscriptBunPlugin({
        types: { include: ["app"], outDir: ".funscript/types" },
      });

      const mockBuild: any = {
        onResolve: () => {},
        onLoad: (_opts: any, cb: any) => {
          loadHandler = cb;
        },
      };

      await plugin.setup(mockBuild);
      await loadHandler({ path: funFile, namespace: "file", loader: "tsx" });

      const compiledTsx = path.join(typesDir, "app", "component.tsx");
      const exists = await fs.stat(compiledTsx).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    } finally {
      process.chdir(origCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
