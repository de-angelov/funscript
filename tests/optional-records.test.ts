import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import {
  compile,
  execute,
  expectCompileError,
  typeCheck,
} from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import path from "node:path";
import ts from "typescript";

describe("optional fields in inline parameter records", () => {
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

  it("forwards Options to known JSX optional props", async () => {
    const source =
      'import { Option } from "effect"\nexport View = (props: { label?: String }) => <div />\nexport Wrapper = (name: Option<String>) => <View label={name} />';
    const checked = await typeCheck(source, "optional-jsx-forward.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    expect(
      (await compile(source, "optional-jsx-forward.funx")).typescript,
    ).toContain("Option.isSome(__value)");
    const generated = (await compile(source, "optional-jsx-forward.funx"))
      .typescript;
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
    const wrapper = new Function("Option", "_jsx", `${js}\nreturn Wrapper;`)(
      Option,
      (_type: unknown, props: unknown) => props,
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
      "read = (props: { value?: Unknown }) => props.value\nexport forward = (value: Option<String>) => read({ value: value })";
    await expectCompileError(record, /Ambiguous optional property/);
    const explicit =
      'import { Option } from "effect"\nread = (props: { value?: Unknown }) => props.value\nexport forward = (value: Option<String>) => read({ value: Option.some(value) })';
    const { forward } = await execute(explicit);
    expect(forward(Option.none())).toEqual(Option.some(Option.none()));
    const jsx =
      "export View = (props: { value?: Unknown }) => <div />\nexport Wrapper = (value: Option<String>) => <View value={value} />";
    await expectCompileError(
      jsx,
      /Ambiguous optional property/,
      "ambiguous-prop.funx",
    );
  });
  it("supports error fields in record literals and member access", async () => {
    const source =
      'export response = { error: "bad" }\nexport read = () => response.error';
    const checked = await typeCheck(source, "record-error-value.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read()).toBe("bad");
  });

  it("accepts error as a record type field for JavaScript logger contracts", async () => {
    const source =
      "export keep = (props: { logger?: { error: (message: String) => Void } }) => props.logger";
    const result = await typeCheck(source, "record-error-field.fun");
    expect(result.success, result.formattedOutput).toBe(true);
    expect((await compile(source)).typescript).toContain(
      "readonly error: (message: string) => void",
    );
  });

  it("exposes real Options inside while accepting ordinary JavaScript props", async () => {
    const source = "export read = (props: { label?: String }) => props.label";
    const { read } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ label: undefined })).toEqual(Option.none());
    expect(read({ label: "hello" })).toEqual(Option.some("hello"));
    expect(read({ label: null })).toEqual(Option.none());
    const checked = await typeCheck(
      source + '\nexport a = read({})\nexport b = read({ label: "hi" })',
      "record-option.fun",
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("requires optional callbacks to be handled and retains their payload type", async () => {
    const source =
      'export invoke = (props: { onVote?: (kind: String) => String }) =>\n  match props.onVote\n    | Some(callback) => callback("like")\n    | None => "missing"';
    const checked = await typeCheck(source, "record-callback.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      source.replace('callback("like")', "callback(3)"),
      "record-callback.fun",
    );
    expect(invalid.success).toBe(false);
    const unchecked = await typeCheck(
      'export invoke = (props: { onVote?: (kind: String) => String }) => props.onVote("like")',
      "record-callback.fun",
    );
    expect(unchecked.success).toBe(false);
    const { invoke } = await execute(source);
    expect(invoke({})).toBe("missing");
    expect(invoke({ onVote: (kind: string) => kind.toUpperCase() })).toBe(
      "LIKE",
    );
  });

  it("supports optional void callbacks without passing Option objects to JavaScript", async () => {
    const source =
      'import { Option } from "effect"\nexport dispatch = (props: { onVote?: (kind: String) => Void }) =>\n  ignore = (kind: String) =>\n    => kind\n  callback = Option.getOrElse(props.onVote, () => ignore)\n  => callback("like")';
    const checked = await typeCheck(source, "record-void.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { dispatch } = await execute(source);
    expect(() => dispatch({})).not.toThrow();
    const calls: string[] = [];
    dispatch({ onVote: (kind: string) => calls.push(kind) });
    expect(calls).toEqual(["like"]);
  });

  it("applies defaults once per call, preserves falsey values and reads getters once", async () => {
    let calls = 0;
    const source =
      "ts { declare function next(): number }\nexport sum = (props: { count: Number = next() }) => props.count + props.count";
    const { sum } = await execute(source, { scope: { next: () => ++calls } });
    expect(sum({ count: 0 })).toBe(0);
    expect(calls).toBe(0);
    expect(sum({})).toBe(2);
    expect(calls).toBe(1);
    let reads = 0;
    expect(
      sum({
        get count() {
          reads++;
          return 4;
        },
      }),
    ).toBe(8);
    expect(reads).toBe(1);
    const { values } = await execute(
      'export values = (props: { label: String = "fallback", flag: Boolean = true }) => [props.label, props.flag]',
    );
    expect(values({ label: "", flag: false })).toEqual(["", false]);
    expect(values({ label: null, flag: false })).toEqual([null, false]);
  });

  it("allows explicit asynchronous JavaScript interop to receive the original props object", async () => {
    const source =
      "ts { declare function send(value: unknown): Promise<string> }\nexport sendProps = (props: { label?: String }) => js send(props)";
    const compiled = await compile(source);
    expect(compiled.typescript).toContain("send(props)");
    const checked = await typeCheck(source, "record-js.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let received: unknown;
    const { sendProps } = await execute(source, {
      scope: {
        send: async (value: unknown) => {
          received = value;
          return "ok";
        },
      },
    });
    const original = { label: "hello" };
    expect(await Effect.runPromise(sendProps(original))).toBe("ok");
    expect(received).toBe(original);
  });

  it("forwards unchanged optional records to a statically known FunScript function", async () => {
    const source =
      "read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }) => read(props)";
    const checked = await typeCheck(source, "record-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source);
    expect(forward({})).toEqual(Option.none());
    expect(forward({ label: "Ada" })).toEqual(Option.some("Ada"));
    const { forward: fDefault } = await execute(
      'read = (props: { label?: String }) => props.label\nexport forward = (props: { label: String = "x" }) => read(props)',
    );
    expect(fDefault({})).toEqual(Option.some("x"));
    expect(fDefault({ label: "Ada" })).toEqual(Option.some("Ada"));
    const { forward: fCallback } = await execute(
      "read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }, read: (value: Unknown) => Unknown) => read(props)",
    );
    expect(fCallback({ label: "Ada" }, (p: any) => p.label)).toBe("Ada");
  });

  it("forwards raw records across verified FunScript module boundaries", async () => {
    const reader = "export read = (props: { label?: String }) => props.label";
    const caller =
      'import { read as inspect } from "./reader.js"\nexport forward = (props: { label?: String }) => inspect(props)';
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(
        { "reader.fun": reader, "caller.fun": caller },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    const original = { label: "Ada" };
    let received: unknown;
    const { forward } = await execute(caller, {
      filename: "caller.fun",
      compileOptions: {
        virtualSources: new Map([[path.resolve("reader.fun"), reader]]),
      },
      scope: {
        inspect: (value: unknown) => {
          received = value;
          return Option.some("ok");
        },
      },
    });
    expect(forward(original)).toEqual(Option.some("ok"));
    expect(received).toBe(original);
    const withComparison = caller.replace(
      "export forward = (props: { label?: String }) => inspect(props)",
      "export forward = (props: { label?: String }, count: Number) =>\n  match count > 0\n    | true => inspect(props)\n    | false => inspect(props)",
    );
    expect(
      (
        await compile(withComparison, "caller.fun", {
          virtualSources: new Map([[path.resolve("reader.fun"), reader]]),
        })
      ).typescript,
    ).toContain("inspect(props)");
    const incompatible = await Effect.runPromise(
      typeCheckVirtualFiles(
        {
          "reader.fun":
            "export read = (props: { label?: Number }) => props.label",
          "caller.fun": caller,
        },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(incompatible.success).toBe(false);
    const unchecked = await Effect.runPromise(
      typeCheckVirtualFiles(
        {
          "reader.fun": "export read = (props: Unknown) => props",
          "caller.fun": caller,
        },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(unchecked.success).toBe(true);
  });

  it("tracks verified default exports, namespace imports, and re-export aliases", async () => {
    const files = {
      "reader.fun":
        "export read = (props: { label?: String }) => props.label\nexport default read",
      "direct.fun": "export default (props: { label?: String }) => props.label",
      "barrel.fun":
        'import { read as impl } from "./reader.js"\nexport read = impl',
      "caller.fun":
        'import read from "./reader.js"\nimport direct from "./direct.js"\nimport * as api from "./barrel.js"\nexport first = (props: { label?: String }) => read(props)\nexport second = (props: { label?: String }) => api.read(props)\nexport third = (props: { label?: String }) => direct(props)',
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    let received: unknown;
    const observe = (value: unknown) => {
      received = value;
      return Option.none();
    };
    const scope = { read: observe, direct: observe, api: { read: observe } };
    const virtualSources = new Map([
      [path.resolve("reader.fun"), files["reader.fun"]],
      [path.resolve("direct.fun"), files["direct.fun"]],
      [path.resolve("barrel.fun"), files["barrel.fun"]],
    ]);
    const { first, second, third } = await execute(files["caller.fun"], {
      filename: "caller.fun",
      compileOptions: { virtualSources },
      scope,
    });
    const original = { label: "Ada" };
    first(original);
    expect(received).toBe(original);
    second(original);
    expect(received).toBe(original);
    third(original);
    expect(received).toBe(original);
    const cycle = await Effect.runPromise(
      typeCheckVirtualFiles(
        {
          "first.fun":
            'import { read as impl } from "./second.js"\nexport read = impl',
          "second.fun":
            'import { read as impl } from "./first.js"\nexport read = impl',
          "caller.fun":
            'import { read } from "./first.js"\nexport forward = (props: { label?: String }) => read(props)',
        },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(cycle.success).toBe(false);
    expect(cycle.diagnostics.length).toBeGreaterThan(0);
    const shadowed = await Effect.runPromise(
      typeCheckVirtualFiles(
        {
          "reader.fun": files["reader.fun"],
          "caller.fun":
            'import * as api from "./reader.js"\nexport forward = (props: { label?: String }, api: { read: (value: Unknown) => Unknown }) => api.read(props)',
        },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(shadowed.success).toBe(true);
  });

  it("tracks immutable record aliases and allows first-class record access", async () => {
    const source =
      "read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }) =>\n  alias = props\n  saved = alias\n  => read(saved)";
    const checked = await typeCheck(source, "record-alias.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source);
    expect(forward({})).toEqual(Option.none());
    expect(forward({ label: "Ada" })).toEqual(Option.some("Ada"));
    const direct = await execute(
      "export read = (props: { label?: String }) =>\n  alias = props\n  => alias.label",
    );
    expect(direct.read({ label: "Ada" })).toEqual(Option.some("Ada"));
    const { leak: leakAlias } = await execute(
      "export leak = (props: { label?: String }) =>\n  alias = props\n  => alias",
    );
    expect(leakAlias({ label: "Ada" })).toEqual({ label: "Ada" });
    const { leak: leakDef } = await execute(
      'export leak = (props: { label: String = "x" }) =>\n  alias = props\n  => alias.label',
    );
    expect(leakDef({})).toBe("x");
  });

  it("handles optional fields inside required nested records without restriction", async () => {
    const source =
      "export read = (props: { nested: { label?: String } }) => props.nested.label";
    const checked = await typeCheck(source, "nested-option.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({ nested: {} })).toEqual(Option.none());
    expect(read({ nested: { label: "hello" } })).toEqual(Option.some("hello"));
    const forwarded = await execute(
      "read = (props: { nested: { label?: String } }) => props.nested.label\nexport forward = (props: { nested: { label?: String } }) => read(props)",
    );
    expect(forwarded.forward({ nested: { label: "hello" } })).toEqual(
      Option.some("hello"),
    );
    const unsafe = await typeCheck(
      "export read = (props: { nested: { label?: String } }) => props.nested.label.toUpperCase()",
      "nested-option.fun",
    );
    expect(unsafe.success).toBe(false);
    const { leak: leakNested } = await execute(
      "export leak = (props: { nested: { label?: String } }) => props.nested",
    );
    expect(leakNested({ nested: { label: "Ada" } })).toEqual({ label: "Ada" });
    const { leak: leakNestedIdx } = await execute(
      'export leak = (props: { nested: { label?: String } }) => props.nested["label"]',
    );
    expect(leakNestedIdx({ nested: { label: "Ada" } })).toEqual(
      Option.some("Ada"),
    );
    const { leak: leakNestedOpt } = await execute(
      "export leak = (props: { nested?: { label?: String } }) => props.nested",
    );
    expect(leakNestedOpt({ nested: { label: "Ada" } })).toEqual(
      Option.some({ label: "Ada" }),
    );
    expect(leakNestedOpt({})).toEqual(Option.none());
    const { leak: leakCallback } = await execute(
      "export leak = (props: { callback: (value: { label?: String }) => String }) => props.callback",
    );
    const dummyFn = (value: { label?: string }) => value.label ?? "none";
    expect(leakCallback({ callback: dummyFn })).toBe(dummyFn);

    const { leak: leakValues } = await execute(
      "export leak = (props: { values: Array<{ label?: String }> }) => props.values",
    );
    expect(leakValues({ values: [{ label: "Ada" }] })).toEqual([
      { label: "Ada" },
    ]);
  });

  it("handles an optional parent record through an explicit Some match", async () => {
    const source =
      'import { Option } from "effect"\nexport read = (props: { nested?: { label?: String } }) =>\n  match props.nested\n    | Some(nested) => nested.label\n    | None => Option.none()';
    const checked = await typeCheck(source, "optional-parent.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ nested: {} })).toEqual(Option.none());
    expect(read({ nested: { label: "Ada" } })).toEqual(Option.some("Ada"));
    const guarded = await typeCheck(
      'export read = (props: { nested?: { label?: String } }) =>\n  match props.nested\n    | Some(nested) when nested.label.toUpperCase() => "yes"\n    | _ => "no"',
      "optional-parent-guard.fun",
    );
    expect(guarded.success).toBe(false);
    const { leak: leakMatched } = await execute(
      'export leak = (props: { nested?: { label?: String } }) =>\n  match props.nested\n    | Some(nested) => nested\n    | None => "none"',
    );
    expect(leakMatched({ nested: { label: "Ada" } })).toEqual({ label: "Ada" });
    expect(leakMatched({})).toBe("none");
  });

  it("preserves formatting and rejects unsupported escapes rather than leaking raw undefined", async () => {
    const source =
      "export read = (props: { label?: String, count: Number = 2 }) => props.label\n";
    expect(format(format(source))).toBe(format(source));
    expect((await compile(source)).typescript).toContain(
      "readonly label?: string",
    );
    const { leak: leakReturn } = await execute(
      "export leak = (props: { label?: String }) => props",
    );
    expect(leakReturn({ label: "Ada" })).toEqual({ label: "Ada" });
    const { leak: leakIndex } = await execute(
      'export leak = (props: { label?: String }) => props["label"]',
    );
    expect(leakIndex({ label: "Ada" })).toEqual(Option.some("Ada"));
    expect(leakIndex({})).toEqual(Option.none());
    expect(
      (await compile('export x: { label?: String } = { label: "x" }'))
        .typescript,
    ).toContain("readonly label?: string");
    await expectCompileError(
      'export x: { label: String = "x" } = { label: "x" }',
      /only on direct function parameters/,
    );
    const jsCompiled = await compile(
      "export js f = (props: { label?: String }) => effect { => props.label }",
    );
    expect(jsCompiled.typescript).toContain("readonly label?: string");
    expect(jsCompiled.typescript).toContain("Schema.decodeUnknownSync");
    const jsDefaultedCompiled = await compile(
      'export js f = (props: { label: String = "guest" }) => effect { => props.label }',
    );
    expect(jsDefaultedCompiled.typescript).toContain("readonly label?: string");
    expect(jsDefaultedCompiled.typescript).toContain(
      "Schema.withDecodingDefaultType",
    );
    const { f: jsDefaulted } = await execute(
      'export js f = (props: { label: String = "guest" }) => effect { => props.label }',
    );
    expect(await jsDefaulted({})).toBe("guest");
    expect(await jsDefaulted({ label: "custom" })).toBe("custom");
    await expectCompileError(
      "export f = (props: { label: String = props.label }) => props.label",
      /cannot reference its own record parameter/,
    );
    await expectCompileError(
      "export f = (props: { label: String = suffix }, suffix: String) => props.label",
      /before its declaration/,
    );
    const { f } = await execute(
      "export f = (prefix: String, props: { label: String = prefix }) => props.label",
    );
    expect(f("default-prefix", {})).toBe("default-prefix");
    expect(f("default-prefix", { label: "custom" })).toBe("custom");
  });

  it("permits destructuring inside Some(...) when matching optional records without leaking undefined", async () => {
    const source = `
import { Option } from "effect"
export read = (props: { nested?: { city: String, suite?: String } }) =>
  match props.nested
    | Some({ city, suite }) => city + Option.getOrElse(suite |> Option.map((s) => " - " + s), () => "")
    | None => "missing"
`;
    const checked = await typeCheck(source, "destructure-some-record.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({})).toBe("missing");
    expect(read({ nested: { city: "Paris" } })).toBe("Paris");
    expect(read({ nested: { city: "Paris", suite: "Apt 4" } })).toBe(
      "Paris - Apt 4",
    );
  });

  it("permits alias destructuring, rest patterns, and wildcard patterns inside Some(...) when matching optional records", async () => {
    const source = `
import { Option } from "effect"
export readAlias = (props: { nested?: { city: String, suite?: String } }) =>
  match props.nested
    | Some({ city: c, suite: s }) => c + Option.getOrElse(s |> Option.map((str) => " #" + str), () => "")
    | None => "none"

export checkWildcard = (props: { nested?: { city: String } }) =>
  match props.nested
    | Some(_) => true
    | None => false

export readRest = (props: { nested?: { city: String, suite?: String } }) =>
  match props.nested
    | Some({ city, ...rest }) => city
    | None => "none"
`;
    const checked = await typeCheck(source, "destructure-some-advanced.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { readAlias, checkWildcard, readRest } = await execute(source);
    expect(readAlias({ nested: { city: "Rome", suite: "10" } })).toBe(
      "Rome #10",
    );
    expect(readAlias({ nested: { city: "Rome" } })).toBe("Rome");
    expect(readAlias({})).toBe("none");

    expect(checkWildcard({ nested: { city: "Berlin" } })).toBe(true);
    expect(checkWildcard({})).toBe(false);

    expect(readRest({ nested: { city: "Tokyo" } })).toBe("Tokyo");
    expect(readRest({})).toBe("none");
  });

  it("supports when guards with destructured Some patterns and rejects invalid match patterns on optional records", async () => {
    const source = `
import { Option } from "effect"
export categorize = (props: { address?: { city: String, vip?: Boolean } }) =>
  match props.address
    | Some({ city, vip }) when city #= "Metropolis" => "super"
    | Some({ city }) => city
    | None => "unknown"
`;
    const checked = await typeCheck(source, "destructure-some-guard.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { categorize } = await execute(source);
    expect(categorize({ address: { city: "Metropolis" } })).toBe("super");
    expect(categorize({ address: { city: "Gotham" } })).toBe("Gotham");
    expect(categorize({})).toBe("unknown");

    await expectCompileError(
      'export f = (props: { address?: { city?: String } }) => match props.address\n  | 123 => "bad"\n  | _ => "ok"',
      /Match an optional record with Some\(name\), Some\(\{\.\.\.\}\), None, or _/,
    );
  });

  it("supports defaulted record parameters on export js entry bindings", async () => {
    const source = `
export js startServer = (props: { port: Number = 3000, host: String = "localhost" } = {}) =>
  effect {
    => props.host + ":" + props.port
  }
`;
    const checked = await typeCheck(source, "export-js-defaults.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const compiled = await compile(source, "export-js-defaults.fun");
    expect(compiled.typescript).toContain("Schema.withDecodingDefaultType");
    expect(compiled.typescript).toContain("readonly port?: number");
    expect(compiled.typescript).toContain("readonly host?: string");
    const { startServer } = await execute(source);
    expect(await startServer()).toBe("localhost:3000");
    expect(await startServer({})).toBe("localhost:3000");
    expect(await startServer({ port: 8080 })).toBe("localhost:8080");
    expect(await startServer({ host: "127.0.0.1", port: 9000 })).toBe(
      "127.0.0.1:9000",
    );
  });

  it("supports nested record destructuring inside Some", async () => {
    const source = `
import { Option } from "effect"
export getDeepCity = (props: { user?: { name: String, location: { city: String } } }) =>
  match props.user
    | Some({ name, location: { city } }) => name + "@" + city
    | None => "unknown"

export getNestedAge = (props: { user?: { profile: { age: Number } } }) =>
  match props.user
    | Some({ profile: { age } }) => age
    | None => 0
`;
    const checked = await typeCheck(source, "nested-some.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { getDeepCity, getNestedAge } = await execute(source);
    expect(
      getDeepCity({
        user: { name: "Alice", location: { city: "Wonderland" } },
      }),
    ).toBe("Alice@Wonderland");
    expect(getDeepCity({})).toBe("unknown");
    expect(getNestedAge({ user: { profile: { age: 30 } } })).toBe(30);
    expect(getNestedAge({})).toBe(0);
  });

  it("forwards optional Option properties via record shorthand syntax", async () => {
    const source = `
import { Option } from "effect"
ts {
  function configure(options: { debug?: boolean; timeout?: number }): string {
    return "debug=" + String(options.debug) + ", timeout=" + String(options.timeout);
  }
}

export runWithShorthand = (debug: Option<Boolean>, timeout: Option<Number>) =>
  configure({ debug, timeout })

export runPartial = (debug: Option<Boolean>) =>
  configure({ debug })
`;
    const checked = await typeCheck(source, "shorthand-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const compiled = await compile(source, "shorthand-forward.fun");
    expect(compiled.typescript).toContain("Option.isSome");
    const { runWithShorthand, runPartial } = await execute(source);
    expect(await runWithShorthand(Option.some(true), Option.some(5000))).toBe(
      "debug=true, timeout=5000",
    );
    expect(await runWithShorthand(Option.none(), Option.none())).toBe(
      "debug=undefined, timeout=undefined",
    );
    expect(await runPartial(Option.some(false))).toBe(
      "debug=false, timeout=undefined",
    );
  });

  it("preserves optional field tracking when spreading records with explicit field overrides", async () => {
    const source = `
import { Option } from "effect"
schema User = { id: String, role?: String }

export overrideWithOption = (base: User, newRole: Option<String>) => {
  user = { ...base, role: newRole }
  { role } = user
  => role
}

export overrideWithRequired = (base: User) => {
  user = { ...base, role: "admin" }
  { role } = user
  => role
}
`;
    const checked = await typeCheck(source, "spread-override.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { overrideWithOption, overrideWithRequired } = await execute(source);
    expect(overrideWithOption({ id: "1" }, Option.some("editor"))).toEqual(
      Option.some("editor"),
    );
    expect(overrideWithOption({ id: "1" }, Option.none())).toEqual(
      Option.none(),
    );
    expect(overrideWithRequired({ id: "2" })).toBe("admin");
  });

  it("tracks optional and inner variable types in nested function parameter destructuring", async () => {
    const source = `
import { Option } from "effect"

export readBio = ({ profile: { bio } }: { name: String, profile: { age: Number, bio?: String } }) => bio
export readAge = ({ profile: { age } }: { name: String, profile: { age: Number, bio?: String } }) => age
`;
    const checked = await typeCheck(source, "nested-param-destructuring.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { readBio, readAge } = await execute(source);
    expect(
      readBio({ name: "Alice", profile: { age: 25, bio: "coder" } }),
    ).toEqual(Option.some("coder"));
    expect(readBio({ name: "Bob", profile: { age: 30 } })).toEqual(
      Option.none(),
    );
    expect(readAge({ name: "Alice", profile: { age: 25 } })).toBe(25);
  });

  it("validates and decodes destructured record parameters on export js bindings", async () => {
    const source = `
import { Effect } from "effect"
schema UserInput = { username: String, age: Number }

export js register = ({ username, age }: UserInput) => effect {
  => username + ":" + age
}
`;
    const checked = await typeCheck(source, "export-js-destructure.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const compiled = await compile(source, "export-js-destructure.fun");
    expect(compiled.typescript).toContain("Schema.decodeUnknownSync");
    const { register } = await execute(source);
    expect(await register({ username: "alice", age: 30 })).toBe("alice:30");
    expect(() => register({ username: "bob", age: "not-a-number" })).toThrow();
    expect(() => register({})).toThrow();
  });

  it("supports nested array destructuring inside function parameter records", async () => {
    const source = `
export summarize = ({ count, tags: [first, ...rest] }: { count: Number, tags: Array<String> }) =>
  first + " (+" + (count - 1) + ")"
`;
    const checked = await typeCheck(source, "nested-array-destructure.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { summarize } = await execute(source);
    expect(summarize({ count: 3, tags: ["urgent", "bug", "p0"] })).toBe(
      "urgent (+2)",
    );
  });
});
