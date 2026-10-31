import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli/index.js");
const sourceRoots = ["examples", "programs"];
let outputDir: string;

const findFunScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) return findFunScriptFiles(file);
      return entry.isFile() && (file.endsWith(".fun") || file.endsWith(".funx")) ? [file] : [];
    })
  );
  return nested.flat();
};

describe("runnable example applications", () => {
  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "funscript-example-build-"));
  });

  afterAll(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("builds every example application and program through the CLI", async () => {
    const files = (await Promise.all(sourceRoots.map(findFunScriptFiles)))
      .flat()
      .filter((file) => !file.startsWith("examples/fixtures/"))
      .sort();
    const failures: string[] = [];

    const remaining = [...files];
    const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
      while (remaining.length > 0) {
        const file = remaining.shift()!;
        const extension = file.endsWith(".funx") ? ".tsx" : ".ts";
        const output = join(outputDir, `${relative(".", file).replaceAll(/[\\/]/g, "__")}${extension}`);
        try {
          await execFileAsync(process.execPath, [cliPath, "build", file, "--out", output]);
        } catch (error: any) {
          failures.push(`${file}\n${error.stdout ?? ""}${error.stderr ?? ""}`);
        }
      }
    });

    await Promise.all(workers);

    expect(failures).toEqual([]);
  }, 120_000);
});
