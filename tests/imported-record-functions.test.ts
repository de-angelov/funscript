import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile, expectCompileError } from "./helpers/index.js";

describe("cross-module optional record forwarding", () => {
  it("uses a direct FunScript export only when JavaScript resolution is unambiguous", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-record-import-"));
    try {
      const reader = path.join(root, "reader.fun");
      const caller = path.join(root, "caller.fun");
      const source = 'import { read } from "./reader.js"\nexport forward = (props: { label?: String }) => read(props)';
      await writeFile(reader, 'export read = (props: { label?: String }) => props.label');
      expect((await compile(source, caller)).typescript).toContain("read(props)");
      await writeFile(path.join(root, "reader.js"), 'export const read = value => value;');
      await expectCompileError(source, /cannot be passed/, caller);
      await rm(path.join(root, "reader.js"));
      await writeFile(path.join(root, "reader.d.ts"), 'export declare const read: (value: unknown) => unknown;');
      await expectCompileError(source, /cannot be passed/, caller);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
