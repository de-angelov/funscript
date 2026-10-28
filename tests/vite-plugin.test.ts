import { describe, it, expect } from "vitest";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { createServer } from "vite";
import { funscriptPlugin } from "../src/plugins/vite.js";
import defaultPlugin from "../src/plugins/vite.js";

describe("Vite & Vitest Plugin (vite-plugin-funscript)", () => {
  it("exports funscriptPlugin as named and default export", () => {
    expect(typeof funscriptPlugin).toBe("function");
    expect(typeof defaultPlugin).toBe("function");
    expect(funscriptPlugin).toBe(defaultPlugin);
  });

  it("exports ./vite entry point matching package.json exports", async () => {
    const pkgExport = await import("funscript/vite");
    expect(typeof pkgExport.funscriptPlugin).toBe("function");
    expect(typeof pkgExport.default).toBe("function");
  });

  it("creates a plugin with correct name and enforce: 'pre'", () => {
    const plugin = funscriptPlugin();
    expect(plugin.name).toBe("vite-plugin-funscript");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.transform).toBe("function");
  });

  describe("File Transformation (transform hook)", () => {
    it("transforms .fun files into valid TypeScript with attached source maps", async () => {
      const plugin = funscriptPlugin();
      const code = `
export add = (a: Int, b: Int) => a + b
export greeting = "hello world"
`.trim();

      const transformFn = plugin.transform as Function;
      const result = await transformFn.call({}, code, "/src/math.fun");

      expect(result).toBeDefined();
      expect(result.code).toContain(
        "export const add = (a: Int, b: Int) => (a + b);",
      );
      expect(result.code).toContain('export const greeting = "hello world";');

      // Verify attached source map
      expect(result.map).toBeDefined();
      expect(result.map.version).toBe(3);
      expect(result.map.sources).toEqual(["math.fun"]);
      expect(typeof result.map.mappings).toBe("string");
      expect(result.map.mappings.length).toBeGreaterThan(0);

      // Verify source map trace
      const tracer = new TraceMap(result.map);
      const lines = result.code.split("\n");
      const addLineIndex = lines.findIndex((l: string) =>
        l.includes("const add ="),
      );
      expect(addLineIndex).toBeGreaterThanOrEqual(0);

      const pos = originalPositionFor(tracer, {
        line: addLineIndex + 1,
        column: 0,
      });
      expect(pos.source).toBe("math.fun");
      expect(pos.line).toBe(1);
    });

    it("transforms .funx files into valid TSX with standard JSX intact and attached source maps", async () => {
      const plugin = funscriptPlugin();
      const code = `
export Button = (props: Props) -> <button className="btn">{props.label}</button>
`.trim();

      const transformFn = plugin.transform as Function;
      const result = await transformFn.call(
        {},
        code,
        "/src/components/Button.funx",
      );

      expect(result).toBeDefined();
      expect(result.code).toContain(
        'export const Button = (props: Props) => <button className="btn">{props.label}</button>;',
      );
      expect(result.map).toBeDefined();
      expect(result.map.sources).toEqual(["Button.funx"]);

      const tracer = new TraceMap(result.map);
      const pos = originalPositionFor(tracer, {
        line: 1,
        column: 0,
      });
      expect(pos.source).toBe("Button.funx");
    });

    it("ignores non-FunScript files (.ts, .js, .css, etc.)", async () => {
      const plugin = funscriptPlugin();
      const transformFn = plugin.transform as Function;

      const tsResult = await transformFn.call(
        {},
        "const x: number = 42;",
        "/src/main.ts",
      );
      expect(tsResult).toBeNull();

      const jsResult = await transformFn.call(
        {},
        "console.log('test')",
        "/src/main.js",
      );
      expect(jsResult).toBeNull();

      const cssResult = await transformFn.call(
        {},
        "body { margin: 0; }",
        "/src/style.css",
      );
      expect(cssResult).toBeNull();
    });

    it("handles query strings and hashes in file IDs", async () => {
      const plugin = funscriptPlugin();
      const code = `export value = 123`;
      const transformFn = plugin.transform as Function;

      const result = await transformFn.call(
        {},
        code,
        "/src/data.fun?v=12345#header",
      );
      expect(result).toBeDefined();
      expect(result.code).toContain("export const value = 123;");
      expect(result.map).toBeDefined();
    });

    it("respects sourcemap: false option", async () => {
      const plugin = funscriptPlugin({ sourcemap: false });
      const code = `export value = 100`;
      const transformFn = plugin.transform as Function;

      const result = await transformFn.call({}, code, "/src/test.fun");
      expect(result).toBeDefined();
      expect(result.code).toContain("export const value = 100;");
      expect(result.map).toBeNull();
    });

    it("respects custom exclude filter option", async () => {
      const plugin = funscriptPlugin({
        exclude: [/\/ignored\//, /\.skip\.fun$/],
      });
      const code = `export val = 1`;
      const transformFn = plugin.transform as Function;

      const ignoredResult = await transformFn.call(
        {},
        code,
        "/src/ignored/math.fun",
      );
      expect(ignoredResult).toBeNull();

      const skipResult = await transformFn.call({}, code, "/src/test.skip.fun");
      expect(skipResult).toBeNull();

      const normalResult = await transformFn.call({}, code, "/src/normal.fun");
      expect(normalResult).toBeDefined();
    });

    it("respects custom include filter option", async () => {
      const plugin = funscriptPlugin({
        include: [/\/custom\/.*\.fun$/],
      });
      const code = `export val = 1`;
      const transformFn = plugin.transform as Function;

      const includedResult = await transformFn.call(
        {},
        code,
        "/custom/math.fun",
      );
      expect(includedResult).toBeDefined();

      const otherResult = await transformFn.call({}, code, "/other/math.fun");
      expect(otherResult).toBeNull();
    });

    it("throws/rejects on FunScript syntax errors during transform", async () => {
      const plugin = funscriptPlugin();
      const badCode = `let x = 10`; // Invalid FunScript syntax
      const transformFn = plugin.transform as Function;

      await expect(
        transformFn.call({}, badCode, "/src/bad.fun"),
      ).rejects.toThrow();
    });
  });

  describe("HMR & Hot Update (handleHotUpdate hook)", () => {
    it("returns context modules for .fun and .funx files", () => {
      const plugin = funscriptPlugin();
      const handleHotUpdate = plugin.handleHotUpdate as Function;
      expect(typeof handleHotUpdate).toBe("function");

      const mockModules = [{ id: "/src/main.fun" }];
      const funCtx = {
        file: "/src/main.fun",
        modules: mockModules,
      };
      expect(handleHotUpdate(funCtx)).toEqual(mockModules);

      const funxCtx = {
        file: "/src/Button.funx?t=123",
        modules: mockModules,
      };
      expect(handleHotUpdate(funxCtx)).toEqual(mockModules);

      const tsCtx = {
        file: "/src/main.ts",
        modules: mockModules,
      };
      expect(handleHotUpdate(tsCtx)).toBeUndefined();
    });
  });

  describe("Vite Dev Server Integration", () => {
    it("transforms .fun files within Vite dev server transformRequest", async () => {
      const plugin = funscriptPlugin();

      const virtualModules: Record<string, string> = {
        "/src/math.fun": "export double = (n: Int) => n * 2",
        "/src/constants.fun": "export pi = 3.14159",
      };

      const server = await createServer({
        root: ".",
        server: { port: 0 },
        plugins: [
          plugin,
          {
            name: "test-virtual-loader",
            resolveId(id) {
              if (id in virtualModules) return id;
            },
            load(id) {
              if (id in virtualModules) return virtualModules[id];
            },
          },
        ],
      });

      try {
        const mathResult = await server.transformRequest("/src/math.fun");
        expect(mathResult).toBeDefined();
        expect(mathResult?.code).toContain(
          "export const double = (n: Int) => (n * 2);",
        );
        expect(mathResult?.map).toBeDefined();

        const constResult = await server.transformRequest("/src/constants.fun");
        expect(constResult).toBeDefined();
        expect(constResult?.code).toContain("export const pi = 3.14159;");
      } finally {
        await server.close();
      }
    });
  });
});
