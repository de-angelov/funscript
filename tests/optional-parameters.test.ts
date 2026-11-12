import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { compile, execute, expectCompileError, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { Effect } from "effect";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";

describe("optional and defaulted parameters", () => {
  it("returns record literals from callbacks and match arms", async () => {
    const source = 'export copy = (items: Array<{ value: Number }>) => items |> Array.map((item) => { ...item, extra: 1 })\nexport choose = (flag: Boolean) => match flag\n  | true => { value: 1 }\n  | false => { value: 2 }';
    const checked = await typeCheck(source, "record-return.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { copy, choose } = await execute(source);
    expect(copy([{ value: 3 }])).toEqual([{ value: 3, extra: 1 }]);
    expect(choose(true)).toEqual({ value: 1 });
    expect(choose(false)).toEqual({ value: 2 });
  });

  it("converts omitted and undefined JavaScript arguments into real Effect Options", async () => {
    const { inspect } = await execute('export inspect = (value?: String) => value');
    expect(Option.isNone(inspect())).toBe(true);
    expect(Option.isNone(inspect(undefined))).toBe(true);
    expect(inspect("hello")).toEqual(Option.some("hello"));
    expect(inspect(null)).toEqual(Option.some(null));
  });

  it("distinguishes omitted arguments from Option values, including nested Options", async () => {
    const source = `import { Option } from "effect"
export inspect = (value?: Option<String>) => value
export forward = (value?: Option<String>) => inspect(Option.getOrUndefined(value))
export absent = inspect()
export suppliedNone = inspect(Option.none())
export suppliedSome = inspect(Option.some("Ada"))
export forwardedNone = forward(Option.none())`;
    const checked = await typeCheck(source, "optional-option.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { inspect, forward, absent, suppliedNone, suppliedSome, forwardedNone } = await execute(source);
    expect(absent).toEqual(Option.none());
    expect(suppliedNone).toEqual(Option.some(Option.none()));
    expect(suppliedSome).toEqual(Option.some(Option.some("Ada")));
    expect(forwardedNone).toEqual(Option.some(Option.none()));
    expect(inspect(undefined)).toEqual(Option.none());
    expect(inspect(Option.none())).toEqual(Option.some(Option.none()));
    expect(forward(Option.some("Ada"))).toEqual(Option.some(Option.some("Ada")));
  });

  it("requires explicit conversion when forwarding an Option into an optional parameter", async () => {
    const invalid = await typeCheck('read = (value?: String) => value\nexport forward = (value?: String) => read(value)', "optional-forward.fun");
    expect(invalid.success).toBe(false);
    const source = 'import { Option } from "effect"\nread = (value?: String) => value\nexport forward = (value?: String) => read(Option.getOrUndefined(value))';
    const checked = await typeCheck(source, "optional-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source);
    expect(forward()).toEqual(Option.none());
    expect(forward("Ada")).toEqual(Option.some("Ada"));
  });

  it("checks JavaScript-facing TypeScript calls against the value type", async () => {
    const base = 'import { Option } from "effect"\nexport read = (value?: Option<String>) => value';
    const valid = await typeCheck(base + '\nts { const a = read(); const b = read(Option.none<string>()); const c = read(Option.some("Ada")); }', "optional-typescript.fun");
    expect(valid.success, valid.formattedOutput).toBe(true);
    const invalid = await typeCheck(base + '\nts { const bad = read("Ada"); }', "optional-typescript.fun");
    expect(invalid.success).toBe(false);
  });

  it("preserves optional Option values across module boundaries", async () => {
    const files = {
      "optional-reader.fun": 'export read = (value?: Option<String>) => value',
      "optional-caller.fun": 'import { Option } from "effect"\nimport { read } from "./optional-reader.js"\nexport forward = (value?: Option<String>) => read(Option.getOrUndefined(value))\nexport result = read(Option.none())',
    };
    const checked = await Effect.runPromise(typeCheckVirtualFiles(files, { compilerOptions: { rootDir: process.cwd() } }));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("treats an Option supplied as Unknown as a value", async () => {
    const { inspect } = await execute('export inspect = (value?: Unknown) => value');
    expect(inspect()).toEqual(Option.none());
    expect(inspect(Option.none())).toEqual(Option.some(Option.none()));
    expect(inspect(Option.some("Ada"))).toEqual(Option.some(Option.some("Ada")));
  });

  it("requires explicit handling and retains the contained type in Some patterns", async () => {
    const unsafe = await typeCheck('export use = (name?: String) => name.toUpperCase()', "optional-unsafe.fun");
    expect(unsafe.success).toBe(false);
    const invalid = await typeCheck('export use = (name?: String) =>\n  match name\n    | Some(value) => value.notAStringMethod()\n    | None => "none"', "optional-match.fun");
    expect(invalid.success).toBe(false);
    const valid = await typeCheck('export use = (name?: String) =>\n  match name\n    | Some(value) => value + "!"\n    | None => "none"', "optional-match.fun");
    expect(valid.success, valid.formattedOutput).toBe(true);
    const { use } = await execute('export use = (name?: String) =>\n  match name\n    | Some(value) => value + "!"\n    | None => "none"');
    expect(use()).toBe("none");
    expect(use("ada")).toBe("ada!");
  });

  it("safely handles an optional JavaScript callback and checks its argument type", async () => {
    const source = 'export invoke = (callback?: (name: String) => String) =>\n  match callback\n    | Some(fn) => fn("Ada")\n    | None => "missing"';
    const checked = await typeCheck(source, "optional-callback.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(source.replace('fn("Ada")', 'fn(5)'), "optional-callback.fun");
    expect(invalid.success).toBe(false);
    const { invoke } = await execute(source);
    expect(invoke()).toBe("missing");
    expect(invoke((value: string) => value.toUpperCase())).toBe("ADA");
  });

  it("supports an undefined placeholder before a later optional argument", async () => {
    const { second } = await execute('export second = (first?: String, next?: Number) => next');
    expect(second(undefined, 5)).toEqual(Option.some(5));
    expect(second(undefined, undefined)).toEqual(Option.none());
  });

  it("retains Option payload types when an optional result crosses a function boundary", async () => {
    const source = 'read = (name?: String) => name\nexport use = () =>\n  match read("ada")\n    | Some(value) => value.notAStringMethod()\n    | None => "none"';
    const result = await typeCheck(source, "optional-return.fun");
    expect(result.success).toBe(false);
  });

  it("type-checks Some payloads in pattern guards", async () => {
    const source = 'export use = (name?: String) =>\n  match name\n    | Some(value) when value.notAStringMethod() => "bad"\n    | _ => "none"';
    const result = await typeCheck(source, "optional-guard.fun");
    expect(result.success).toBe(false);
  });

  it("retains the Option payload type through local aliases", async () => {
    const source = 'export use = (name?: String) =>\n  saved = name\n  => match saved\n    | Some(value) => value.notAStringMethod()\n    | None => "none"';
    const result = await typeCheck(source, "optional-alias.fun");
    expect(result.success).toBe(false);
  });

  it("does not evaluate defaults when a value is provided", async () => {
    let calls = 0;
    const source = 'ts { declare function next(): number }\nexport get = (value: Number = next()) => value';
    const { get } = await execute(source, { scope: { next: () => ++calls } });
    expect(get(0)).toBe(0);
    expect(calls).toBe(0);
    expect(get()).toBe(1);
    expect(calls).toBe(1);
  });

  it("evaluates parameter defaults when constructing an Effect", async () => {
    let calls = 0;
    const source = 'ts { declare function next(): number }\nexport get = (value: Number = next()) => Effect.succeed(value)';
    const { get } = await execute(source, { scope: { next: () => ++calls } });
    const effect = get();
    expect(calls).toBe(1);
    expect(await Effect.runPromise(effect)).toBe(1);
    expect(await Effect.runPromise(effect)).toBe(1);
    expect(calls).toBe(1);
  });

  it("applies defaults only to missing or undefined values", async () => {
    const { enabled, count, label } = await execute('export enabled = (value: Boolean = true) => value\nexport count = (value: Number = 5) => value\nexport label = (value: String = "fallback") => value');
    expect(enabled()).toBe(true);
    expect(enabled(false)).toBe(false);
    expect(count(0)).toBe(0);
    expect(label("")).toBe("");
    expect(label(null)).toBeNull();
  });

  it("formats the syntax idempotently and preserves it through compilation", async () => {
    const source = 'export f = (name?: String) => name\nexport g = (n: Number = 5) => n\n';
    expect(format(format(source))).toBe(format(source));
    const { typescript } = await compile(source);
    expect(typescript).toContain("Option.fromUndefinedOr");
    expect(typescript).toContain("n: number = 5");
  });

  it("emits a valid function expression as a boolean fallback", async () => {
    const source = 'export choose = (value: Unknown) => value or ((name: String) => name)';
    const { choose } = await execute(source);
    expect(choose(false)("Ada")).toBe("Ada");
    const existing = (name: string) => name.toUpperCase();
    expect(choose(existing)).toBe(existing);
  });

  it("rejects ambiguous and unsupported parameter forms", async () => {
    await expectCompileError('export f = (x?) => x', /require a type annotation/);
    await expectCompileError('export f = (x?: Number = 5) => x', /both optional and defaulted/);
    await expectCompileError('export f = (x?: Number, y: Number) => y', /Only optional parameters/);
    await expectCompileError('export js f = (x?: Number) => x', /not yet supported/);
  });
});

describe("schema input types", () => {
  it("accepts omitted defaulted fields without claiming decoding occurred", async () => {
    const source = 'import { Option } from "effect"\nexport schema Props = { name: String = "default" }\nexport get = (props: SchemaInput<Props>) => Option.fromUndefinedOr(props.name)';
    const result = await compile(source);
    expect(result.typescript).toContain("typeof Props.Encoded");
    const checked = await typeCheck(source + '\nexport missing = get({})\nexport supplied = get({ name: "Ada" })', "schema-input.fun");
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
    const result = await typeCheck('export schema Props = { count: Number = "wrong" }', "schema-default.fun");
    expect(result.success).toBe(false);
  });

  it("evaluates schema defaults only when decoding needs them", async () => {
    let calls = 0;
    const source = 'ts { declare function next(): number }\nexport schema Props = { count: Number = next() }';
    const { PropsFromUnknown } = await execute(source, { scope: { next: () => ++calls } });
    expect(calls).toBe(0);
    expect(PropsFromUnknown({ count: 0 })).toEqual({ count: 0 });
    expect(calls).toBe(0);
    expect(PropsFromUnknown({})).toEqual({ count: 1 });
    expect(PropsFromUnknown({})).toEqual({ count: 2 });
  });

  it("rejects invalid schema input type arguments", async () => {
    await expectCompileError('export f = (x: SchemaInput<String, Number>) => x', /requires one named schema/);
    await expectCompileError('schema Wrapper = { nested: SchemaInput<Props> }', /static input type/);
  });
});
