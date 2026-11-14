import { describe, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import { checkedSync, checkedSyncVoid, checkedEffect, decodeCheckedRecord } from "../src/interop/callback.js";
import { compile, execute, expectCompileError, typeCheck } from "./helpers/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

describe("named compile-time record contracts", () => {
  const declaration = 'schema Props = { label?: String, onChange?: (value: String) => Void }';

  it("keeps ordinary JavaScript props while requiring Options inside", async () => {
    const source = declaration + '\nexport read = (props: Props) => props.label\nexport callback = (props: Props) => props.onChange';
    const checked = await typeCheck(source + '\nexport missing = read({})\nexport present = read({ label: "Ada" })', "contract.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read, callback } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ label: "Ada" })).toEqual(Option.some("Ada"));
    const fn = () => {};
    expect(callback({ onChange: fn })).toEqual(Option.some(fn));
    expect((await typeCheck(source + '\nexport wrong = read({ label: 1 })', "contract.fun")).success).toBe(false);
    expect((await typeCheck(declaration + '\nexport read = (props: Props) => props.label.toUpperCase()', "contract.fun")).success).toBe(false);
  });

  it("forwards named contracts through verified JSX components", async () => {
    const source = declaration + '\nexport Target = (props: Props) => <div />\nexport Wrapper = (props: Props) => <Target {...props} />';
    const result = await compile(source, "contract.funx");
    expect(result.typescript).toContain("type Props =");
    expect(result.typescript).toContain("<Target {...props} />");
    expect(result.typescript).not.toContain("PropsFromUnknown");
  });

  it("generates an explicit checked decoder for supported synchronous callbacks", async () => {
    const source = 'export schema Action = { label: String, run: (value: String) => String }\nexport decode = (input: Unknown) => ActionDecodeChecked(input)';
    const checked = await typeCheck(source, "action.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { decode } = await execute(source, { filename: "action.fun", scope: { $funscriptCheckedSync: checkedSync, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const fn = (value: string) => value.toUpperCase();
    const action = decode({ label: "save", run: fn });
    expect(action.label).toBe("save");
    expect(action.run("ok")).toBe("OK");
    expect(action.run).not.toBe(fn);
    expect(() => decode({ label: 1, run: fn })).toThrow();
    expect(() => decode({ label: "save", run: 12 })).toThrow();
    expect(() => decode({ label: "save", run: () => 1 }).run("ok")).toThrow();
  }, 60000);

  it("decodes optional React-style callbacks without changing omission or requiring a void return", async () => {
    const source = 'export schema Props = { label?: String, onClick?: () => Void, onVote?: (country: String) => Void }\nexport decode = (input: Unknown) => PropsDecodeChecked(input)';
    const checked = await typeCheck(source, "props.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { decode } = await execute(source, { filename: "props.funx", scope: { $funscriptCheckedSync: checkedSync, $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptCheckedEffect: checkedEffect, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const missing = decode({});
    expect(Object.hasOwn(missing, "label")).toBe(false);
    expect(Object.hasOwn(missing, "onClick")).toBe(false);
    const explicit = decode({ label: undefined, onClick: undefined });
    expect(Object.hasOwn(explicit, "onClick")).toBe(true);
    expect(explicit.onClick).toBeUndefined();
    expect(Object.hasOwn(explicit, "label")).toBe(true);
    expect(() => decode({ onVote: null })).toThrow();
    expect(() => decode({ label: 1 })).toThrow();
    let count = 0;
    const props = decode({ onClick: () => { count++; return 123; }, onVote: (value: string) => { expect(value).toBe("BG"); return 9; } });
    expect(props.onVote("BG")).toBeUndefined();
    expect(() => props.onVote(42)).toThrow();
    const target = new EventTarget();
    const listener = props.onClick;
    target.addEventListener("vote", listener);
    target.dispatchEvent(new Event("vote"));
    target.removeEventListener("vote", listener);
    target.dispatchEvent(new Event("vote"));
    expect(count).toBe(1);
  }, 60000);

  it("checks nullary tagged unions in optional data and callbacks without replacing values", async () => {
    const source = `export schema RankingOrder =
  | HighestFirst
  | LowestFirst
export schema RankingOrderControlsProps = {
  order?: RankingOrder
  currentOrder?: RankingOrder
  onOrderChange?: (order: RankingOrder) => Void
}
export decode = (input: Unknown) => RankingOrderControlsPropsDecodeChecked(input)`;
    const checked = await typeCheck(source, "ranking.funx");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const compiled = await compile(source, "ranking.funx");
    expect(compiled.typescript).toContain("checkedSyncVoid as $funscriptCheckedSyncVoid");
    expect(compiled.typescript).not.toContain("checkedSync as $funscriptCheckedSync");
    expect(compiled.typescript).not.toContain("checkedEffect as $funscriptCheckedEffect");
    const { decode, LowestFirst } = await execute(source, { filename: "ranking.funx", scope: { $funscriptCheckedSync: checkedSync, $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptCheckedEffect: checkedEffect, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    let seen: unknown;
    const props = decode({ order: LowestFirst, onOrderChange: (value: unknown) => { seen = value; } });
    expect(props.order).toBe(LowestFirst);
    props.onOrderChange(LowestFirst);
    expect(seen).toBe(LowestFirst);
    expect(() => decode({ order: { _tag: "Invalid" } })).toThrow();
    expect(() => props.onOrderChange({ _tag: "Invalid" })).toThrow();
    expect(() => decode({ onOrderChange: 42 })).toThrow();
  }, 60000);

  it("validates primitive tagged-union payloads while retaining Data values", async () => {
    const source = `export schema VoteEvent =
  | Select(code: String)
  | Resize(size: Number, active: Boolean)
  | Clear
export schema Props = { event?: VoteEvent, onEvent?: (event: VoteEvent) => Void }
export decode = (input: Unknown) => PropsDecodeChecked(input)`;
    const checked = await typeCheck(source, "payload.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { decode, Select, Resize, Clear } = await execute(source, { filename: "payload.fun", scope: { $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const event = Select("BG");
    let received: unknown;
    const props = decode({ event, onEvent: (value: unknown) => { received = value; } });
    expect(props.event).toBe(event);
    props.onEvent(event);
    expect(received).toBe(event);
    expect(decode({ event: Clear }).event).toBe(Clear);
    const sized = Resize(2, true);
    expect(decode({ event: sized }).event).toBe(sized);
    expect(() => decode({ event: { _tag: "Select", code: 42 } })).toThrow();
    expect(() => decode({ event: { _tag: "Resize", size: 2 } })).toThrow();
    expect(() => props.onEvent({ _tag: "Resize", size: 2, active: "yes" })).toThrow();
    expect(() => props.onEvent({ _tag: "Unknown" })).toThrow();
    const unsupported = await compile('schema Payload = { x?: String }\nschema Event = | Selected(value: Payload)\nschema Props = { onEvent: (value: Event) => Void }', "unsupported.fun");
    expect(unsupported.typescript).not.toContain("PropsDecodeChecked");
  }, 60000);

  it("validates local record payloads without reconstructing nested Data", async () => {
    const source = `export schema VoteEvent =
  | Selected(country: Country)
  | Cleared
export schema Country = { code: String, likes: Number }
export schema Props = { event?: VoteEvent, onEvent?: (event: VoteEvent) => Void }
export decode = (input: Unknown) => PropsDecodeChecked(input)`;
    const checked = await typeCheck(source, "nested.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { decode, Selected } = await execute(source, { filename: "nested.fun", scope: { $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const country = { code: "BG", likes: 2 };
    const event = Selected(country);
    let seen: unknown;
    const props = decode({ event, onEvent: (value: unknown) => { seen = value; } });
    expect(props.event).toBe(event);
    expect(props.event.country).toBe(country);
    props.onEvent(event);
    expect(seen).toBe(event);
    expect(() => decode({ event: { _tag: "Selected", country: { code: "BG", likes: "bad" } } })).toThrow();
    expect(() => props.onEvent({ _tag: "Selected", country: { code: 1, likes: 1 } })).toThrow();
  }, 60000);

  it("checks record payloads returned from Effect callbacks", async () => {
    const source = `import { Effect } from "effect"
export schema Country = { code: String }
export schema VoteEvent =
  | Selected(country: Country)
  | Cleared
export schema Handler = { run: (event: VoteEvent) => Effect<VoteEvent, String> }
export decode = (input: Handler) => HandlerDecodeChecked(input)`;
    const checked = await typeCheck(source, "nested-effect.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { decode, Selected } = await execute(source, { filename: "nested-effect.fun", scope: { $funscriptCheckedEffect: checkedEffect, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const country = { code: "BG" };
    const event = Selected(country);
    const handler = decode({ run: () => Effect.succeed(event) });
    expect(await Effect.runPromise(handler.run(event))).toBe(event);
    const invalid = decode({ run: () => Effect.succeed({ _tag: "Selected", country: { code: 1 } }) });
    const outcome = await Effect.runPromise(Effect.result(invalid.run(event)));
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "CallbackBoundaryError", stage: "result" } });
  }, 60000);

  it("validates tagged payloads on both sides of an Effect callback", async () => {
    const source = `import { Effect } from "effect"
export schema Event =
  | Selected(code: String)
  | Reset
export schema Handler = { run: (event: Event) => Effect<Event, String> }
export decode = (input: Handler) => HandlerDecodeChecked(input)`;
    const checked = await typeCheck(source, "event-effect.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { decode, Selected } = await execute(source, { filename: "event-effect.fun", scope: { $funscriptCheckedEffect: checkedEffect, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const event = Selected("BG");
    const handler = decode({ run: (value: unknown) => Effect.succeed(value) });
    expect(await Effect.runPromise(handler.run(event))).toBe(event);
    const invalid = decode({ run: () => Effect.succeed({ _tag: "Selected", code: 1 }) });
    const outcome = await Effect.runPromise(Effect.result(invalid.run(event)));
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "CallbackBoundaryError", stage: "result" } });
  }, 60000);

  it("uses a directly imported value schema only when its encoding is verified", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-import-codec-"));
    try {
      await mkdir(path.join(root, "node_modules"), { recursive: true });
      await symlink(path.resolve("node_modules/effect"), path.join(root, "node_modules/effect"), "dir");
      await symlink(process.cwd(), path.join(root, "node_modules/funscript"), "dir");
      await writeFile(path.join(root, "country.fun"), 'export schema Country = { code: String, likes: Number }');
      const source = 'import { Country as Nation } from "./country.js"\nexport schema Props = { onVote: (country: Nation) => Void }\nexport decode = (input: Unknown) => PropsDecodeChecked(input)';
      const files = { "country.fun": 'export schema Country = { code: String, likes: Number }', "props.fun": source };
      const checked = await Effect.runPromise(typeCheckVirtualFiles(files, { cwd: root, compilerOptions: { rootDir: root } }));
      expect(checked.success, checked.formattedOutput).toBe(true);
      const compiled = await compile(source, path.join(root, "props.fun"));
      expect(compiled.typescript).toContain("PropsDecodeChecked");
      expect(compiled.typescript).toContain("Schema.Tuple([Nation])");
      const { decode } = await execute(source, { filename: path.join(root, "props.fun"), scope: { Nation: Schema.Struct({ code: Schema.String, likes: Schema.Number }), $funscriptCheckedSync: checkedSync, $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptCheckedEffect: checkedEffect, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
      let seen: unknown;
      const props = decode({ onVote: (value: unknown) => { seen = value; } });
      props.onVote({ code: "BG", likes: 2 });
      expect(seen).toEqual({ code: "BG", likes: 2 });
      expect(() => props.onVote({ code: "BG", likes: "bad" })).toThrow();
      const typeOnly = await compile('import type { Country } from "./country.js"\nexport schema Props = { onVote: (country: Country) => Void }', path.join(root, "props.fun"));
      expect(typeOnly.typescript).not.toContain("PropsDecodeChecked");
      await writeFile(path.join(root, "country.ts"), 'export type Country = { code: string }');
      const ambiguous = await compile(source, path.join(root, "props.fun"));
      expect(ambiguous.typescript).not.toContain("export const PropsDecodeChecked");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  it("checks directly imported record payloads in tagged callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-import-payload-"));
    try {
      await mkdir(path.join(root, "node_modules"), { recursive: true });
      await symlink(path.resolve("node_modules/effect"), path.join(root, "node_modules/effect"), "dir");
      await symlink(process.cwd(), path.join(root, "node_modules/funscript"), "dir");
      const country = 'export schema Country = { code: String, likes: Number }';
      await writeFile(path.join(root, "country.fun"), country);
      const source = `import { Country as Nation } from "./country.js"
export schema VoteEvent =
  | Selected(country: Nation)
  | Cleared
export schema Props = { event?: VoteEvent, onEvent?: (event: VoteEvent) => Void }
export decode = (input: Unknown) => PropsDecodeChecked(input)`;
      const checked = await Effect.runPromise(typeCheckVirtualFiles({ "country.fun": country, "events.fun": source }, { cwd: root, compilerOptions: { rootDir: root } }));
      expect(checked.success, checked.formattedOutput).toBe(true);
      const { decode, Selected } = await execute(source, { filename: path.join(root, "events.fun"), scope: { Nation: Schema.Struct({ code: Schema.String, likes: Schema.Number }), $funscriptCheckedSyncVoid: checkedSyncVoid, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
      const data = { code: "BG", likes: 2 };
      const event = Selected(data);
      let seen: unknown;
      const props = decode({ event, onEvent: (value: unknown) => { seen = value; } });
      props.onEvent(event);
      expect(props.event).toBe(event);
      expect(props.event.country).toBe(data);
      expect(seen).toBe(event);
      expect(() => props.onEvent({ _tag: "Selected", country: { code: "BG", likes: "bad" } })).toThrow();
      expect(() => decode({ event: { _tag: "Selected", country: { code: 2, likes: 1 } } })).toThrow();
      const typeOnly = source.replace('import { Country as Nation }', 'import type { Country as Nation }');
      expect((await compile(typeOnly, path.join(root, "events.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
      await writeFile(path.join(root, "country.ts"), 'export type Country = { code: string }');
      expect((await compile(source, path.join(root, "events.fun"))).typescript).not.toContain("export const PropsDecodeChecked");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  it("does not replace user decoders or generate unsupported signatures", async () => {
    const owned = await compile('schema Action = { run: (value: String) => String }\nexport ActionDecodeChecked = (value: String) => value', "action.fun");
    expect(owned.typescript).not.toContain("$funscriptDecodeCheckedRecord");
    const unsupported = await compile('schema Service = { run?: (value: String) => Effect<String, String> }', "service.fun");
    expect(unsupported.typescript).not.toContain("ServiceDecodeChecked");
    const failure = await typeCheck('schema Service = { run?: (value: String) => Effect<String, String> }\nexport decode = (input: Unknown) => ServiceDecodeChecked(input)', "service.fun");
    expect(failure.formattedOutput).toContain("has no generated checked decoder for this signature");
  });

  it("generates a typed Effect boundary with a widened failure channel", async () => {
    const source = `import { Effect } from "effect"
export schema Request = { code: String }
export schema Reply = { count: Number }
export schema Failure = { code: String }
export schema Handler = { submit: (request: Request) => Effect<Reply, Failure> }
export decode = (input: Handler) => HandlerDecodeChecked(input)`;
    const checked = await typeCheck(source, "handler.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const unsafe = await typeCheck(source + '\nexport unsafe = (input: Handler): Handler => HandlerDecodeChecked(input)', "handler.fun");
    expect(unsafe.success).toBe(false);
    const untrusted = await typeCheck(source + '\nexport decodeUnknown = (input: Unknown) => HandlerDecodeChecked(input)', "handler.fun");
    expect(untrusted.success).toBe(false);
    const { decode } = await execute(source, { filename: "handler.fun", scope: { $funscriptCheckedSync: checkedSync, $funscriptCheckedEffect: checkedEffect, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    let calls = 0;
    const handler = decode({ submit: () => { calls++; return Effect.succeed({ count: 4 }); } });
    const pending = handler.submit({ code: "BG" });
    expect(calls).toBe(0);
    expect(await Effect.runPromise(pending)).toEqual({ count: 4 });
    expect(calls).toBe(1);
    const invalid = decode({ submit: () => Effect.succeed({ count: "bad" }) });
    const invalidResult = await Effect.runPromise(Effect.result(invalid.submit({ code: "BG" })));
    expect(invalidResult).toMatchObject({ _tag: "Failure", failure: { _tag: "CallbackBoundaryError", stage: "result" } });
    const domain = { code: "storage_failed" };
    const fails = decode({ submit: () => Effect.fail(domain) });
    expect(await Effect.runPromise(Effect.result(fails.submit({ code: "BG" })))).toMatchObject({ _tag: "Failure", failure: domain });
  }, 60000);

  it("preserves declared Effect service requirements in the checked type", async () => {
    const output = await compile('export schema Worker = { run: (value: String) => Effect<String, String, Boolean> }', "worker.fun");
    expect(output.typescript).toContain('string | $funscriptCallbackBoundaryError, boolean');
  });

  it("exports the checked decoder across FunScript modules", async () => {
    const files = {
      "action.fun": 'export schema Action = { label: String, run: (value: String) => String }',
      "caller.fun": 'import { ActionDecodeChecked } from "./action.js"\nexport decode = (input: Unknown) => ActionDecodeChecked(input)',
    };
    const checked = await Effect.runPromise(typeCheckVirtualFiles(files, { compilerOptions: { rootDir: process.cwd() } }));
    expect(checked.success, checked.formattedOutput).toBe(true);
  }, 60000);

  it("checks callback signatures for TypeScript callers", async () => {
    const good = await typeCheck(declaration + '\nts { const props: Props = { onChange: (value: string) => {} }; }', "contract.fun");
    expect(good.success, good.formattedOutput).toBe(true);
    const bad = await typeCheck(declaration + '\nts { const props: Props = { onChange: (value: number) => {} }; }', "contract.fun");
    expect(bad.success).toBe(false);
  });

  it("resolves type-only imports and forwards contracts across modules", async () => {
    const files = {
      "props.fun": 'export ' + declaration,
      "target.funx": 'import type { Props } from "./props.js"\nexport Target = (props: Props) => <div />',
      "wrapper.funx": 'import type { Props } from "./props.js"\nimport { Target } from "./target.js"\nexport Wrapper = (props: Props) => <Target {...props} />',
    };
    const result = await Effect.runPromise(typeCheckVirtualFiles(files, { compilerOptions: { rootDir: process.cwd() } }));
    expect(result.success, result.formattedOutput).toBe(true);
  });

  it("recovers optional field semantics from an emitted TypeScript package", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-contract-package-"));
    try {
      const modules = path.join(root, "node_modules");
      await mkdir(path.join(modules, "props-pkg"), { recursive: true });
      await symlink(path.resolve("node_modules/effect"), path.join(modules, "effect"), "dir");
      const compiled = await compile('export ' + declaration, "props.fun");
      const emitted = ts.transpileDeclaration(compiled.typescript, { compilerOptions: { declaration: true, emitDeclarationOnly: true } });
      expect(emitted.outputText).toContain("$funscriptRecordContract");
      await writeFile(path.join(modules, "props-pkg/package.json"), '{"name":"props-pkg","types":"index.d.ts"}');
      await writeFile(path.join(modules, "props-pkg/index.d.ts"), emitted.outputText);
      const source = 'import type { Props } from "props-pkg"\nexport read = (props: Props) => props.label';
      const { read } = await execute(source, { filename: path.join(root, "caller.fun") });
      expect(read({})).toEqual(Option.none());
      expect(read({ label: "Ada" })).toEqual(Option.some("Ada"));
      const checked = await Effect.runPromise(typeCheckVirtualFiles({ "caller.fun": source }, { cwd: root, compilerOptions: { rootDir: root, types: [] } }));
      expect(checked.success, checked.formattedOutput).toBe(true);
      const unsafe = await Effect.runPromise(typeCheckVirtualFiles({ "caller.fun": source + '.toUpperCase()' }, { cwd: root, compilerOptions: { rootDir: root, types: [] } }));
      expect(unsafe.success).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects runtime decoding and unsafe uses of static contracts", async () => {
    const missingDecoder = await typeCheck(declaration + '\nexport decode = (value: Unknown) => PropsFromUnknown(value)', "contract.fun");
    expect(missingDecoder.success).toBe(false);
    expect(missingDecoder.formattedOutput).toContain("compile-time record contract and has no generated FromUnknown decoder");
    await expectCompileError(declaration + '\nexport read = (value: SchemaInput<Props>) => value', /no encoded schema input type/);
    const shadowed = await typeCheck(declaration + '\nexport read = (PropsFromUnknown: (value: String) => String) => PropsFromUnknown("ok")', "contract.fun");
    expect(shadowed.success, shadowed.formattedOutput).toBe(true);
    await expectCompileError(declaration + '\nexport value = Props', /compile-time record contract/);
    await expectCompileError(declaration + '\nexport js entry = (props: Props) => props.label', /not supported on js entry/);
  });
});
