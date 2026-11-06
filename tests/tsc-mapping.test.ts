import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { TypeView } from "../src/plugins/type-view.js";

const exec = promisify(execFile);

describe("TypeScript project diagnostics", () => {
  it("maps type-view errors to FunScript without changing ordinary TypeScript errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-tsc-map-"));
    try {
      await mkdir(path.join(root, "app"));
      await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, types: [] }, include: ["app/**/*.ts", ".funscript/types/**/*.ts"] }));
      await writeFile(path.join(root, "app/example.fun"), 'export check = (value: Number) =>\n  first = value.toUpperCase()\n  => value.toUpperCase()');
      await writeFile(path.join(root, "app/plain.ts"), 'const value: number = "bad";');
      await new TypeView(root).generate();
      const cli = path.resolve("dist/cli/index.js");
      const result = await exec(process.execPath, [cli, "tsc"], { cwd: root }).then(() => "", (error) => `${error.stdout}${error.stderr}`);
      expect(result).toContain("app/example.fun(2,");
      expect(result).toContain("app/example.fun(3,");
      expect(result).toContain("app/plain.ts(1,");
      expect(result).not.toContain(".funscript/types/app/example.ts(");
      await writeFile(path.join(root, "app/example.fun"), 'export changed = 42');
      const stale = await exec(process.execPath, [cli, "tsc"], { cwd: root }).then(() => "", (error) => `${error.stdout}${error.stderr}`);
      expect(stale).toContain(".funscript/types/app/example.ts(");
      expect(stale).not.toContain("app/example.fun(");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
