import { describe, expect, it } from "vitest";
import { Option } from "effect";
import {
  compile,
  execute,
  expectCompileError,
  typeCheck,
} from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { Effect } from "effect";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";

describe("optional and defaulted parameters", () => {
  it("returns record literals from callbacks and match arms", async () => {
    const source =
      "export copy = (items: Array<{ value: Number }>) => items |> Array.map((item) => { ...item, extra: 1 })\nexport choose = (flag: Boolean) => match flag\n  | true => { value: 1 }\n  | false => { value: 2 }";
    const checked = await typeCheck(source, "record-return.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { copy, choose } = await execute(source);
    expect(copy([{ value: 3 }])).toEqual([{ value: 3, extra: 1 }]);
    expect(choose(true)).toEqual({ value: 1 });
    expect(choose(false)).toEqual({ value: 2 });
  });

  it("emits optional parameters as T | undefined and converts via fromNullishOr", async () => {
    const { inspect, toOpt } = await execute(
      "export inspect = (value?: String) => value\nexport toOpt = (value?: String) => value |> fromNullishOr",
    );
    expect(inspect()).toBeUndefined();
    expect(inspect(undefined)).toBeUndefined();
    expect(inspect("hello")).toBe("hello");
    expect(inspect(null)).toBeNull();
    expect(Option.isNone(toOpt())).toBe(true);
    expect(Option.isNone(toOpt(undefined))).toBe(true);
    expect(Option.isNone(toOpt(null))).toBe(true);
    expect(toOpt("hello")).toEqual(Option.some("hello"));
  });

  it("preserves optional Option<T> parameters as Option<T> | undefined without double-wrapping", async () => {
    const source = `import { Option } from "effect"
export inspect = (value?: Option<String>) => value
export forward = (value?: Option<String>) => inspect(value)
export absent = inspect()
export suppliedNone = inspect(Option.none())
export suppliedSome = inspect(Option.some("Ada"))
export forwardedNone = forward(Option.none())`;
    const checked = await typeCheck(source, "optional-option.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const {
      inspect,
      forward,
      absent,
      suppliedNone,
      suppliedSome,
      forwardedNone,
    } = await execute(source);
    expect(absent).toBeUndefined();
    expect(suppliedNone).toEqual(Option.none());
    expect(suppliedSome).toEqual(Option.some("Ada"));
    expect(forwardedNone).toEqual(Option.none());
    expect(inspect(undefined)).toBeUndefined();
    expect(forward(Option.some("Ada"))).toEqual(Option.some("Ada"));
  });

  it("forwards an optional parameter directly", async () => {
    const source =
      "read = (value?: String) => value\nexport forward = (value?: String) => read(value)";
    const checked = await typeCheck(source, "optional-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source);
    expect(forward()).toBeUndefined();
    expect(forward("Ada")).toBe("Ada");
  });

  it("checks JavaScript-facing TypeScript calls against the value type", async () => {
    const base =
      'import { Option } from "effect"\nexport read = (value?: Option<String>) => value';
    const valid = await typeCheck(
      base +
        '\nts { const a = read(); const b = read(Option.none<string>()); const c = read(Option.some("Ada")); }',
      "optional-typescript.fun",
    );
    expect(valid.success, valid.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      base + '\nts { const bad = read("Ada"); }',
      "optional-typescript.fun",
    );
    expect(invalid.success).toBe(false);
  });

  it("preserves optional Option values across module boundaries", async () => {
    const files = {
      "optional-reader.fun": "export read = (value?: Option<String>) => value",
      "optional-caller.fun":
        'import { Option } from "effect"\nimport { read } from "./optional-reader.js"\nexport forward = (value?: Option<String>) => read(value)\nexport result = read(Option.some("Ada"))',
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("rejects ambiguous Options and supports explicit choices", async () => {
    const prefix =
      'import { Option } from "effect"\nread = (value?: Unknown) => value\n';
    await expectCompileError(
      prefix + "export f = (value: Option<String>) => read(value)",
      /Ambiguous optional argument/,
    );
    const ambiguous = await typeCheck(
      prefix + "export f = (value: Option<String>) => read(value)",
      "ambiguous-option.fun",
    );
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.diagnostics[0].line).toBe(3);
    expect(ambiguous.diagnostics[0].column).toBe(44);
    const source =
      prefix +
      "export pass = (value: Option<String>) => read(Option.some(value))\nexport forward = (value: Option<String>) => read(Option.getOrUndefined(value))";
    const checked = await typeCheck(source, "optional-choices.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { pass, forward } = await execute(source);
    expect(pass(Option.none())).toEqual(Option.none());
    expect(forward(Option.none())).toBeUndefined();
    expect(forward(Option.some("Ada"))).toBe("Ada");
  });

  it("forwards optional values across FunScript modules", async () => {
    const files = {
      "reader.fun": "export read = (value?: String) => value",
      "caller.fun":
        'import { read } from "./reader.js"\nexport forward = (value?: String) => read(value)',
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("does not silently erase a present undefined when forwarding", async () => {
    const source =
      "ts { type MaybeText = string | undefined }\nread = (value?: String) => value\nexport forward = (value: Option<MaybeText>) => read(value)";
    await expectCompileError(source, /may contain undefined/);
    const normalized =
      'import { Option } from "effect"\n' +
      source.replace(
        "read(value)",
        "read(Option.getOrUndefined(Option.flatMap(value, Option.fromUndefinedOr)))",
      );
    const checked = await typeCheck(normalized, "normalize-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("treats an Option supplied as Unknown as a value", async () => {
    const { inspect } = await execute(
      "export inspect = (value?: Unknown) => value",
    );
    expect(inspect()).toBeUndefined();
    expect(inspect(Option.none())).toEqual(Option.none());
    expect(inspect(Option.some("Ada"))).toEqual(Option.some("Ada"));
  });

  it("requires explicit handling via fromNullishOr / fromNullishOrElse and retains the contained type", async () => {
    const unsafe = await typeCheck(
      "export use = (name?: String) => name.toUpperCase()",
      "optional-unsafe.fun",
    );
    expect(unsafe.success).toBe(false);
    const invalid = await typeCheck(
      'export use = (name?: String) =>\n  match (fromNullishOr(name))\n    | Some(value) => value.notAStringMethod()\n    | None => "none"',
      "optional-match.fun",
    );
    expect(invalid.success).toBe(false);
    const valid = await typeCheck(
      'export use = (name?: String) =>\n  match (fromNullishOr(name))\n    | Some(value) => value + "!"\n    | None => "none"',
      "optional-match.fun",
    );
    expect(valid.success, valid.formattedOutput).toBe(true);
    const { use, fallback } = await execute(
      'export use = (name?: String) =>\n  match (fromNullishOr(name))\n    | Some(value) => value + "!"\n    | None => "none"\nexport fallback = (name?: String) => name |> fromNullishOrElse("stranger")',
    );
    expect(use()).toBe("none");
    expect(use("ada")).toBe("ada!");
    expect(fallback()).toBe("stranger");
    expect(fallback("ada")).toBe("ada");
  });

  it("safely handles an optional JavaScript callback and checks its argument type", async () => {
    const source =
      'export invoke = (callback?: (name: String) => String) =>\n  match (fromNullishOr(callback))\n    | Some(cb) => cb("Ada")\n    | None => "missing"';
    const checked = await typeCheck(source, "optional-callback.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      source.replace('cb("Ada")', "cb(5)"),
      "optional-callback.fun",
    );
    expect(invalid.success).toBe(false);
    const { invoke } = await execute(source);
    expect(invoke()).toBe("missing");
    expect(invoke((value: string) => value.toUpperCase())).toBe("ADA");
  });

  it("supports an undefined placeholder before a later optional argument", async () => {
    const { second } = await execute(
      "export second = (first?: String, next?: Number) => next",
    );
    expect(second(undefined, 5)).toBe(5);
    expect(second(undefined, undefined)).toBeUndefined();
  });

  it("retains Option payload types when an optional result crosses a function boundary", async () => {
    const source =
      'read = (name?: String) => name\nexport use = () =>\n  match read("ada")\n    | Some(value) => value.notAStringMethod()\n    | None => "none"';
    const result = await typeCheck(source, "optional-return.fun");
    expect(result.success).toBe(false);
  });

  it("type-checks Some payloads in pattern guards", async () => {
    const source =
      'export use = (name?: String) =>\n  match name\n    | Some(value) when value.notAStringMethod() => "bad"\n    | _ => "none"';
    const result = await typeCheck(source, "optional-guard.fun");
    expect(result.success).toBe(false);
  });

  it("retains the Option payload type through local aliases", async () => {
    const source =
      'export use = (name?: String) =>\n  saved = name\n  => match saved\n    | Some(value) => value.notAStringMethod()\n    | None => "none"';
    const result = await typeCheck(source, "optional-alias.fun");
    expect(result.success).toBe(false);
  });

  it("does not evaluate defaults when a value is provided", async () => {
    let calls = 0;
    const source =
      "ts { declare function next(): number }\nexport get = (value: Number = next()) => value";
    const { get } = await execute(source, { scope: { next: () => ++calls } });
    expect(get(0)).toBe(0);
    expect(calls).toBe(0);
    expect(get()).toBe(1);
    expect(calls).toBe(1);
  });

  it("evaluates parameter defaults when constructing an Effect", async () => {
    let calls = 0;
    const source =
      "ts { declare function next(): number }\nexport get = (value: Number = next()) => Effect.succeed(value)";
    const { get } = await execute(source, { scope: { next: () => ++calls } });
    const effect = get();
    expect(calls).toBe(1);
    expect(await Effect.runPromise(effect)).toBe(1);
    expect(await Effect.runPromise(effect)).toBe(1);
    expect(calls).toBe(1);
  });

  it("applies defaults only to missing or undefined values", async () => {
    const { enabled, count, label } = await execute(
      'export enabled = (value: Boolean = true) => value\nexport count = (value: Number = 5) => value\nexport label = (value: String = "fallback") => value',
    );
    expect(enabled()).toBe(true);
    expect(enabled(false)).toBe(false);
    expect(count(0)).toBe(0);
    expect(label("")).toBe("");
    expect(label(null)).toBeNull();
  });

  it("formats the syntax idempotently and preserves it through compilation", async () => {
    const source =
      "export f = (name?: String) => name\nexport g = (n: Number = 5) => n\n";
    expect(format(format(source))).toBe(format(source));
    const { typescript } = await compile(source);
    expect(typescript).toContain("name?: string");
    expect(typescript).not.toContain("Option.fromUndefinedOr");
    expect(typescript).toContain("n: number = 5");
  });

  it("emits a valid function expression as a boolean fallback", async () => {
    const source =
      "export choose = (value: Unknown) => value or ((name: String) => name)";
    const { choose } = await execute(source);
    expect(choose(false)("Ada")).toBe("Ada");
    const existing = (name: string) => name.toUpperCase();
    expect(choose(existing)).toBe(existing);
  });

  it("rejects ambiguous and unsupported parameter forms", async () => {
    await expectCompileError(
      "export f = (x?) => x",
      /require a type annotation/,
    );
    await expectCompileError(
      "export f = (x?: Number = 5) => x",
      /both optional and defaulted/,
    );
    await expectCompileError(
      "export f = (x?: Number, y: Number) => y",
      /Only optional parameters/,
    );
  });
});

describe("schema input types", () => {
  it("accepts omitted defaulted fields without claiming decoding occurred", async () => {
    const source =
      'import { Option } from "effect"\nexport schema Props = { name: String = "default" }\nexport get = (props: SchemaInput<Props>) => Option.fromUndefinedOr(props.name)';
    const result = await compile(source);
    expect(result.typescript).toContain("typeof Props.Encoded");
    const checked = await typeCheck(
      source +
        '\nexport missing = get({})\nexport supplied = get({ name: "Ada" })',
      "schema-input.fun",
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { get, PropsFromUnknown } = await execute(source);
    expect(Option.isNone(get({}))).toBe(true);
    expect(get({ name: "Ada" })).toEqual(Option.some("Ada"));
    expect(PropsFromUnknown({})).toEqual({ name: "default" });
    expect(PropsFromUnknown({ name: undefined })).toEqual({ name: "default" });
    expect(PropsFromUnknown({ name: "" })).toEqual({ name: "" });
    expect(() => PropsFromUnknown({ name: null })).toThrow();
  });

  it("rejects defaults that do not match the decoded field type", async () => {
    const result = await typeCheck(
      'export schema Props = { count: Number = "wrong" }',
      "schema-default.fun",
    );
    expect(result.success).toBe(false);
  });

  it("evaluates schema defaults only when decoding needs them", async () => {
    let calls = 0;
    const source =
      "ts { declare function next(): number }\nexport schema Props = { count: Number = next() }";
    const { PropsFromUnknown } = await execute(source, {
      scope: { next: () => ++calls },
    });
    expect(calls).toBe(0);
    expect(PropsFromUnknown({ count: 0 })).toEqual({ count: 0 });
    expect(calls).toBe(0);
    expect(PropsFromUnknown({})).toEqual({ count: 1 });
    expect(PropsFromUnknown({})).toEqual({ count: 2 });
  });

  it("rejects invalid schema input type arguments", async () => {
    await expectCompileError(
      "export f = (x: SchemaInput<String, Number>) => x",
      /requires one named schema/,
    );
    await expectCompileError(
      "schema Wrapper = { nested: SchemaInput<Props> }",
      /static input type/,
    );
  });
});
