import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile, execute } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import { checkCliFiles, collectCliFiles } from "../src/cli/typecheck.js";
import { checkedSyncVoid, decodeCheckedRecord } from "../src/interop/callback.js";

describe("schema re-exports", () => {
  it("parses, emits and formats named and type-only re-exports", async () => {
    const source = 'export { Country as Nation, type Other } from "./country.js"';
    const result = await compile(source, "barrel.fun");
    expect(result.typescript).toContain('export { Country as Nation, type Other } from "./country.js";');
    expect(format(source)).toBe(source + "\n");
    const only = await compile('export type { Country as Nation } from "./country.js"', "barrel.fun");
    expect(only.typescript).toContain('export type { Country as Nation } from "./country.js";');
    const destructure = await compile('export { a, b } = { a: 1, b: 2 }', "destructure.fun");
    expect(destructure.typescript).toContain("{ a, b }");
  });

  it("resolves named aliases across barrels and checks tagged callback payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-reexport-"));
    try {
      await mkdir(path.join(root, "node_modules"), { recursive: true });
      await symlink(path.resolve("node_modules/effect"), path.join(root, "node_modules/effect"), "dir");
      await symlink(process.cwd(), path.join(root, "node_modules/funscript"), "dir");
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      const files = {
        "country.fun": 'export schema Country = { code: String, likes: Number }',
        "barrel.fun": 'export { Country as Place } from "./country.js"',
        "outer.fun": 'export { Place as Nation } from "./barrel.js"',
        "props.fun": `import { Nation as Local } from "./outer.js"
export schema VoteEvent =
  | Selected(country: Local)
  | Cleared
export schema Props = { onEvent: (event: VoteEvent) => Void }
export decode = (input: Unknown) => PropsDecodeChecked(input)`,
      };
      for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
      const checked = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd: root, compilerOptions: { rootDir: root } }));
      expect(checked.success, checked.formattedOutput).toBe(true);
      const discovered = await Effect.runPromise(collectCliFiles([path.join(root, "props.fun")], { cwd: root }));
      expect(discovered.map(file => path.basename(file)).sort()).toEqual(["barrel.fun", "country.fun", "outer.fun", "props.fun"]);
      expect(await Effect.runPromise(checkCliFiles([path.join(root, "props.fun")], { cwd: root }))).toBe(true);
      const { decode, Selected } = await execute(files["props.fun"], { filename: path.join(root, "props.fun"), scope: { Local: Schema.Struct({ code: Schema.String, likes: Schema.Number }), $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
      const country = { code: "BG", likes: 2 };
      const event = Selected(country);
      let seen: unknown;
      const props = decode({ onEvent: (value: unknown) => { seen = value; } });
      props.onEvent(event);
      expect(seen).toBe(event);
      expect(() => props.onEvent({ _tag: "Selected", country: { code: "BG", likes: "bad" } })).toThrow();
      await writeFile(path.join(root, "barrel.fun"), 'export type { Country as Place } from "./country.js"');
      expect((await compile(files["props.fun"], path.join(root, "props.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
      await writeFile(path.join(root, "barrel.fun"), 'export { type Country as Place } from "./country.js"');
      expect((await compile(files["props.fun"], path.join(root, "props.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
      await writeFile(path.join(root, "barrel.fun"), 'export { Nation as Place } from "./outer.js"');
      expect((await compile(files["props.fun"], path.join(root, "props.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
      await writeFile(path.join(root, "barrel.fun"), 'export { Country as Place } from "./country.js"\nexport { Country as Place } from "./country.js"');
      expect((await compile(files["props.fun"], path.join(root, "props.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
      await writeFile(path.join(root, "barrel.fun"), 'export { Country as Place } from "./country.js"');
      await writeFile(path.join(root, "country.ts"), 'export type Country = { code: string }');
      expect((await compile(files["props.fun"], path.join(root, "props.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
      const ambiguousFiles = await Effect.runPromise(collectCliFiles([path.join(root, "props.fun")], { cwd: root }));
      expect(ambiguousFiles.map(file => path.basename(file))).not.toContain("country.fun");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);
});
