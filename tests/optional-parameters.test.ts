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

  it("rejects '?' optional parameter syntax and supports Option<T> / JSOptional<T>", async () => {
    await expectCompileError(
      "export inspect = (value?: String) => value",
      /Optional '\?' parameter syntax is disabled/,
    );
    const { inspect, toOpt } = await execute(
      "export inspect = (value: JSOptional<String>) => value\nexport toOpt = (value: JSOptional<String>) => value |> fromNullishOr",
    );
    expect(inspect(undefined)).toBeUndefined();
    expect(inspect("hello")).toBe("hello");
    expect(inspect(null)).toBeNull();
    expect(Option.isNone(toOpt(undefined))).toBe(true);
    expect(Option.isNone(toOpt(null))).toBe(true);
    expect(toOpt("hello")).toEqual(Option.some("hello"));
  });

  it("preserves Option<T> parameters across module boundaries", async () => {
    const source = `import { Option } from "effect"
export inspect = (value: Option<String>) => value
export forward = (value: Option<String>) => inspect(value)
export suppliedNone = inspect(Option.none())
export suppliedSome = inspect(Option.some("Ada"))
export forwardedNone = forward(Option.none())`;
    const checked = await typeCheck(source, "optional-option.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { inspect, suppliedNone, suppliedSome, forwardedNone, forward } =
      await execute(source);
    expect(suppliedNone).toEqual(Option.none());
    expect(suppliedSome).toEqual(Option.some("Ada"));
    expect(forwardedNone).toEqual(Option.none());
    expect(inspect(Option.none())).toEqual(Option.none());
    expect(forward(Option.some("Ada"))).toEqual(Option.some("Ada"));
  });

  it("forwards Option<String> to foreign optional TS parameters", async () => {
    const source = `import { Option } from "effect"
ts { declare function read(value?: string): string | undefined }
export forward = (value: Option<String>): JSOptional<String> => read(value)`;
    const checked = await typeCheck(source, "optional-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source, {
      scope: { read: (v?: string) => v },
    });
    expect(forward(Option.none())).toBeUndefined();
    expect(forward(Option.some("Ada"))).toBe("Ada");
  });

  it("checks JavaScript-facing TypeScript calls against Option<T>", async () => {
    const base =
      'import { Option } from "effect"\nexport read = (value: Option<String>) => value';
    const valid = await typeCheck(
      base +
        '\nts { const b = read(Option.none<string>()); const c = read(Option.some("Ada")); }',
      "optional-typescript.fun",
    );
    expect(valid.success, valid.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      base + '\nts { const bad = read("Ada"); }',
      "optional-typescript.fun",
    );
    expect(invalid.success).toBe(false);
  });

  it("preserves Option values across FunScript module boundaries", async () => {
    const files = {
      "optional-reader.fun": "export read = (value: Option<String>) => value",
      "optional-caller.fun":
        'import { Option } from "effect"\nimport { read } from "./optional-reader.js"\nexport forward = (value: Option<String>) => read(value)\nexport result = read(Option.some("Ada"))',
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
      'import { Option } from "effect"\nts { declare function read(value?: unknown): unknown }\n';
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
    const { pass, forward } = await execute(source, {
      scope: { read: (v?: unknown) => v },
    });
    expect(pass(Option.none())).toEqual(Option.none());
    expect(forward(Option.none())).toBeUndefined();
    expect(forward(Option.some("Ada"))).toBe("Ada");
  });

  it("does not silently erase a present undefined when forwarding", async () => {
    const source =
      "ts { type MaybeText = string | undefined; declare function read(value?: string): string | undefined }\nexport forward = (value: Option<MaybeText>): JSOptional<String> => read(value)";
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
      "export inspect = (value: Unknown) => value",
    );
    expect(inspect(undefined)).toBeUndefined();
    expect(inspect(Option.none())).toEqual(Option.none());
    expect(inspect(Option.some("Ada"))).toEqual(Option.some("Ada"));
  });

  it("requires explicit handling via fromNullishOr / fromNullishOrElse and retains the contained type", async () => {
    const unsafe = await typeCheck(
      "export use = (name: JSOptional<String>) => name.toUpperCase()",
      "optional-unsafe.fun",
    );
    expect(unsafe.success).toBe(false);
    const invalid = await typeCheck(
      'export use = (name: JSOptional<String>) =>\n  match (fromNullishOr(name))\n    | Some(value) => value.notAStringMethod()\n    | None => "none"',
      "optional-match.fun",
    );
    expect(invalid.success).toBe(false);
    const valid = await typeCheck(
      'export use = (name: JSOptional<String>) =>\n  match (fromNullishOr(name))\n    | Some(value) => value + "!"\n    | None => "none"',
      "optional-match.fun",
    );
    expect(valid.success, valid.formattedOutput).toBe(true);
    const { use, fallback } = await execute(
      'export use = (name: JSOptional<String>) =>\n  match (fromNullishOr(name))\n    | Some(value) => value + "!"\n    | None => "none"\nexport fallback = (name: JSOptional<String>) => name |> fromNullishOrElse("stranger")',
    );
    expect(use(undefined)).toBe("none");
    expect(use("ada")).toBe("ada!");
    expect(fallback(undefined)).toBe("stranger");
    expect(fallback("ada")).toBe("ada");
  });

  it("safely handles an optional JavaScript callback and checks its argument type", async () => {
    const source =
      'export invoke = (callback: Option<(name: String) => String>) =>\n  match callback\n    | Some(cb) => cb("Ada")\n    | None => "missing"';
    const checked = await typeCheck(source, "optional-callback.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      source.replace('cb("Ada")', "cb(5)"),
      "optional-callback.fun",
    );
    expect(invalid.success).toBe(false);
    const { invoke } = await execute(source);
    expect(invoke(Option.none())).toBe("missing");
    expect(invoke(Option.some((value: string) => value.toUpperCase()))).toBe(
      "ADA",
    );
  });

  it("retains Option payload types when an optional result crosses a function boundary", async () => {
    const source =
      'read = (name: Option<String>) => name\nexport use = () =>\n  match read(Option.some("ada"))\n    | Some(value) => value.notAStringMethod()\n    | None => "none"';
    const result = await typeCheck(source, "optional-return.fun");
    expect(result.success).toBe(false);
  });

  it("type-checks Some payloads in pattern guards", async () => {
    const source =
      'export use = (name: Option<String>) =>\n  match name\n    | Some(value) when value.notAStringMethod() => "bad"\n    | _ => "none"';
    const result = await typeCheck(source, "optional-guard.fun");
    expect(result.success).toBe(false);
  });

  it("retains the Option payload type through local aliases", async () => {
    const source =
      'export use = (name: Option<String>) =>\n  saved = name\n  => match saved\n    | Some(value) => value.notAStringMethod()\n    | None => "none"';
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
      "export f = (name: Option<String>) => name\nexport g = (n: Number = 5) => n\n";
    expect(format(format(source))).toBe(format(source));
    const { typescript } = await compile(source);
    expect(typescript).toContain("name: Option.Option<string>");
    expect(typescript).not.toContain("Option.fromUndefinedOr");
    expect(typescript).toContain("n: number = 5");
  });

  it("rejects non-boolean fallback with 'or' on function expressions", async () => {
    await expectCompileError(
      "export choose = (value: Unknown) => value or ((name: String) => name)",
      /Logical 'or' requires boolean operands/,
    );
  });

  it("rejects ambiguous and unsupported parameter forms", async () => {
    await expectCompileError(
      "export f = (x?) => x",
      /Optional '\?' parameter syntax is disabled/,
    );
    await expectCompileError(
      "export f = (x?: Number = 5) => x",
      /Optional '\?' parameter syntax is disabled/,
    );
    await expectCompileError(
      "export f = (x?: Number, y: Number) => y",
      /Optional '\?' parameter syntax is disabled/,
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

describe("optional forwarding edge cases", () => {
  it("forwards Option for string-literal property keys", async () => {
    const source = `
import { Option } from "effect"

ts {
  declare function takeObj(o: { "foo-bar"?: string }): string | undefined;
}

export callObj = (opt: Option<String>) => fromNullishOr(takeObj({ "foo-bar": opt }))
`.trim();
    const compiled = await compile(source);
    expect(compiled.typescript).toContain('"foo-bar"');
    expect(compiled.typescript).toContain(
      'Option.isSome(__value) ? { ["foo-bar"]: __value.value } : {}',
    );
  });

  it("allows Option.none() for optional properties and JSX attributes that accept Option", async () => {
    const objSource = `
import { Option } from "effect"

ts {
  declare function acceptOptProp(o: { x?: Option.Option<number> }): number;
}

export run = () => acceptOptProp({ x: Option.none() })
`.trim();
    const objChecked = await typeCheck(objSource, "opt-prop-option.fun");
    expect(objChecked.success, objChecked.formattedOutput).toBe(true);

    const { compileString } = await import("../src/compiler.js");
    const { Effect } = await import("effect");
    const jsxSource = `
import { Option } from "effect"

ts {
  declare function Comp(props: { x?: Option.Option<number> }): any;
}

export used = () => <Comp x={Option.none()} />
`.trim();
    const jsxCompiled = await Effect.runPromise(
      compileString(jsxSource, "opt-attr.funx"),
    );
    expect(jsxCompiled.typescript).toContain("x={Option.none()}");
  });
});
