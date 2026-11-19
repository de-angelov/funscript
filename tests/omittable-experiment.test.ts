import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { compile, execute, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { optionalProperties, propertyPresence } from "../src/interop/record.js";

describe("experimental Omittable declarations", () => {
  it("accepts React-style props and preserves spelling in formatting", async () => {
    const source = 'export View = (props: { label: Omittable<String>, onClick: Omittable<() => Void> }) => <div />';
    const checked = await typeCheck(source, "omittable.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const output = await compile(source, "omittable.funx");
    expect(output.typescript).toContain('readonly label?: string');
    expect(format(source, { filename: 'view.funx' })).toContain('label: Omittable<String>');
    expect(format(format(source, { filename: 'view.funx' }), { filename: 'view.funx' })).toBe(format(source, { filename: 'view.funx' }));
  });

  it("normalizes optional parameters and fields as existing optional declarations", async () => {
    const source = 'export read = (props: { label: Omittable<String> }) => props.label\nexport inspect = (name: Omittable<String>) => name';
    const { read, inspect } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ label: undefined })).toEqual(Option.none());
    expect(read({ label: "Ada" })).toEqual(Option.some("Ada"));
    expect(inspect()).toEqual(Option.none());
    expect(inspect("Ada")).toEqual(Option.some("Ada"));
    expect(format(source)).toContain('name: Omittable<String>');
  });

  it("supports schema fields using current decoding semantics", async () => {
    const source = 'export schema Props = { label: Omittable<String> }';
    const { PropsFromUnknown } = await execute(source);
    expect(PropsFromUnknown({})).toEqual({ label: Option.none() });
    expect(PropsFromUnknown({ label: null })).toEqual({ label: Option.none() });
    expect(PropsFromUnknown({ label: "Ada" })).toEqual({ label: Option.some("Ada") });
    expect(format(source)).toContain('label: Omittable<String>');
  });

  it("builds props while preserving explicit undefined and null", () => {
    const props = optionalProperties({ absent: Option.none(), empty: Option.some(undefined), clear: Option.some(null), label: Option.some("Ada") });
    expect(Object.hasOwn(props, "absent")).toBe(false);
    expect(Object.hasOwn(props, "empty")).toBe(true);
    expect(propertyPresence(props, "empty")).toEqual(Option.some(undefined));
    expect(props).toEqual({ empty: undefined, clear: null, label: "Ada" });
  });
});
