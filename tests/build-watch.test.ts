import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchBuild } from "../src/cli/build-watch.js";

describe("watch builds", () => {
  it("rebuilds affected files, keeps previous output on errors, and recovers", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-watch-"));
    const src = path.join(cwd, "src");
    const out = path.join(cwd, "out");
    mkdirSync(src);
    const a = path.join(src, "a.fun");
    const b = path.join(src, "b.fun");
    writeFileSync(a, "export value = 1\n");
    writeFileSync(b, 'import { value } from "./a.js"\nexport result = value\n');
    const logs: string[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    const running = watchBuild(
      {
        cwd,
        targets: [src],
        outDir: out,
        intervalMs: 50,
        flags: { noTs: false, noGlobalThis: false, barePipelines: false },
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
      },
      controller.signal,
    );
    try {
      await vi.waitFor(
        () => expect(existsSync(path.join(out, "a.ts"))).toBe(true),
        { timeout: 30000 },
      );
      expect(readFileSync(path.join(out, "a.ts"), "utf8")).toContain("1");
      unlinkSync(path.join(out, "a.ts"));
      await vi.waitFor(
        () => expect(existsSync(path.join(out, "a.ts"))).toBe(true),
        { timeout: 30000 },
      );
      writeFileSync(a, "export value = 2\n");
      await vi.waitFor(
        () =>
          expect(readFileSync(path.join(out, "a.ts"), "utf8")).toContain("2"),
        { timeout: 30000 },
      );
      const beforeError = readFileSync(path.join(out, "a.ts"), "utf8");
      writeFileSync(a, "export value =\n");
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
        timeout: 30000,
      });
      expect(readFileSync(path.join(out, "a.ts"), "utf8")).toBe(beforeError);
      writeFileSync(a, "export value = 3\n");
      await vi.waitFor(
        () =>
          expect(readFileSync(path.join(out, "a.ts"), "utf8")).toContain("3"),
        { timeout: 30000 },
      );
      expect(
        logs.filter((value) => value.includes("Built")).length,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      controller.abort();
      await running;
      process.exitCode = 0;
    }
  }, 100000);
  it("detects a package declaration change without a source edit", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "fun-watch-package-"));
    const src = path.join(cwd, "src");
    const out = path.join(cwd, "out");
    const pkg = path.join(cwd, "node_modules", "example-dep");
    mkdirSync(src, { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "example-dep",
        version: "1.0.0",
        main: "index.js",
        types: "index.d.ts",
      }),
    );
    writeFileSync(
      path.join(pkg, "index.js"),
      "exports.accept = value => value;",
    );
    const declaration = path.join(pkg, "index.d.ts");
    writeFileSync(
      declaration,
      "export function accept(value: number): number;",
    );
    writeFileSync(
      path.join(src, "a.fun"),
      'import { accept } from "example-dep"\nexport value = accept(1)\n',
    );
    const logs: string[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    const running = watchBuild(
      {
        cwd,
        targets: [src],
        outDir: out,
        intervalMs: 50,
        flags: { noTs: false, noGlobalThis: false, barePipelines: false },
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
      },
      controller.signal,
    );
    try {
      await vi.waitFor(
        () => expect(existsSync(path.join(out, "a.ts"))).toBe(true),
        { timeout: 30000 },
      );
      const before = readFileSync(path.join(out, "a.ts"), "utf8");
      writeFileSync(
        declaration,
        "export function accept(value: string): string;",
      );
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
        timeout: 30000,
      });
      expect(readFileSync(path.join(out, "a.ts"), "utf8")).toBe(before);
      writeFileSync(
        declaration,
        "export function accept(value: number): number;",
      );
      await vi.waitFor(
        () =>
          expect(
            logs.filter((value) => value.includes("Built")).length,
          ).toBeGreaterThanOrEqual(2),
        { timeout: 30000 },
      );
    } finally {
      controller.abort();
      await running;
      process.exitCode = 0;
    }
  }, 100000);
});
