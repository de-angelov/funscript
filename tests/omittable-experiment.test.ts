import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { compile, execute, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { optionalProperties, propertyPresence } from "../src/interop/record.js";
import { nullValue, undefinedValue } from "../src/interop/index.js";

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
    const props = optionalProperties({ absent: Option.none(), empty: Option.some(undefinedValue()), clear: Option.some(nullValue()), label: Option.some("Ada") });
    expect(Object.hasOwn(props, "absent")).toBe(false);
    expect(Object.hasOwn(props, "empty")).toBe(true);
    expect(propertyPresence(props, "empty")).toEqual(Option.some(undefined));
    expect(props).toEqual({ empty: undefined, clear: null, label: "Ada" });
  });
});

describe("nullish interop", () => {
  it("emits nullable unions and type checks explicit Effect conversions", async () => {
    const source = `import { Option } from "effect"
export normalizeNull = (value: NullOr<String>) => Option.fromNullOr(value)
export normalizeUndefined = (value: UndefinedOr<String>) => Option.fromUndefinedOr(value)
export toNull = (value: Option<String>): NullOr<String> => Option.getOrNull(value)
export toUndefined = (value: Option<String>): UndefinedOr<String> => Option.getOrUndefined(value)`;
    const checked = await typeCheck(source, "nullish.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const output = await compile(source);
    expect(output.typescript).toContain("(string | null)");
    expect(output.typescript).toContain("(string | undefined)");
    const { normalizeNull, normalizeUndefined, toNull, toUndefined } = await execute(source);
    expect(normalizeNull(null)).toEqual(Option.none());
    expect(normalizeNull("Ada")).toEqual(Option.some("Ada"));
    expect(normalizeUndefined(undefined)).toEqual(Option.none());
    expect(toNull(Option.none())).toBeNull();
    expect(toUndefined(Option.none())).toBeUndefined();
  });

  it("validates required nullish schema values", async () => {
    const source = 'export schema Values = { name: NullOr<String>, title: UndefinedOr<String> }';
    const { ValuesFromUnknown } = await execute(source);
    expect(ValuesFromUnknown({ name: null, title: undefined })).toEqual({ name: null, title: undefined });
    expect(ValuesFromUnknown({ name: "Ada", title: "Engineer" })).toEqual({ name: "Ada", title: "Engineer" });
    expect(() => ValuesFromUnknown({ name: 5, title: "Engineer" })).toThrow();
  });

  it("rejects malformed nullish type constructors", async () => {
    const { expectCompileError } = await import("./helpers/index.js");
    await expectCompileError('export bad = (x: NullOr<String, Number>) => x', /requires exactly one type argument/);
    await expectCompileError('export bad = (x: UndefinedOr) => x', /requires exactly one type argument/);
  });
});
