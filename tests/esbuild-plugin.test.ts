import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { funscriptEsbuildPlugin } from "../src/plugins/esbuild.js";
import defaultPlugin from "../src/plugins/esbuild.js";

describe("ESBuild Plugin (funscript-esbuild)", () => {
  it("exports funscriptEsbuildPlugin as named and default export", () => {
    expect(typeof funscriptEsbuildPlugin).toBe("function");
    expect(typeof defaultPlugin).toBe("function");
    expect(funscriptEsbuildPlugin).toBe(defaultPlugin);
  });

  it("creates a plugin with correct name and setup hook", () => {
    const plugin = funscriptEsbuildPlugin();
    expect(plugin.name).toBe("funscript-esbuild");
    expect(typeof plugin.setup).toBe("function");
  });

  it("compiles .fun source code to TypeScript in esbuild", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "esbuild-plugin-test-"),
    );
    const entryFile = path.join(tempDir, "main.fun");
    const outFile = path.join(tempDir, "bundle.js");

    await fs.writeFile(
      entryFile,
      `export add = (a: Int, b: Int) => a + b\n`,
      "utf8",
    );

    const result = await build({
      entryPoints: [entryFile],
      outfile: outFile,
      bundle: true,
      format: "esm",
      plugins: [funscriptEsbuildPlugin({ cwd: tempDir })],
      write: true,
    });

    expect(result.errors.length).toBe(0);
    const output = await fs.readFile(outFile, "utf8");
    expect(output).toContain("add =");
    expect(output).toContain("a + b");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves companion .fun file when .js is imported", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "esbuild-companion-test-"),
    );
    const helperFile = path.join(tempDir, "helper.fun");
    const entryFile = path.join(tempDir, "main.fun");
    const outFile = path.join(tempDir, "bundle.js");

    await fs.writeFile(helperFile, `export answer = 42\n`, "utf8");
    await fs.writeFile(
      entryFile,
      `import { answer } from "./helper.js"\nexport result = answer\n`,
      "utf8",
    );

    const result = await build({
      entryPoints: [entryFile],
      outfile: outFile,
      bundle: true,
      format: "esm",
      plugins: [funscriptEsbuildPlugin({ cwd: tempDir })],
      write: true,
    });

    expect(result.errors.length).toBe(0);
    const output = await fs.readFile(outFile, "utf8");
    expect(output).toContain("42");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("enforces server boundary restrictions in onResolve", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "esbuild-boundary-test-"),
    );
    const serverFile = path.join(tempDir, "db.server.fun");
    const clientFile = path.join(tempDir, "ui.fun");
    const outFile = path.join(tempDir, "bundle.js");

    await fs.writeFile(
      serverFile,
      `export queryDb = (): String => "secret"\n`,
      "utf8",
    );
    await fs.writeFile(
      clientFile,
      `import { queryDb } from "./db.server.fun"\nexport render = queryDb()\n`,
      "utf8",
    );

    let errorThrown = false;
    try {
      await build({
        entryPoints: [clientFile],
        outfile: outFile,
        bundle: true,
        format: "esm",
        plugins: [
          funscriptEsbuildPlugin({
            cwd: tempDir,
            serverBoundary: { enabled: true },
          }),
        ],
        write: false,
      });
    } catch (err: any) {
      errorThrown = true;
      expect(String(err)).toContain("cannot be imported into client module");
    }
    expect(errorThrown).toBe(true);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("generates and updates TypeView when types option is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "esbuild-types-"));
    const typesDir = path.join(tempDir, ".funscript", "types");
    const appDir = path.join(tempDir, "app");
    await fs.mkdir(appDir, { recursive: true });

    const funFile = path.join(appDir, "component.funx");
    await fs.writeFile(
      funFile,
      "export Button = () => <button>Click</button>",
      "utf8",
    );

    const origCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const plugin = funscriptEsbuildPlugin({
        types: { include: ["app"], outDir: ".funscript/types" },
      });

      await build({
        entryPoints: [funFile],
        outfile: path.join(tempDir, "bundle.js"),
        bundle: true,
        format: "esm",
        plugins: [plugin],
        write: true,
      });

      const compiledTsx = path.join(typesDir, "app", "component.tsx");
      const exists = await fs
        .stat(compiledTsx)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    } finally {
      process.chdir(origCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
