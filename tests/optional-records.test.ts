import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { compile, execute, expectCompileError, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import path from "node:path";

describe("optional fields in inline parameter records", () => {
  it("supports error fields in record literals and member access", async () => {
    const source = 'export response = { error: "bad" }\nexport read = () => response.error';
    const checked = await typeCheck(source, "record-error-value.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read()).toBe("bad");
  });

  it("accepts error as a record type field for JavaScript logger contracts", async () => {
    const source = 'export keep = (props: { logger?: { error: (message: String) => Void } }) => props.logger';
    const result = await typeCheck(source, "record-error-field.fun");
    expect(result.success, result.formattedOutput).toBe(true);
    expect((await compile(source)).typescript).toContain('readonly error: (message: string) => void');
  });

  it("exposes real Options inside while accepting ordinary JavaScript props", async () => {
    const source = 'export read = (props: { label?: String }) => props.label';
    const { read } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ label: undefined })).toEqual(Option.none());
    expect(read({ label: "hello" })).toEqual(Option.some("hello"));
    expect(read({ label: null })).toEqual(Option.some(null));
    const checked = await typeCheck(source + '\nexport a = read({})\nexport b = read({ label: "hi" })', "record-option.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("requires optional callbacks to be handled and retains their payload type", async () => {
    const source = 'export invoke = (props: { onVote?: (kind: String) => String }) =>\n  match props.onVote\n    | Some(callback) => callback("like")\n    | None => "missing"';
    const checked = await typeCheck(source, "record-callback.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(source.replace('callback("like")', 'callback(3)'), "record-callback.fun");
    expect(invalid.success).toBe(false);
    const unchecked = await typeCheck('export invoke = (props: { onVote?: (kind: String) => String }) => props.onVote("like")', "record-callback.fun");
    expect(unchecked.success).toBe(false);
    const { invoke } = await execute(source);
    expect(invoke({})).toBe("missing");
    expect(invoke({ onVote: (kind: string) => kind.toUpperCase() })).toBe("LIKE");
  });

  it("supports optional void callbacks without passing Option objects to JavaScript", async () => {
    const source = 'import { Option } from "effect"\nexport dispatch = (props: { onVote?: (kind: String) => Void }) =>\n  ignore = (kind: String) =>\n    => kind\n  callback = Option.getOrElse(props.onVote, () => ignore)\n  => callback("like")';
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
    const source = 'ts { declare function next(): number }\nexport sum = (props: { count: Number = next() }) => props.count + props.count';
    const { sum } = await execute(source, { scope: { next: () => ++calls } });
    expect(sum({ count: 0 })).toBe(0);
    expect(calls).toBe(0);
    expect(sum({})).toBe(2);
    expect(calls).toBe(1);
    let reads = 0;
    expect(sum({ get count() { reads++; return 4; } })).toBe(8);
    expect(reads).toBe(1);
    const { values } = await execute('export values = (props: { label: String = "fallback", flag: Boolean = true }) => [props.label, props.flag]');
    expect(values({ label: "", flag: false })).toEqual(["", false]);
    expect(values({ label: null, flag: false })).toEqual([null, false]);
  });

  it("allows explicit asynchronous JavaScript interop to receive the original props object", async () => {
    const source = 'ts { declare function send(value: unknown): Promise<string> }\nexport sendProps = (props: { label?: String }) => js send(props)';
    const compiled = await compile(source);
    expect(compiled.typescript).toContain('send(props)');
    const checked = await typeCheck(source, "record-js.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let received: unknown;
    const { sendProps } = await execute(source, { scope: { send: async (value: unknown) => { received = value; return "ok"; } } });
    const original = { label: "hello" };
    expect(await Effect.runPromise(sendProps(original))).toBe("ok");
    expect(received).toBe(original);
  });

  it("forwards unchanged optional records to a statically known FunScript function", async () => {
    const source = 'read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }) => read(props)';
    const checked = await typeCheck(source, "record-forward.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source);
    expect(forward({})).toEqual(Option.none());
    expect(forward({ label: "Ada" })).toEqual(Option.some("Ada"));
    await expectCompileError('read = (props: { label?: String }) => props.label\nexport forward = (props: { label: String = "x" }) => read(props)', /cannot be passed/);
    await expectCompileError('read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }, read: (value: Unknown) => Unknown) => read(props)', /cannot be passed/);
    await expectCompileError('read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }, value: Unknown) =>\n  match value\n    | read => read(props)', /cannot be passed/);
  });

  it("forwards raw records across verified FunScript module boundaries", async () => {
    const reader = 'export read = (props: { label?: String }) => props.label';
    const caller = 'import { read as inspect } from "./reader.js"\nexport forward = (props: { label?: String }) => inspect(props)';
    const checked = await Effect.runPromise(typeCheckVirtualFiles({ "reader.fun": reader, "caller.fun": caller }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(checked.success, checked.formattedOutput).toBe(true);
    const original = { label: "Ada" };
    let received: unknown;
    const { forward } = await execute(caller, { filename: "caller.fun", compileOptions: { virtualSources: new Map([[path.resolve("reader.fun"), reader]]) }, scope: { inspect: (value: unknown) => { received = value; return Option.some("ok"); } } });
    expect(forward(original)).toEqual(Option.some("ok"));
    expect(received).toBe(original);
    const withComparison = caller.replace('export forward = (props: { label?: String }) => inspect(props)', 'export forward = (props: { label?: String }, count: Number) =>\n  match count > 0\n    | true => inspect(props)\n    | false => inspect(props)');
    expect((await compile(withComparison, "caller.fun", { virtualSources: new Map([[path.resolve("reader.fun"), reader]]) })).typescript).toContain("inspect(props)");
    const incompatible = await Effect.runPromise(typeCheckVirtualFiles({ "reader.fun": 'export read = (props: { label?: Number }) => props.label', "caller.fun": caller }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(incompatible.success).toBe(false);
    const unchecked = await Effect.runPromise(typeCheckVirtualFiles({ "reader.fun": 'export read = (props: Unknown) => props', "caller.fun": caller }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(unchecked.success).toBe(false);
    expect(unchecked.diagnostics.some((d) => d.message.includes("cannot be passed"))).toBe(true);
    await expectCompileError('import { read } from "./missing.fun"\nexport forward = (props: { label?: String }) => read(props)', /cannot be passed/);
  });

  it("tracks verified default exports, namespace imports, and re-export aliases", async () => {
    const files = {
      "reader.fun": 'export read = (props: { label?: String }) => props.label\nexport default read',
      "direct.fun": 'export default (props: { label?: String }) => props.label',
      "barrel.fun": 'import { read as impl } from "./reader.js"\nexport read = impl',
      "caller.fun": 'import read from "./reader.js"\nimport direct from "./direct.js"\nimport * as api from "./barrel.js"\nexport first = (props: { label?: String }) => read(props)\nexport second = (props: { label?: String }) => api.read(props)\nexport third = (props: { label?: String }) => direct(props)',
    };
    const checked = await Effect.runPromise(typeCheckVirtualFiles(files, { compilerOptions: { rootDir: process.cwd() } }));
    expect(checked.success, checked.formattedOutput).toBe(true);
    let received: unknown;
    const observe = (value: unknown) => { received = value; return Option.none(); };
    const scope = { read: observe, direct: observe, api: { read: observe } };
    const virtualSources = new Map([[path.resolve("reader.fun"), files["reader.fun"]], [path.resolve("direct.fun"), files["direct.fun"]], [path.resolve("barrel.fun"), files["barrel.fun"]]]);
    const { first, second, third } = await execute(files["caller.fun"], { filename: "caller.fun", compileOptions: { virtualSources }, scope });
    const original = { label: "Ada" };
    first(original);
    expect(received).toBe(original);
    second(original);
    expect(received).toBe(original);
    third(original);
    expect(received).toBe(original);
    const cycle = await Effect.runPromise(typeCheckVirtualFiles({
      "first.fun": 'import { read as impl } from "./second.js"\nexport read = impl',
      "second.fun": 'import { read as impl } from "./first.js"\nexport read = impl',
      "caller.fun": 'import { read } from "./first.js"\nexport forward = (props: { label?: String }) => read(props)',
    }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(cycle.success).toBe(false);
    expect(cycle.diagnostics.some((d) => d.message.includes("cannot be passed"))).toBe(true);
    const shadowed = await Effect.runPromise(typeCheckVirtualFiles({
      "reader.fun": files["reader.fun"],
      "caller.fun": 'import * as api from "./reader.js"\nexport forward = (props: { label?: String }, api: { read: (value: Unknown) => Unknown }) => api.read(props)',
    }, { compilerOptions: { rootDir: process.cwd() } }));
    expect(shadowed.success).toBe(false);
    expect(shadowed.diagnostics.some((d) => d.message.includes("cannot be passed"))).toBe(true);
  });

  it("tracks immutable record aliases and rejects their unsafe escape", async () => {
    const source = 'read = (props: { label?: String }) => props.label\nexport forward = (props: { label?: String }) =>\n  alias = props\n  saved = alias\n  => read(saved)';
    const checked = await typeCheck(source, "record-alias.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { forward } = await execute(source);
    expect(forward({})).toEqual(Option.none());
    expect(forward({ label: "Ada" })).toEqual(Option.some("Ada"));
    const direct = await execute('export read = (props: { label?: String }) =>\n  alias = props\n  => alias.label');
    expect(direct.read({ label: "Ada" })).toEqual(Option.some("Ada"));
    await expectCompileError('export leak = (props: { label?: String }) =>\n  alias = props\n  => alias', /cannot be passed/);
    await expectCompileError('export leak = (props: { label: String = "x" }) =>\n  alias = props\n  => alias.label', /cannot be passed/);
  });

  it("handles optional fields inside required nested records without leaking them", async () => {
    const source = 'export read = (props: { nested: { label?: String } }) => props.nested.label';
    const checked = await typeCheck(source, "nested-option.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({ nested: {} })).toEqual(Option.none());
    expect(read({ nested: { label: "hello" } })).toEqual(Option.some("hello"));
    const forwarded = await execute('read = (props: { nested: { label?: String } }) => props.nested.label\nexport forward = (props: { nested: { label?: String } }) => read(props)');
    expect(forwarded.forward({ nested: { label: "hello" } })).toEqual(Option.some("hello"));
    const unsafe = await typeCheck('export read = (props: { nested: { label?: String } }) => props.nested.label.toUpperCase()', "nested-option.fun");
    expect(unsafe.success).toBe(false);
    await expectCompileError('export leak = (props: { nested: { label?: String } }) => props.nested', /nested record with optional fields/);
    await expectCompileError('export leak = (props: { nested: { label?: String } }) => props.nested["label"]', /nested record with optional fields/);
    await expectCompileError('export leak = (props: { nested?: { label?: String } }) => props.nested', /nested record with optional fields/);
    await expectCompileError('export leak = (props: { callback: (value: { label?: String }) => String }) => props.callback', /inside callbacks or container types/);
    await expectCompileError('export leak = (props: { values: Array<{ label?: String }> }) => props.values', /inside callbacks or container types/);
  });

  it("handles an optional parent record through an explicit Some match", async () => {
    const source = 'import { Option } from "effect"\nexport read = (props: { nested?: { label?: String } }) =>\n  match props.nested\n    | Some(nested) => nested.label\n    | None => Option.none()';
    const checked = await typeCheck(source, "optional-parent.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ nested: {} })).toEqual(Option.none());
    expect(read({ nested: { label: "Ada" } })).toEqual(Option.some("Ada"));
    const guarded = await typeCheck('export read = (props: { nested?: { label?: String } }) =>\n  match props.nested\n    | Some(nested) when nested.label.toUpperCase() => "yes"\n    | _ => "no"', "optional-parent-guard.fun");
    expect(guarded.success).toBe(false);
    await expectCompileError('export leak = (props: { nested?: { label?: String } }) =>\n  match props.nested\n    | Some(nested) => nested\n    | None => "none"', /cannot be passed/);
    await expectCompileError('export leak = (props: { nested?: { label?: String } }) => props.nested.label', /nested record with optional fields/);
  });

  it("preserves formatting and rejects unsupported escapes rather than leaking raw undefined", async () => {
    const source = 'export read = (props: { label?: String, count: Number = 2 }) => props.label\n';
    expect(format(format(source))).toBe(format(source));
    expect((await compile(source)).typescript).toContain('readonly label?: string');
    await expectCompileError('export leak = (props: { label?: String }) => props', /cannot be passed, returned, aliased, or indexed/);
    await expectCompileError('export leak = (props: { label?: String }) => props["label"]', /cannot be passed, returned, aliased, or indexed/);
    await expectCompileError('export x: { label?: String } = { label: "x" }', /only on direct function parameters/);
    await expectCompileError('export js f = (props: { label?: String }) => props.label', /not yet supported on js entry bindings/);
    await expectCompileError('export js f = (props: { label: String = "guest" }) => props.label', /not yet supported on js entry bindings/);
    await expectCompileError('export f = (props: { label: String = props.label }) => props.label', /cannot reference function parameters/);
    await expectCompileError('export f = (prefix: String, props: { label: String = prefix }) => props.label', /cannot reference function parameters/);
  });
});
