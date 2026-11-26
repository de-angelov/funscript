import { describe, expect, it } from "vitest";
import { Option } from "effect";
import {
  compile,
  execute,
  expectCompileError,
  typeCheck,
} from "./helpers/index.js";
import ts from "typescript";

describe("Option and defaulted fields in records (JS/TS optional interop)", () => {
  it("forwards Options into known optional record fields without creating absent properties", async () => {
    const source =
      'import { Option } from "effect"\nts { declare function observe(value: { label?: string }): { label?: string } }\nexport forward = (name: Option<String>) => observe({ label: name })';
    const checked = await typeCheck(source, "optional-record-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source, {
      scope: { observe: (value: unknown) => value },
    });
    expect(Object.hasOwn(forward(Option.none()), "label")).toBe(false);
    expect(forward(Option.some("Ada"))).toEqual({ label: "Ada" });
  });

  it("forwards Options to known JSX optional props on foreign components", async () => {
    const source =
      'import { Option } from "effect"\nts { declare const View: (props: { label?: string }) => any }\nexport Wrapper = (name: Option<String>) => <View label={name} />';
    const checked = await typeCheck(source, "optional-jsx-forward.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const generated = (await compile(source, "optional-jsx-forward.funx"))
      .typescript;
    expect(generated).toContain("Option.isSome(__value)");
    const js = ts
      .transpileModule(generated, {
        fileName: "component.tsx",
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
      })
      .outputText.replace(/import\s+[^;]+;\s*/g, "")
      .replace(/\bexport\s+/g, "");
    const wrapper = new Function(
      "Option",
      "_jsx",
      "View",
      `${js}\nreturn Wrapper;`,
    )(
      Option,
      (_type: unknown, props: unknown) => props,
      () => null,
    );
    expect(Object.hasOwn(wrapper(Option.none()), "label")).toBe(false);
    expect(wrapper(Option.some("Ada"))).toEqual({ label: "Ada" });
  });

  it("preserves Some(undefined) and evaluates an optional field expression once", async () => {
    const source =
      'ts { type Input = string | undefined; declare function observe(value: { label?: string | undefined }): { label?: string | undefined }; declare function next(): import("effect").Option.Option<Input>; }\nexport forward = () => observe({ label: next() })';
    const checked = await typeCheck(source, "optional-undefined.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let calls = 0;
    const { forward } = await execute(source, {
      scope: {
        observe: (value: unknown) => value,
        next: () => {
          calls++;
          return Option.some(undefined);
        },
      },
    });
    const result = forward();
    expect(Object.hasOwn(result, "label")).toBe(true);
    expect(result.label).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("rejects ambiguous optional Unknown record fields and JSX props", async () => {
    const record =
      "ts { declare function read(props: { value?: unknown }): unknown }\nexport forward = (value: Option<String>) => read({ value: value })";
    await expectCompileError(record, /Ambiguous optional property/);
    const explicit =
      'import { Option } from "effect"\nts { declare function read(props: { value?: unknown }): unknown }\nexport forward = (value: Option<String>) => read({ value: Option.some(value) })';
    const { forward } = await execute(explicit, {
      scope: { read: (props: { value?: unknown }) => props.value },
    });
    expect(forward(Option.none())).toEqual(Option.none());
    const jsx =
      "ts { declare const View: (props: { value?: unknown }) => any }\nexport Wrapper = (value: Option<String>) => <View value={value} />";
    await expectCompileError(
      jsx,
      /Ambiguous optional property/,
      "ambiguous-prop.funx",
    );
  });

  it("rejects '?' optional field syntax in FunScript records", async () => {
    await expectCompileError(
      "export read = (props: { label?: String }) => props.label",
      /Optional '\?' field syntax is disabled/,
    );
    await expectCompileError(
      'export x: { label?: String } = { label: "x" }',
      /Optional '\?' field syntax is disabled/,
    );
  });

  it("supports error fields in record literals and Option<T> logger contracts", async () => {
    const valueSource =
      'export response = { error: "bad" }\nexport read = () => response.error';
    const valueChecked = await typeCheck(valueSource, "record-error-value.fun");
    expect(valueChecked.success, valueChecked.formattedOutput).toBe(true);
    const { read } = await execute(valueSource);
    expect(read()).toBe("bad");

    const fieldSource =
      "export keep = (props: { logger: Option<{ error: (message: String) => Void }> }) => props.logger";
    const fieldChecked = await typeCheck(fieldSource, "record-error-field.fun");
    expect(fieldChecked.success, fieldChecked.formattedOutput).toBe(true);
  });

  it("supports defaulted record fields on direct function parameters", async () => {
    const source =
      "export read = (props: { label: Option<String>, count: Number = 2 }) => [props.label, props.count]";
    const checked = await typeCheck(source, "default-record-field.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({ label: Option.none() })).toEqual([Option.none(), 2]);
    expect(read({ label: Option.some("Ada"), count: 5 })).toEqual([
      Option.some("Ada"),
      5,
    ]);
  });
});
