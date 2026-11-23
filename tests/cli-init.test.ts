import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Effect } from "effect";
import { initProject, resolveTemplate } from "../src/cli/init.js";

describe("cli/init", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "funscript-init-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("resolveTemplate", () => {
    it("defaults to effect-cli when unspecified", () => {
      expect(resolveTemplate()).toBe("effect-cli");
      expect(resolveTemplate("")).toBe("effect-cli");
    });

    it("resolves alias names", () => {
      expect(resolveTemplate("effect")).toBe("effect-cli");
      expect(resolveTemplate("cli")).toBe("effect-cli");
      expect(resolveTemplate("bun")).toBe("bun-server");
      expect(resolveTemplate("server")).toBe("bun-server");
      expect(resolveTemplate("react")).toBe("vite-react");
      expect(resolveTemplate("solid")).toBe("vite-solid");
    });

    it("returns undefined for unknown templates", () => {
      expect(resolveTemplate("unknown-template")).toBeUndefined();
    });
  });

  describe("initProject", () => {
    it("scaffolds effect-cli template by default", async () => {
      const projectDir = path.join(tmpDir, "my-cli");
      await Effect.runPromise(initProject(projectDir));

      const pkgRaw = await fs.readFile(
        path.join(projectDir, "package.json"),
        "utf8",
      );
      const pkg = JSON.parse(pkgRaw);
      expect(pkg.name).toBe("my-cli");
      expect(pkg.dependencies.effect).toBeDefined();

      const mainFun = await fs.readFile(
        path.join(projectDir, "src/main.fun"),
        "utf8",
      );
      expect(mainFun).toContain("greet");

      const testFun = await fs.readFile(
        path.join(projectDir, "tests/main.test.fun"),
        "utf8",
      );
      expect(testFun).toContain("describe");

      const tsconfig = await fs.readFile(
        path.join(projectDir, "tsconfig.json"),
        "utf8",
      );
      expect(tsconfig).toContain(".funscript/types");

      const readme = await fs.readFile(
        path.join(projectDir, "README.md"),
        "utf8",
      );
      expect(readme).toContain("# my-cli");
    });

    it("scaffolds bun-server template", async () => {
      const projectDir = path.join(tmpDir, "my-server");
      await Effect.runPromise(
        initProject(projectDir, { template: "bun-server" }),
      );

      const bunfig = await fs.readFile(
        path.join(projectDir, "bunfig.toml"),
        "utf8",
      );
      expect(bunfig).toContain('preload = ["funscript/bun"]');

      const serverFun = await fs.readFile(
        path.join(projectDir, "src/index.fun"),
        "utf8",
      );
      expect(serverFun).toContain("handleRequest");

      const serverTest = await fs.readFile(
        path.join(projectDir, "tests/server.test.fun"),
        "utf8",
      );
      expect(serverTest).toContain("handleRequest");
    });

    it("scaffolds vite-react template", async () => {
      const projectDir = path.join(tmpDir, "my-react-app");
      await Effect.runPromise(
        initProject(projectDir, { template: "vite-react" }),
      );

      const viteConfig = await fs.readFile(
        path.join(projectDir, "vite.config.ts"),
        "utf8",
      );
      expect(viteConfig).toContain("funscriptPlugin");
      expect(viteConfig).toContain("@vitejs/plugin-react");

      const appFunx = await fs.readFile(
        path.join(projectDir, "src/App.funx"),
        "utf8",
      );
      expect(appFunx).toContain("export App = ()");

      const indexHtml = await fs.readFile(
        path.join(projectDir, "index.html"),
        "utf8",
      );
      expect(indexHtml).toContain("src/main.tsx");
    });

    it("scaffolds vite-solid template", async () => {
      const projectDir = path.join(tmpDir, "my-solid-app");
      await Effect.runPromise(initProject(projectDir, { template: "solid" }));

      const viteConfig = await fs.readFile(
        path.join(projectDir, "vite.config.ts"),
        "utf8",
      );
      expect(viteConfig).toContain("funscriptPlugin");
      expect(viteConfig).toContain("vite-plugin-solid");

      const appFunx = await fs.readFile(
        path.join(projectDir, "src/App.funx"),
        "utf8",
      );
      expect(appFunx).toContain("export App = ()");
    });

    it("fails when directory is not empty without --force", async () => {
      const projectDir = path.join(tmpDir, "existing-dir");
      await fs.mkdir(projectDir);
      await fs.writeFile(path.join(projectDir, "some-file.txt"), "hello");

      await expect(Effect.runPromise(initProject(projectDir))).rejects.toThrow(
        "Directory is not empty",
      );
    });

    it("succeeds when directory is not empty if --force is set", async () => {
      const projectDir = path.join(tmpDir, "existing-dir");
      await fs.mkdir(projectDir);
      await fs.writeFile(path.join(projectDir, "some-file.txt"), "hello");

      await Effect.runPromise(initProject(projectDir, { force: true }));

      const pkgRaw = await fs.readFile(
        path.join(projectDir, "package.json"),
        "utf8",
      );
      expect(pkgRaw).toBeDefined();
    });

    it("fails when invalid template is provided", async () => {
      const projectDir = path.join(tmpDir, "invalid-template-dir");
      await expect(
        Effect.runPromise(
          initProject(projectDir, { template: "invalid-template-name" }),
        ),
      ).rejects.toThrow("Unknown template");
    });
  });
});
