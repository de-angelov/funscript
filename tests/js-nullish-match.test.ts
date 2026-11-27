import { describe, expect, it } from "vitest";
import { compile, execute, typeCheck } from "./helpers/index.js";

const source = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) => text + "!"
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;

describe("JSNullish patterns", () => {
  it("preserves ordinary nested tagged union matches using Null variants", async () => {
    const code = `schema Reason =
  | Null
  | Missing
schema Reply =
  | Success(value: String)
  | Failure(reason: Reason)
export show = (reply: Reply): String =>
  match reply
    | Success(value) => value
    | Failure(Null) => "null variant"
    | Failure(Missing) => "missing"
export ok = show(Success("ok"))
export absent = show(Failure(Null))
export missing = show(Failure(Missing))`;
    const checked = await typeCheck(code, "nested-null-adt.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { ok, absent, missing } = await execute(code);
    expect([ok, absent, missing]).toEqual(["ok", "null variant", "missing"]);
  });
  it("matches raw values with typed, exhaustive branches", async () => {
    const checked = await typeCheck(source, "js-nullish.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(source);
    expect(show("Ada")).toBe("Ada!");
    expect(show(null)).toBe("null");
    expect(show(undefined)).toBe("undefined");
    const { typescript } = await compile(source);
    expect(typescript).toContain("=== null");
    expect(typescript).not.toContain('_tag: "Success"');
  });

  it("supports typed props and reads getters once", async () => {
    const code = `export show = (props: { text: JSNullish<String> }) =>
  match props.text
    | Success(text) => text + "!"
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;
    const checked = await typeCheck(code, "js-nullish-props.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(code);
    let reads = 0;
    expect(
      show({
        get text() {
          reads++;
          return "hello";
        },
      }),
    ).toBe("hello!");
    expect(reads).toBe(1);
  });

  it("matches fields declared in a named schema", async () => {
    const code = `schema Props = { text: JSNullish<String> }
export show = (props: Props) =>
  match props.text
    | Success(text) => text + "!"
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;
    const checked = await typeCheck(code, "js-nullish-schema-props.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(code);
    expect(show({ text: "hello" })).toBe("hello!");
    expect(show({ text: null })).toBe("null");
    expect(show({ text: undefined })).toBe("undefined");
  });

  it("rejects unhandled cases and unsupported patterns", async () => {
    const missing = await typeCheck(
      source.replace('    | Failure(Undefined) => "undefined"', ""),
      "js-nullish-missing.fun",
    );
    expect(missing.success).toBe(false);
    const badBinding = await typeCheck(
      source.replace('text + "!"', "text.notAStringMethod()"),
      "js-nullish-narrow.fun",
    );
    expect(badBinding.success).toBe(false);
    const invalid = await typeCheck(
      source.replace("Failure(Null)", "Failure(Other)"),
      "js-nullish-invalid.fun",
    );
    expect(invalid.success).toBe(false);
  });

  it("throws on an unhandled nullish value even without type checking", async () => {
    const code = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) => text`;
    const { show } = await execute(code);
    expect(() => show(null)).toThrow("Non-exhaustive JSNullish match");
    expect(() => show(undefined)).toThrow("Non-exhaustive JSNullish match");
  });

  it("supports guards and fallback bindings", async () => {
    const code = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) when text.length #= 0 => "empty"
    | Success(text) => text
    | Failure(reason) => "missing"`;
    const checked = await typeCheck(code, "js-nullish-guard.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(code);
    expect(show("")).toBe("empty");
    expect(show("hi")).toBe("hi");
    expect(show(null)).toBe("missing");
  });

  it("refuses special patterns when the scrutinee type cannot be proven", async () => {
    const code = `export show = (value: Unknown) =>
  match value
    | Success(text) => text
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;
    const checked = await typeCheck(code, "js-nullish-unproven.fun");
    expect(checked.success).toBe(false);
    expect(checked.formattedOutput).toContain("statically known JSNullish");
  });

  it("tracks annotated local aliases and function results, including generic failure arms", async () => {
    const code = `get = (value: JSNullish<String>): JSNullish<String> => value
export show = (value: JSNullish<String>) =>
  copy: JSNullish<String> = get(value)
  => match copy
    | Success(text) => text + "!"
    | Failure(_) => "missing"`;
    const checked = await typeCheck(code, "js-nullish-alias.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(code);
    expect(show("hello")).toBe("hello!");
    expect(show(null)).toBe("missing");
    expect(show(undefined)).toBe("missing");
  });

  it("matches an annotated function result directly", async () => {
    const code = `get = (value: JSNullish<String>): JSNullish<String> => value
export show = (value: JSNullish<String>) =>
  match get(value)
    | Success(text) => text + "!"
    | Failure(_) => "missing"`;
    const checked = await typeCheck(code, "js-nullish-call.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(code);
    expect(show("ok")).toBe("ok!");
    expect(show(null)).toBe("missing");
  });

  it("does not infer a global function return through a shadowing parameter", async () => {
    const code = `get = (): JSNullish<String> => "hello"
export show = (get: () => Unknown) =>
  match get()
    | Success(text) => text
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;
    const checked = await typeCheck(code, "js-nullish-shadow.fun");
    expect(checked.success).toBe(false);
    expect(checked.formattedOutput).toContain("statically known JSNullish");
  });

  it("does not accept unproven unknown values as exhaustive results", async () => {
    const code = `export show = (value: Unknown) =>
  match value
    | Success(text) => "success"
    | Failure(reason) => "failure"`;
    const checked = await typeCheck(code, "js-nullish-unknown-result.fun");
    expect(checked.success).toBe(false);
  });

  it("type-checks guarded JSNullish arms without implicit any", async () => {
    const code = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) when text.length > 0 => text
    | Success(_) => "empty"
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;
    const checked = await typeCheck(code, "js-nullish-guard.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { show } = await execute(code);
    expect(show("hi")).toBe("hi");
    expect(show("")).toBe("empty");
    expect(show(null)).toBe("null");
    expect(show(undefined)).toBe("undefined");
  });
});
