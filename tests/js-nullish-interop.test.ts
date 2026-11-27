import { describe, expect, it } from "vitest";
import { compile, execute, typeCheck } from "./helpers/index.js";

describe("JSNullish interop", () => {
  it("emits raw TypeScript nullish types for parameters and record fields", async () => {
    const source = `export schema Props = { text: JSNullish<String> }
export pass = (value: JSNullish<String>): JSNullish<String> => value`;
    const compiled = await compile(source, "js-nullish.fun");
    expect(compiled.typescript).toContain("string | null | undefined");
    const checked = await typeCheck(source, "js-nullish.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { pass, PropsFromUnknown } = await execute(source);
    expect(pass("hello")).toBe("hello");
    expect(pass(null)).toBeNull();
    expect(pass(undefined)).toBeUndefined();
    expect(PropsFromUnknown({ text: null }).text).toBeNull();
    expect(PropsFromUnknown({ text: undefined }).text).toBeUndefined();
    expect(PropsFromUnknown({ text: "hello" }).text).toBe("hello");
  });

  it("requires one type argument", async () => {
    const checked = await typeCheck(
      "export pass = (x: JSNullish) => x",
      "bad-nullish.fun",
    );
    expect(checked.success).toBe(false);
    expect(checked.formattedOutput).toContain(
      "requires exactly one type argument",
    );
  });

  it("keeps a nullable callback distinct from a callback returning a nullable value", async () => {
    const source = `export pass = (value: JSNullish<() => String>): JSNullish<() => String> => value`;
    const compiled = await compile(source, "js-nullish-callback.fun");
    expect(compiled.typescript).toContain("(() => string) | null | undefined");
    const checked = await typeCheck(source, "js-nullish-callback.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { pass } = await execute(source);
    expect(pass(null)).toBeNull();
    expect(pass(() => "hello")()).toBe("hello");
  });

  it("rejects declarations that collide with the built-in type", async () => {
    for (const source of [
      "export schema JSNullish<A> = { value: A }",
      'import { Something as JSNullish } from "./other.js"',
    ]) {
      const checked = await typeCheck(source, "js-nullish-collision.fun");
      expect(checked.success).toBe(false);
      expect(checked.formattedOutput).toContain("built-in interop type");
    }
  });

  it("preserves raw nullish values when forwarding JSX props", async () => {
    const source = `export Target = (props: { text: JSNullish<String> }) => <div />
export Wrapper = (props: { text: JSNullish<String> }) => <Target {...props} />`;
    const checked = await typeCheck(source, "js-nullish-jsx.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const compiled = await compile(source, "js-nullish-jsx.funx");
    expect(compiled.typescript).toContain("text: (string | null | undefined)");
    expect(compiled.typescript).toContain("<Target {...props} />");
  });

  it("passes a raw value to a foreign JSX component", async () => {
    const source = `ts {
  declare function Foreign(props: { text: string | null | undefined }): import("react").ReactNode;
}
export Wrapper = (props: { text: JSNullish<String> }) => <Foreign text={props.text} />`;
    const checked = await typeCheck(source, "js-nullish-foreign.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const compiled = await compile(source, "js-nullish-foreign.funx");
    expect(compiled.typescript).toContain("text={props.text}");
  });

  it("matches generic and unknown payloads without claiming nullish values succeed", async () => {
    const source = `export inspect = <A>(value: JSNullish<A>) =>
  match value
    | Success(payload) => "value"
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"
export inspectUnknown = (value: JSNullish<Unknown>) => inspect(value)`;
    const checked = await typeCheck(source, "js-nullish-generic.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { inspect } = await execute(source);
    expect(inspect(0)).toBe("value");
    expect(inspect(null)).toBe("null");
    expect(inspect(undefined)).toBe("undefined");
  });

  it("narrows the success payload when absence branches come first", async () => {
    const source = `export inspect = (value: JSNullish<String>) =>
  match value
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"
    | Success(payload) => payload.toUpperCase()`;
    const checked = await typeCheck(source, "js-nullish-order.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { inspect } = await execute(source);
    expect(inspect("ok")).toBe("OK");
    expect(inspect(null)).toBe("null");
    expect(inspect(undefined)).toBe("undefined");
  });
});
