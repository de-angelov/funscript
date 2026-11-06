import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { compile, execute, expectCompileError, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";

describe("optional fields in inline parameter records", () => {
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

  it("preserves formatting and rejects unsupported escapes rather than leaking raw undefined", async () => {
    const source = 'export read = (props: { label?: String, count: Number = 2 }) => props.label\n';
    expect(format(format(source))).toBe(format(source));
    expect((await compile(source)).typescript).toContain('readonly label?: string');
    await expectCompileError('export leak = (props: { label?: String }) => props', /cannot be passed, returned, aliased, or indexed/);
    await expectCompileError('export leak = (props: { label?: String }) => props["label"]', /cannot be passed, returned, aliased, or indexed/);
    await expectCompileError('export leak = (props: { label?: String }) =>\n  alias = props\n  => alias.label', /cannot be passed, returned, aliased, or indexed/);
    await expectCompileError('export x: { label?: String } = { label: "x" }', /only on direct function parameters/);
    await expectCompileError('export js f = (props: { label?: String }) => props.label', /not yet supported on js entry bindings/);
    await expectCompileError('export js f = (props: { label: String = "guest" }) => props.label', /not yet supported on js entry bindings/);
    await expectCompileError('export f = (props: { label: String = props.label }) => props.label', /cannot be passed, returned, aliased, or indexed/);
    await expectCompileError('export f = (prefix: String, props: { label: String = prefix }) => props.label', /cannot reference function parameters/);
    await expectCompileError('export f = (props: { nested: { label?: String } }) => props.nested', /only on direct function parameters/);
  });
});
