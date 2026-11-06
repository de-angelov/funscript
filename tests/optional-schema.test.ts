import { describe, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import { compile, execute, expectCompileError, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";

describe("named schemas with optional fields", () => {
  const source = 'export schema Props = { label?: String, nested?: { enabled?: Boolean } }';

  it("decodes and encodes ordinary JavaScript optional properties explicitly", async () => {
    const { Props, PropsFromUnknown } = await execute(source);
    expect(PropsFromUnknown({})).toEqual({ label: Option.none(), nested: Option.none() });
    expect(PropsFromUnknown({ label: undefined, nested: { enabled: false } })).toEqual({ label: Option.none(), nested: Option.some({ enabled: Option.some(false) }) });
    const value = PropsFromUnknown({ label: "Ada", nested: {} });
    expect(value).toEqual({ label: Option.some("Ada"), nested: Option.some({ enabled: Option.none() }) });
    expect(Schema.encodeSync(Props)(value)).toEqual({ label: "Ada", nested: {} });
    expect(() => PropsFromUnknown({ label: null })).toThrow();
    expect((await compile(source)).typescript).toContain("Schema.OptionFromOptional");
    expect(format(format(source))).toBe(format(source));
  });

  it("requires real Option handling on decoded values while exposing the encoded input", async () => {
    const good = await typeCheck(source + '\nread = (props: Props) => props.label\nexport forward = (props: Props) => read(props)\nexport input = (props: SchemaInput<Props>) => props\nexport empty = input({})', "optional-schema.fun");
    expect(good.success, good.formattedOutput).toBe(true);
    const bad = await typeCheck(source + '\nexport read = (props: Props) => props.label.toUpperCase()', "optional-schema.fun");
    expect(bad.success).toBe(false);
    const raw = await typeCheck(source + '\nread = (props: Props) => props.label\nexport forward = (props: SchemaInput<Props>) => read(props)', "optional-schema.fun");
    expect(raw.success).toBe(false);
  });

  it("decodes optional fields within arrays of records", async () => {
    const { HistoryFromUnknown } = await execute('export schema History = { entries: Array<{ note?: String }> }');
    expect(HistoryFromUnknown({ entries: [{}, { note: "hello" }] })).toEqual({ entries: [{ note: Option.none() }, { note: Option.some("hello") }] });
  });

  it("preserves the decoded Option type across modules", async () => {
    const good = await Effect.runPromise(typeCheckVirtualFiles({
      "model.fun": source,
      "reader.fun": 'import { Props } from "./model.js"\nexport read = (props: Props) => props.label',
      "consumer.fun": 'import { Props, PropsFromUnknown } from "./model.js"\nimport { read } from "./reader.js"\nexport forward = (props: Props) => read(props)\nexport value = forward(PropsFromUnknown({}))',
    }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(good.success, good.formattedOutput).toBe(true);
    const result = await Effect.runPromise(typeCheckVirtualFiles({
      "model.fun": source,
      "consumer.fun": 'import { Props } from "./model.js"\nexport read = (props: Props) => props.label.toUpperCase()',
    }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("toUpperCase"))).toBe(true);
  });

  it("rejects an optional field with a default and unsupported nested defaults", async () => {
    await expectCompileError('schema Bad = { label?: String = "x" }', /both optional and defaulted/);
    await expectCompileError('schema Bad = { nested: { label: String = "x" } }', /Nested schema field defaults/);
  });
});
